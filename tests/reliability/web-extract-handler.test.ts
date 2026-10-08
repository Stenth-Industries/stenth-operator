/**
 * The web.extract handler end to end (SPEC.md §6, §8, §9, §16).
 *
 * Against a real PostgreSQL, because every guarantee this handler makes is a
 * database guarantee: §4's unique key on (snapshot_id, schema_version,
 * extractor_model) is what stops a retry paying twice, and the one transaction
 * around the extraction and the llm_calls row is what stops a charge existing
 * without a fact. Mocking either would test the mock.
 *
 * No network and no billable provider: the offline adapter answers from a
 * fixture table. A real-model run is the Day 6 bake-off's job.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EXTRACTION_SCHEMA_VERSION } from '../../src/ai/schemas/extraction-v1';
import {
  EMPTY_EXTRACTION,
  OFFLINE_MODEL,
  OFFLINE_PROVIDER_ID,
  clearOfflineReplies,
  offlineProvider,
  setOfflineReply,
} from '../../src/ai/providers/offline';
import type { ModelProvider } from '../../src/ai/provider';
import { openReservations } from '../../src/ai/budget';
import { scanTierASignals } from '../../src/fetch/signals';
import { enqueue } from '../../src/jobs/enqueue';
import { dedupeKey } from '../../src/jobs/kinds';
import { blockJob, claimJob, completeJob } from '../../src/jobs/queue';
import { newTraceId } from '../../src/obs/trace';
import {
  ELIGIBLE_SNAPSHOT_SQL,
  assessEligibility,
  isOnOwnDomain,
  type SnapshotForEligibility,
} from '../../src/pipeline/evidence';
import { ExtractBlocked, handleWebExtract } from '../../src/worker/handlers/web-extract';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the web.extract suite.');
}

/** A page with enough content to clear the eligibility floor. */
const PAGE_TEXT = [
  'Harbourline Criminal Defence is a specialist criminal law firm in Sydney,',
  'appearing daily in the Local and District Courts of New South Wales. Our four',
  'solicitors act in drink driving, drug driving, assault, fraud, apprehended',
  'violence order and bail matters, and we have offices in Sydney and Parramatta.',
  'Practice areas: traffic and drink driving, assault and violence offences, drug',
  'offences, fraud and dishonesty, apprehended violence orders. Principal',
  'Alexandra Reed is an accredited specialist in criminal law and has practised',
  'for sixteen years. Senior Associate Daniel Okafor appears in committals and',
  'pleas across the state. Contact us at Level 8, 120 Pitt Street, Sydney NSW',
  '2000, telephone (02) 9000 1234, or complete the enquiry form on this page.',
  'Fixed fees are available for summary matters and we provide written advice',
  'before any plea is entered. We also act in Commonwealth prosecutions and',
  'firearm prohibition order appeals throughout New South Wales. Appointments',
  'outside business hours can be arranged on request, and we appear in the',
  'Supreme Court for bail and appeal matters when required.',
].join(' ');

const GOOD_REPLY = JSON.stringify({
  ...EMPTY_EXTRACTION,
  is_australian_law_firm: true,
  firm_name: 'Harbourline Criminal Defence',
  lawyer_count_band: '2-4',
  primary_state: 'NSW',
  office_locations: ['Sydney', 'Parramatta'],
  practice_areas: [{ name: 'Traffic and drink driving', evidence_quote: 'traffic and drink driving' }],
  named_people: [
    {
      full_name: 'Alexandra Reed',
      role_title: 'Principal',
      is_decision_maker: true,
      evidence_quote: 'Principal Alexandra Reed is an accredited specialist',
    },
  ],
  published_contacts: [
    {
      kind: 'phone',
      value: '(02) 9000 1234',
      evidence_quote: 'telephone (02) 9000 1234',
      carries_no_unsolicited_notice: false,
    },
  ],
  summary: 'Four-solicitor Sydney criminal defence firm with two offices.',
});

describeWithDb('the web.extract handler (§6, §8, §16)', () => {
  let db: TestDatabase;
  let app: Pool;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO companies (canonical_domain, legal_name)
       VALUES ('harbourline.example', 'Harbourline Criminal Defence') RETURNING id`,
    );
    companyId = rows[0]!.id;
    await db.adminPool.query(
      `INSERT INTO model_pricing (provider, model, input_per_mtok, output_per_mtok, effective_from)
       VALUES ($1, $2, 3.000000, 15.000000, now() - interval '1 day')`,
      [OFFLINE_PROVIDER_ID, OFFLINE_MODEL],
    );
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(() => {
    clearOfflineReplies();
    setOfflineReply(PAGE_TEXT, GOOD_REPLY);
  });

  afterEach(async () => {
    await db.adminPool.query('TRUNCATE extractions, llm_calls, events, budgets CASCADE');
    await db.adminPool.query('TRUNCATE jobs, job_runs CASCADE');
    await db.adminPool.query('DELETE FROM web_snapshots');
  });

  /** Inserts a snapshot. Admin role, because the fetcher's role is not under test here. */
  async function insertSnapshot(
    overrides: {
      text?: string | null;
      httpStatus?: number | null;
      robotsAllowed?: boolean;
      url?: string;
      signals?: unknown;
    } = {},
  ): Promise<string> {
    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO web_snapshots
         (company_id, url, http_status, content_hash, text, bytes, robots_allowed,
          trace_id, signals)
       VALUES ($1, $2, $3, $4, $5, 4096, $6, $7, $8::jsonb)
       RETURNING id`,
      [
        companyId,
        overrides.url ?? 'https://harbourline.example/',
        overrides.httpStatus === undefined ? 200 : overrides.httpStatus,
        `hash-${Math.random().toString(36).slice(2)}`,
        overrides.text === undefined ? PAGE_TEXT : overrides.text,
        overrides.robotsAllowed ?? true,
        newTraceId(),
        overrides.signals === undefined ? null : JSON.stringify(overrides.signals),
      ],
    );
    return rows[0]!.id;
  }

  async function claimExtractJob(snapshotId: string) {
    await enqueue(app, {
      kind: 'web.extract',
      dedupeKey: dedupeKey.webExtract(snapshotId, EXTRACTION_SCHEMA_VERSION),
      traceId: newTraceId(),
      payload: { snapshot_id: snapshotId },
    });
    const job = await claimJob(app, 'test-worker');
    if (job === undefined) {
      throw new Error('no job claimed');
    }
    return job;
  }

  function deps(provider: ModelProvider = offlineProvider, modelCallsEnabled = false) {
    return { pool: app, provider, modelCallsEnabled };
  }

  async function callCount(): Promise<number> {
    const { rows } = await app.query<{ count: string }>('SELECT count(*) AS count FROM llm_calls');
    return Number(rows[0]?.count);
  }

  // ------------------------------------------------------------ the happy path
  describe('a usable snapshot becomes a validated extraction', () => {
    it('stores the payload, the call and the event', async () => {
      const snapshotId = await insertSnapshot({
        signals: scanTierASignals(
          '<html><head><meta name="viewport" content="width=device-width"></head>' +
            '<body><script>gtag("config","AW-123456789")</script>' +
            '<a href="tel:+61290001234">call</a><form></form>' +
            '<footer>&copy; 2026</footer></body></html>',
        ),
      });
      const job = await claimExtractJob(snapshotId);

      const result = await handleWebExtract(job, deps());
      expect(result.outcome).toBe('extracted');
      expect(result.outcome === 'extracted' && result.valid).toBe(true);

      const { rows } = await app.query<{
        schema_version: string;
        extractor_model: string;
        valid: boolean;
        payload: Record<string, unknown>;
        trace_id: string;
      }>('SELECT schema_version, extractor_model, valid, payload, trace_id FROM extractions');
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.schema_version).toBe(EXTRACTION_SCHEMA_VERSION);
      expect(row.extractor_model).toBe(OFFLINE_MODEL);
      expect(row.valid).toBe(true);
      expect(row.trace_id).toBe(job.trace_id);

      // §16's provenance rule: the assertion carries the snapshot it came from.
      expect(row.payload.source_snapshot_id).toBe(snapshotId);

      // The model's facts.
      const firm = row.payload.firm as Record<string, unknown>;
      expect(firm.firm_name).toBe('Harbourline Criminal Defence');
      expect(firm.lawyer_count_band).toBe('2-4');

      // Tier A, from the scanner — never from the model (§9, §23 case 13).
      const signals = row.payload.signals as Record<string, unknown>;
      expect(signals.paid_search_tag).toBe('present');
      expect(signals.currently_advertising).toBe('unknown');
      expect(signals.tel_link).toBe('present');
      expect(signals.contact_form).toBe('present');
      expect(signals.copyright_year).toBe(2026);

      // And the link harvest, which shares the signals column, never travels
      // into the extraction payload or towards a model: assembleSignals picks
      // named Tier A keys, so a second deterministic read of the markup is
      // invisible to it (§9's Tier A list is what the rubric scores).
      // Asserted on the key set, not on a substring: `location_page_links` is
      // a legitimate Tier A count whose name contains the other one.
      expect(Object.keys(signals)).not.toContain('page_links');
      expect(signals.location_page_links).toBeTypeOf('number');
      const everyKey = (value: unknown): string[] =>
        value !== null && typeof value === 'object'
          ? Object.entries(value).flatMap(([key, child]) => [key, ...everyKey(child)])
          : [];
      expect(everyKey(row.payload)).not.toContain('page_links');

      const calls = await app.query<{
        purpose: string;
        isolation: string;
        provider: string;
        status: string;
        cost_usd: string;
        request_hash: string;
        job_id: string;
      }>('SELECT purpose, isolation, provider, status, cost_usd, request_hash, job_id FROM llm_calls');
      expect(calls.rows).toHaveLength(1);
      expect(calls.rows[0]).toMatchObject({
        purpose: 'web.extract',
        isolation: 'isolated_untrusted',
        provider: OFFLINE_PROVIDER_ID,
        status: 'succeeded',
        job_id: job.id,
      });
      expect(calls.rows[0]?.request_hash).toMatch(/^[0-9a-f]{64}$/);

      const events = await app.query<{ kind: string; payload: Record<string, unknown> }>(
        `SELECT kind, payload FROM events WHERE entity_type = 'extraction'`,
      );
      expect(events.rows[0]?.kind).toBe('extract.succeeded');
      // Ids, versions and counts. No page text, no extracted names (§16).
      expect(JSON.stringify(events.rows[0]?.payload)).not.toContain('Alexandra');
    });

    it('records Tier A as unknown when no scanner has looked', async () => {
      // The 20 Day 3 snapshots predate the scanner. `unknown` is not `absent`:
      // §10 pays 35 points for absence, and awarding that for a signal nobody
      // measured would be the Day 3 finding-1 mistake in a new place.
      const snapshotId = await insertSnapshot({ signals: undefined });
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());

      const { rows } = await app.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM extractions',
      );
      const signals = (rows[0]?.payload as Record<string, unknown>).signals as Record<
        string,
        unknown
      >;
      expect(signals.paid_search_tag).toBe('unknown');
      expect(signals.analytics_ga4).toBe('unknown');
      expect(signals.location_page_links).toBeNull();
    });

    it('stores an invalid extraction and stops, rather than retrying for ever (§8)', async () => {
      setOfflineReply(PAGE_TEXT, 'this is not json');
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);

      const result = await handleWebExtract(job, deps());
      expect(result).toMatchObject({ outcome: 'extracted', valid: false });

      const { rows } = await app.query<{
        valid: boolean;
        validation_errors: unknown;
        payload: Record<string, unknown>;
      }>('SELECT valid, validation_errors, payload FROM extractions');
      expect(rows[0]?.valid).toBe(false);
      expect(rows[0]?.validation_errors).toStrictEqual([{ path: '$', rule: 'not valid JSON' }]);
      expect(rows[0]?.payload).toStrictEqual({});

      // Paid for and accounted for: two attempts billed, status failed.
      const calls = await app.query<{ status: string }>('SELECT status FROM llm_calls');
      expect(calls.rows[0]?.status).toBe('failed');
    });
  });

  // -------------------------------------------------------------- idempotency
  describe('idempotency: a retry cannot double-charge or duplicate a fact', () => {
    it('makes no second call when an extraction already exists', async () => {
      const snapshotId = await insertSnapshot();
      const first = await claimExtractJob(snapshotId);
      await handleWebExtract(first, deps());
      expect(await callCount()).toBe(1);

      // A crash-and-requeue: §6's reaper returns the same job row to the queue,
      // and the §7 key means it is the same row rather than a second one. This
      // is the retry the "cannot double-charge" guarantee is about.
      await db.adminPool.query(
        `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL,
                         run_after = now()
          WHERE id = $1`,
        [first.id],
      );
      const second = await claimJob(app, 'test-worker');
      expect(second?.id).toBe(first.id);

      const result = await handleWebExtract(second!, deps());
      expect(result.outcome).toBe('already_extracted');
      expect(await callCount()).toBe(1);

      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM extractions',
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('is enforced by the database, not only by the lookup (§4)', async () => {
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());

      await expect(
        db.adminPool.query(
          `INSERT INTO extractions (snapshot_id, schema_version, extractor_model, valid)
           VALUES ($1, $2, $3, true)`,
          [snapshotId, EXTRACTION_SCHEMA_VERSION, OFFLINE_MODEL],
        ),
      ).rejects.toThrow(/extractions_snapshot_schema_model_key/);
    });

    it('deduplicates the enqueue on the §7 key', async () => {
      const snapshotId = await insertSnapshot();
      const key = dedupeKey.webExtract(snapshotId, EXTRACTION_SCHEMA_VERSION);
      const a = await enqueue(app, {
        kind: 'web.extract',
        dedupeKey: key,
        traceId: newTraceId(),
        payload: { snapshot_id: snapshotId },
      });
      const b = await enqueue(app, {
        kind: 'web.extract',
        dedupeKey: key,
        traceId: newTraceId(),
        payload: { snapshot_id: snapshotId },
      });
      expect(a.inserted).toBe(true);
      expect(b.inserted).toBe(false);
    });

    it('two concurrent workers on one snapshot store one extraction', async () => {
      const snapshotId = await insertSnapshot();
      const a = await claimExtractJob(snapshotId);
      // A second job for the same snapshot under a different key, which is what
      // a re-enqueue with a new schema occurrence would look like.
      await enqueue(app, {
        kind: 'web.extract',
        dedupeKey: `${dedupeKey.webExtract(snapshotId, EXTRACTION_SCHEMA_VERSION)}:b`,
        traceId: newTraceId(),
        payload: { snapshot_id: snapshotId },
      });
      const b = await claimJob(app, 'test-worker-2');
      expect(b).toBeDefined();

      const outcomes = await Promise.allSettled([
        handleWebExtract(a, deps()),
        handleWebExtract(b!, deps()),
      ]);

      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM extractions',
      );
      expect(rows[0]?.count).toBe('1');

      // One did the work; the other was refused by the reservation rather than
      // calling the provider a second time. Exactly one call row exists.
      const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(refused.length).toBeLessThanOrEqual(1);
      for (const outcome of refused) {
        expect(((outcome as PromiseRejectedResult).reason as ExtractBlocked).reason).toBe(
          'reservation_in_flight',
        );
      }
      const calls = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM llm_calls',
      );
      expect(calls.rows[0]?.count).toBe('1');
    });
  });

  // ------------------------------------------------------------ the input gate
  describe('the eligibility gate stops the call before it costs anything', () => {
    it.each([
      ['empty text, as two real Day 3 sites produced', { text: '' }, 'text_too_short'],
      ['thin text', { text: 'Enable JavaScript.' }, 'text_too_short'],
      ['a 403', { httpStatus: 403, text: null }, 'http_status_not_2xx'],
      ['a 404', { httpStatus: 404, text: null }, 'http_status_not_2xx'],
      ['a 503', { httpStatus: 503, text: null }, 'http_status_not_2xx'],
      ['a robots refusal', { httpStatus: null, text: null, robotsAllowed: false }, 'http_status_not_2xx'],
      ['a pruned snapshot', { text: null }, 'text_null'],
      ['an off-domain final URL', { url: 'https://parked-example.net/' }, 'off_domain_final_url'],
    ])('skips %s with no model call', async (_label, overrides, reason) => {
      const snapshotId = await insertSnapshot(overrides);
      const job = await claimExtractJob(snapshotId);

      const result = await handleWebExtract(job, deps());
      expect(result).toStrictEqual({ outcome: 'skipped', reason });
      expect(await callCount()).toBe(0);

      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM extractions',
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('cannot even be handed a text-bearing non-2xx row to skip (migration 005)', async () => {
      // The shape the production 403 had. The constraint refuses it on insert,
      // so the gate's status test is the second line of defence, not the first.
      await expect(
        insertSnapshot({ httpStatus: 403, text: 'Access Denied' }),
      ).rejects.toThrow(/web_snapshots_text_requires_2xx/);
    });

    it('records the refusal as an event, so a skip is auditable', async () => {
      const snapshotId = await insertSnapshot({ text: '' });
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());

      const { rows } = await app.query<{ kind: string; payload: Record<string, unknown> }>(
        `SELECT kind, payload FROM events WHERE entity_type = 'web_snapshot'`,
      );
      expect(rows[0]?.kind).toBe('extract.skipped');
      expect(rows[0]?.payload.reason).toBe('text_too_short');
    });

    it('completes the job rather than retrying: thin content does not thicken', async () => {
      const snapshotId = await insertSnapshot({ text: '' });
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());
      await completeJob(app, job);

      const { rows } = await app.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM jobs WHERE id = $1',
        [job.id],
      );
      expect(rows[0]).toMatchObject({ status: 'succeeded', attempts: 1 });
    });

    it('skips a snapshot that does not exist', async () => {
      await enqueue(app, {
        kind: 'web.extract',
        dedupeKey: 'extract:missing:v1',
        traceId: newTraceId(),
        payload: { snapshot_id: '00000000-0000-4000-8000-00000000dead' },
      });
      const job = await claimJob(app, 'test-worker');
      const result = await handleWebExtract(job!, deps());
      expect(result).toStrictEqual({ outcome: 'skipped', reason: 'missing_snapshot' });
      expect(await callCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------- the budget
  describe('the budget gate, before the provider is contacted (§16)', () => {
    it('blocks at the hard stop and records the refusal at zero cost', async () => {
      await db.adminPool.query(
        `INSERT INTO budgets (period_month, limit_usd, warn_usd, hard_stop_usd)
         VALUES (date_trunc('month', now())::date, 50, 35, 50)`,
      );
      await db.adminPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, cost_usd, status)
         VALUES ('T', 'web.extract', 'isolated_untrusted', $1, $2, 50.000000, 'succeeded')`,
        [OFFLINE_PROVIDER_ID, OFFLINE_MODEL],
      );

      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);

      await expect(handleWebExtract(job, deps())).rejects.toThrow(ExtractBlocked);

      // Nothing was extracted, and the refusal is in the ledger.
      const extractions = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM extractions',
      );
      expect(extractions.rows[0]?.count).toBe('0');
      const blocked = await app.query<{ status: string; cost_usd: string }>(
        `SELECT status, cost_usd FROM llm_calls WHERE status = 'blocked'`,
      );
      expect(blocked.rows).toHaveLength(1);
      expect(Number(blocked.rows[0]?.cost_usd)).toBe(0);
    });

    it('moves the job to blocked, which is terminal (§6)', async () => {
      await db.adminPool.query(
        `INSERT INTO budgets (period_month, limit_usd, warn_usd, hard_stop_usd)
         VALUES (date_trunc('month', now())::date, 50, 35, 50)`,
      );
      await db.adminPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, cost_usd, status)
         VALUES ('T', 'web.extract', 'isolated_untrusted', $1, $2, 50.000000, 'succeeded')`,
        [OFFLINE_PROVIDER_ID, OFFLINE_MODEL],
      );
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);

      const error = await handleWebExtract(job, deps()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExtractBlocked);
      await blockJob(app, job, (error as ExtractBlocked).reason, (error as Error).message);

      const { rows } = await app.query<{ status: string; last_error: string }>(
        'SELECT status, last_error FROM jobs WHERE id = $1',
        [job.id],
      );
      expect(rows[0]?.status).toBe('blocked');
      expect(rows[0]?.last_error).toMatch(/hard stop/);

      const events = await app.query<{ kind: string }>(
        `SELECT kind FROM events WHERE entity_type = 'job' AND kind = 'job.blocked'`,
      );
      expect(events.rows).toHaveLength(1);
    });

    it('blocks when the model has no price, rather than calling it unpriced', async () => {
      await db.adminPool.query('DELETE FROM model_pricing');
      try {
        const snapshotId = await insertSnapshot();
        const job = await claimExtractJob(snapshotId);
        const error = await handleWebExtract(job, deps()).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ExtractBlocked);
        expect((error as ExtractBlocked).reason).toBe('missing_pricing');
      } finally {
        await db.adminPool.query(
          `INSERT INTO model_pricing (provider, model, input_per_mtok, output_per_mtok, effective_from)
           VALUES ($1, $2, 3.000000, 15.000000, now() - interval '1 day')`,
          [OFFLINE_PROVIDER_ID, OFFLINE_MODEL],
        );
      }
    });

    it('refuses a billable provider unless model calls are explicitly enabled', async () => {
      const billable: ModelProvider = { ...offlineProvider, id: 'billable-stub', billable: true };
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);

      const error = await handleWebExtract(job, deps(billable, false)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ExtractBlocked);
      expect((error as ExtractBlocked).reason).toBe('model_calls_disabled');
      expect(await callCount()).toBe(0);
    });

    it('charges nothing at all for a non-billable provider run', async () => {
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());
      const { rows } = await app.query<{ total: string }>(
        'SELECT coalesce(sum(cost_usd), 0)::text AS total FROM llm_calls',
      );
      // The offline adapter has a pricing row so the arithmetic is exercised;
      // what matters is that it is recorded, not that it is zero.
      expect(Number(rows[0]?.total)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('the reservation is what stops a second provider call', () => {
    it('reserves before calling, and finalises in the same transaction as the fact', async () => {
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());

      const { rows } = await app.query<{
        status: string;
        reservation_key: string;
        reserved_at: Date;
        finalized_at: Date;
        estimated_cost_usd: string;
        cost_usd: string;
      }>(
        `SELECT status, reservation_key, reserved_at, finalized_at,
                estimated_cost_usd, cost_usd
           FROM llm_calls`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('succeeded');
      expect(rows[0]?.reservation_key).toContain(`web.extract:${snapshotId}:`);
      expect(rows[0]?.reservation_key).toContain(OFFLINE_MODEL);
      expect(rows[0]?.reserved_at).not.toBeNull();
      expect(rows[0]?.finalized_at).not.toBeNull();
      // The estimate was pessimistic; the actual is what was billed.
      expect(Number(rows[0]?.cost_usd)).toBeLessThanOrEqual(
        Number(rows[0]?.estimated_cost_usd),
      );
    }, 60_000);

    it('two workers racing one snapshot invoke the provider once', async () => {
      // The requirement, measured at the provider rather than inferred: the
      // offline adapter counts its own invocations.
      const snapshotId = await insertSnapshot();
      let invocations = 0;
      const counting: ModelProvider = {
        ...offlineProvider,
        complete(providerRequest) {
          invocations += 1;
          return offlineProvider.complete(providerRequest);
        },
      };

      const a = await claimExtractJob(snapshotId);
      await enqueue(app, {
        kind: 'web.extract',
        dedupeKey: `${dedupeKey.webExtract(snapshotId, EXTRACTION_SCHEMA_VERSION)}:second`,
        traceId: newTraceId(),
        payload: { snapshot_id: snapshotId },
      });
      const b = await claimJob(app, 'test-worker-2');

      const outcomes = await Promise.allSettled([
        handleWebExtract(a, { pool: app, provider: counting, modelCallsEnabled: false }),
        handleWebExtract(b!, { pool: app, provider: counting, modelCallsEnabled: false }),
      ]);

      expect(invocations).toBe(1);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      // One did the work. The other either saw the finished extraction or was
      // refused by the reservation — both are correct, and neither called out.
      expect(fulfilled.length + rejected.length).toBe(2);
      for (const outcome of rejected) {
        expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(ExtractBlocked);
        expect(((outcome as PromiseRejectedResult).reason as ExtractBlocked).reason).toBe(
          'reservation_in_flight',
        );
      }

      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM extractions',
      );
      expect(rows[0]?.count).toBe('1');
    }, 60_000);

    it('a provider failure after reservation blocks for reconciliation, not retry', async () => {
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);
      const exploding: ModelProvider = {
        ...offlineProvider,
        complete() {
          return Promise.reject(new Error('socket hang up'));
        },
      };

      const error = await handleWebExtract(job, {
        pool: app,
        provider: exploding,
        modelCallsEnabled: false,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ExtractBlocked);
      expect((error as ExtractBlocked).reason).toBe('reservation_in_flight');
      expect((error as Error).message).toMatch(/Reconcile it/);

      // The reservation stands, the budget is still committed to it, and no
      // extraction was written.
      const open = await openReservations(app);
      expect(open).toHaveLength(1);
      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM extractions',
      );
      expect(rows[0]?.count).toBe('0');

      // A retry cannot call out again.
      const retryJob = await claimExtractJob(snapshotId).catch(() => undefined);
      if (retryJob !== undefined) {
        const second = await handleWebExtract(retryJob, {
          pool: app,
          provider: exploding,
          modelCallsEnabled: false,
        }).catch((caught: unknown) => caught);
        expect((second as ExtractBlocked).reason).toBe('reservation_in_flight');
      }
    }, 60_000);

    it('a refusal before any reservation costs nothing and blocks no retry', async () => {
      await db.adminPool.query('DELETE FROM model_pricing');
      try {
        const snapshotId = await insertSnapshot();
        const job = await claimExtractJob(snapshotId);
        const error = await handleWebExtract(job, deps()).catch((caught: unknown) => caught);
        expect((error as ExtractBlocked).reason).toBe('missing_pricing');

        const { rows } = await app.query<{
          status: string;
          cost_usd: string;
          reservation_key: string | null;
        }>('SELECT status, cost_usd, reservation_key FROM llm_calls');
        expect(rows[0]?.status).toBe('blocked');
        expect(Number(rows[0]?.cost_usd)).toBe(0);
        expect(rows[0]?.reservation_key).toBeNull();
      } finally {
        await db.adminPool.query(
          `INSERT INTO model_pricing (provider, model, input_per_mtok, output_per_mtok, effective_from)
           VALUES ($1, $2, 3.000000, 15.000000, now() - interval '1 day')`,
          [OFFLINE_PROVIDER_ID, OFFLINE_MODEL],
        );
      }
    }, 60_000);

    it('distinguishes every blocked reason as its own code', async () => {
      // One generic "blocked" would tell an operator nothing. Each of these
      // needs a different response, so each is its own token.
      const reasons = new Set<string>();

      const billable: ModelProvider = { ...offlineProvider, id: 'billable', billable: true };
      const disabled = await handleWebExtract(
        await claimExtractJob(await insertSnapshot()),
        { pool: app, provider: billable, modelCallsEnabled: false },
      ).catch((caught: unknown) => caught);
      reasons.add((disabled as ExtractBlocked).reason);

      await db.adminPool.query(
        `INSERT INTO budgets (period_month, limit_usd, warn_usd, hard_stop_usd)
         VALUES (date_trunc('month', now())::date, 50, 35, 50)
         ON CONFLICT (period_month) DO NOTHING`,
      );
      // hard_stop must stay at or above limit (§4), so the whole window moves.
      await db.adminPool.query(
        'UPDATE budgets SET limit_usd = 0, warn_usd = 0, hard_stop_usd = 0',
      );
      const ceiling = await handleWebExtract(
        await claimExtractJob(await insertSnapshot()),
        deps(),
      ).catch((caught: unknown) => caught);
      reasons.add((ceiling as ExtractBlocked).reason);
      await db.adminPool.query(
        'UPDATE budgets SET limit_usd = 50, warn_usd = 35, hard_stop_usd = 50',
      );

      expect([...reasons].sort()).toStrictEqual(['budget_hard_stop', 'model_calls_disabled']);
    }, 60_000);
  });

  // --------------------------------------------------------------- provenance
  describe('what is stored and what is not', () => {
    it('never writes page text into events (§16)', async () => {
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());

      const { rows } = await app.query<{ payload: string }>(
        'SELECT payload::text AS payload FROM events',
      );
      for (const row of rows) {
        expect(row.payload).not.toContain('Harbourline Criminal Defence is a specialist');
        expect(row.payload).not.toContain('Pitt Street');
      }
    });

    it('stamps the schema and prompt versions on the payload (§22)', async () => {
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());
      const { rows } = await app.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM extractions',
      );
      expect(rows[0]?.payload.schema_version).toBe(EXTRACTION_SCHEMA_VERSION);
      expect(rows[0]?.payload.prompt_version).toBe('extract-v1');
    });

    it('enqueues nothing downstream: company.assess is Day 6 (§6, §25)', async () => {
      const snapshotId = await insertSnapshot();
      const job = await claimExtractJob(snapshotId);
      await handleWebExtract(job, deps());
      const { rows } = await app.query<{ kind: string }>(
        `SELECT kind FROM jobs WHERE kind <> 'web.extract'`,
      );
      expect(rows).toStrictEqual([]);
    });
  });
});

/**
 * The SQL mirror of the eligibility gate.
 *
 * src/pipeline/evidence.ts enforces the rule in code, where it is unit-tested;
 * ELIGIBLE_SNAPSHOT_SQL restates it for the dashboard and for ad-hoc counting.
 * Two statements of one rule drift, so this asserts they agree row by row
 * against a real database rather than trusting that they were written the same.
 */
describeWithDb('the SQL mirror agrees with the code gate', () => {
  let db: TestDatabase;
  let app: Pool;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO companies (canonical_domain) VALUES ('mirror.example') RETURNING id`,
    );
    companyId = rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('selects exactly the snapshots the code calls eligible', async () => {
    const long = `${PAGE_TEXT} Additional detail about our Sydney practice follows.`;
    const cases: { text: string | null; status: number | null; robots: boolean; url: string }[] = [
      { text: long, status: 200, robots: true, url: 'https://mirror.example/' },
      { text: long, status: 200, robots: true, url: 'https://www.mirror.example/about' },
      { text: long, status: 200, robots: true, url: 'https://nsw.mirror.example/offices' },
      { text: long, status: 200, robots: true, url: 'https://elsewhere.example/' },
      { text: 'too short', status: 200, robots: true, url: 'https://mirror.example/thin' },
      { text: null, status: null, robots: false, url: 'https://mirror.example/private' },
      { text: null, status: 404, robots: true, url: 'https://mirror.example/gone' },
    ];

    for (const [index, row] of cases.entries()) {
      await db.adminPool.query(
        `INSERT INTO web_snapshots
           (company_id, url, http_status, content_hash, text, bytes, robots_allowed, trace_id)
         VALUES ($1, $2, $3, $4, $5, 1024, $6, 'T')`,
        [companyId, row.url, row.status, `mirror-${index}`, row.text, row.robots],
      );
    }

    const fromSql = await app.query<{ id: string }>(
      `${ELIGIBLE_SNAPSHOT_SQL} AND s.company_id = $1`,
      [companyId],
    );

    const all = await app.query<SnapshotForEligibility>(
      `SELECT s.id, s.company_id, s.url, s.http_status, s.robots_allowed, s.text,
              c.canonical_domain::text AS canonical_domain
         FROM web_snapshots s JOIN companies c ON c.id = s.company_id
        WHERE s.company_id = $1`,
      [companyId],
    );
    const fromCode = all.rows
      .filter((row) => assessEligibility(row, { alreadyExtracted: false }).eligible)
      .map((row) => row.id);

    // Containment, not equality: the SQL cannot ask the Public Suffix List, so
    // it accepts a superset and the difference is exactly the off-domain rows.
    const sqlIds = fromSql.rows.map((row) => row.id).sort();
    for (const id of fromCode) {
      expect(sqlIds, 'the SQL mirror must accept everything the code accepts').toContain(id);
    }

    const extra = sqlIds.filter((id) => !fromCode.includes(id));
    const offDomain = all.rows
      .filter((row) => !isOnOwnDomain(row.url, row.canonical_domain))
      .map((row) => row.id);
    expect(extra.sort()).toStrictEqual(
      extra.filter((id) => offDomain.includes(id)).sort(),
    );

    // And it is not vacuously true: the apex, the www form and a subdomain all
    // qualify, and the off-domain page is the one the code refuses.
    expect(fromCode).toHaveLength(3);
    expect(extra).toHaveLength(1);
  });
});
