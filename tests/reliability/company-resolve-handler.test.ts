/**
 * The company.resolve handler against real PostgreSQL (SPEC.md §6, §7, §10).
 *
 * What is actually under test is not arithmetic — it is that §4's constraints do
 * the deduplication, that the fan-out is idempotent under replay, and that a
 * failure part-way leaves nothing behind. All three are properties of the
 * database under a real transaction, so a mock would agree with whatever the
 * code believes.
 *
 * No model is involved at any point: this stage is §10 stages 1-3, which §10
 * calls "code, no model" precisely so that nothing is paid to reject a miss.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { enqueue } from '../../src/jobs/enqueue';
import { dedupeKey, fetchUrlHash, todayUtc } from '../../src/jobs/kinds';
import { claimJob, type ClaimedJob } from '../../src/jobs/queue';
import { planHomePage } from '../../src/pipeline/resolve';
import {
  companyResolvePayloadSchema,
  handleCompanyResolve,
} from '../../src/worker/handlers/company-resolve';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const TRACE = '01JA2BCDEFGHJKMNPQRSTVWXYZ';
const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the company.resolve suite.');
}

describeWithDb('the company.resolve handler (§6, §7, §10 stages 1-3)', () => {
  let db: TestDatabase;
  let app: Pool;
  let campaignId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO campaigns (slug, name, rubric_version)
       VALUES ('au-criminal-defence', 'AU criminal defence', 'v1.1') RETURNING id`,
    );
    campaignId = rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.resetQueue();
    await db.adminPool.query('TRUNCATE prospects, company_sources, companies, suppressions CASCADE');
  });

  async function claimResolveJob(
    candidateDomain: string,
    overrides: Record<string, unknown> = {},
  ): Promise<ClaimedJob> {
    await enqueue(app, {
      kind: 'company.resolve',
      // §7: resolve:{canonical_domain}, permanent. Randomised here only so a
      // case can resolve the same firm twice without the queue deduplicating it.
      dedupeKey: `${dedupeKey.companyResolve(candidateDomain)}:${Math.random().toString(36).slice(2)}`,
      traceId: TRACE,
      // Claimed ahead of the web.fetch jobs an earlier resolve left queued: the
      // claim orders by priority DESC, and several cases resolve twice.
      priority: 10,
      payload: {
        candidate_domain: candidateDomain,
        campaign_id: campaignId,
        source_kind: 'manual',
        source_ref: 'day5 reliability suite',
        ...overrides,
      },
    });
    const job = await claimJob(app, 'test-worker');
    if (job === undefined || job.kind !== 'company.resolve') {
      throw new Error(`expected to claim a company.resolve job, got ${job?.kind ?? 'none'}`);
    }
    return job;
  }

  async function fetchJobs(): Promise<
    { dedupe_key: string; payload: Record<string, unknown>; parent_job_id: string | null }[]
  > {
    const { rows } = await app.query<{
      dedupe_key: string;
      payload: Record<string, unknown>;
      parent_job_id: string | null;
    }>(
      `SELECT dedupe_key, payload, parent_job_id FROM jobs
        WHERE kind = 'web.fetch' ORDER BY dedupe_key`,
    );
    return rows;
  }

  // -------------------------------------------------------------- the happy path
  describe('a fresh candidate', () => {
    it('creates the company, the provenance row, the prospect and the homepage job', async () => {
      const job = await claimResolveJob('https://www.paterson-finch.com.au/');
      const result = await handleCompanyResolve(job, { pool: app });

      // One page in this wave. §10 stage 3's other five are chosen by the
      // homepage's own job from the links the harvester read, which is why this
      // stage cannot know them yet.
      expect(result).toMatchObject({
        kind: 'resolved',
        canonicalDomain: 'paterson-finch.com.au',
        companyCreated: true,
        prospectCreated: true,
        pagesPlanned: 1,
        fetchesEnqueued: 1,
      });
      if (result.kind !== 'resolved') {
        throw new Error('expected a resolution');
      }
      expect(result.pageKinds).toStrictEqual(['home']);

      // §4: canonical_domain is the registrable domain, lowercased, no www.
      const company = await app.query<{ canonical_domain: string }>(
        'SELECT canonical_domain FROM companies',
      );
      expect(company.rows).toStrictEqual([{ canonical_domain: 'paterson-finch.com.au' }]);

      const source = await app.query<{ source_kind: string; source_ref: string; raw: unknown }>(
        'SELECT source_kind::text AS source_kind, source_ref, raw FROM company_sources',
      );
      expect(source.rows).toHaveLength(1);
      expect(source.rows[0]).toMatchObject({
        source_kind: 'manual',
        source_ref: 'day5 reliability suite',
        raw: { candidate_domain: 'https://www.paterson-finch.com.au/' },
      });

      const prospect = await app.query<{ stage: string; company_id: string }>(
        'SELECT stage::text AS stage, company_id FROM prospects',
      );
      expect(prospect.rows).toHaveLength(1);
      expect(prospect.rows[0]?.stage).toBe('discovered');
      expect(prospect.rows[0]?.company_id).toBe(result.companyId);
    });

    it('enqueues one job carrying one URL, never a job carrying a list', async () => {
      // Day 3's per-URL retry residual, closed: a page's retry budget is its
      // own, because the page is its own job. That holds in both waves.
      const job = await claimResolveJob('firm-one.com.au');
      const result = await handleCompanyResolve(job, { pool: app });
      if (result.kind !== 'resolved') {
        throw new Error('expected a resolution');
      }

      const jobs = await fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.parent_job_id).toBe(job.id);
      expect(jobs[0]?.payload).toMatchObject({
        company_id: result.companyId,
        urls: ['https://firm-one.com.au/'],
        page_kind: 'home',
        // Provenance: the root is neither discovered nor a guess.
        page_source: 'root',
        occurrence: result.occurrence,
      });
      expect((jobs[0]?.payload as { urls: string[] }).urls).toHaveLength(1);
    });

    it('carries the occurrence so all six pages share one (§7)', async () => {
      const job = await claimResolveJob('firm-occurrence.com.au');
      const result = await handleCompanyResolve(job, { pool: app, occurrence: '2026-10-08' });
      if (result.kind !== 'resolved') {
        throw new Error('expected a resolution');
      }
      expect(result.occurrence).toBe('2026-10-08');
      const jobs = await fetchJobs();
      expect((jobs[0]?.payload as { occurrence: string }).occurrence).toBe('2026-10-08');
    });

    it('uses §7’s per-URL key, so the keys are distinct and reproducible', async () => {
      const job = await claimResolveJob('firm-two.com.au');
      const result = await handleCompanyResolve(job, { pool: app, occurrence: '2026-10-08' });
      if (result.kind !== 'resolved') {
        throw new Error('expected a resolution');
      }

      const jobs = await fetchJobs();
      const home = planHomePage('firm-two.com.au');
      expect(jobs.map((row) => row.dedupe_key)).toStrictEqual([
        dedupeKey.webFetch(result.companyId, fetchUrlHash([home?.url as string]), '2026-10-08'),
      ]);
    });

    it('writes one company.resolved event with counts and no prose', async () => {
      const job = await claimResolveJob('firm-three.com.au');
      const result = await handleCompanyResolve(job, { pool: app });
      if (result.kind !== 'resolved') {
        throw new Error('expected a resolution');
      }

      const { rows } = await app.query<{
        entity_type: string;
        entity_id: string;
        actor_type: string;
        payload: Record<string, unknown>;
        trace_id: string;
      }>(
        `SELECT entity_type, entity_id, actor_type::text AS actor_type, payload, trace_id
           FROM events WHERE kind = 'company.resolved'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity_type: 'company',
        entity_id: result.companyId,
        actor_type: 'system',
        trace_id: TRACE,
      });
      expect(rows[0]?.payload).toMatchObject({
        canonical_domain: 'firm-three.com.au',
        company_created: true,
        prospect_created: true,
        pages_planned: 1,
        fetches_enqueued: 1,
        // The five the homepage will choose, named here so the audit shows the
        // ceiling this fan-out is working towards.
        follow_up_kinds: ['about', 'practice_areas', 'contact', 'team', 'location'],
      });
      // §16: the spine carries ids, counts and machine tokens. source_ref is a
      // search query, which is prose, and it stays in company_sources.
      expect(JSON.stringify(rows[0]?.payload)).not.toContain('reliability suite');
    });
  });

  // ------------------------------------------------------------ deduplication
  describe('§10 stage 1 deduplication', () => {
    it('collapses www, apex and a subdomain onto one company', async () => {
      for (const candidate of [
        'firm-dedupe.com.au',
        'https://www.firm-dedupe.com.au/',
        'nsw.firm-dedupe.com.au',
        'FIRM-DEDUPE.COM.AU',
      ]) {
        const job = await claimResolveJob(candidate);
        await handleCompanyResolve(job, { pool: app });
      }

      const companies = await app.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM companies',
      );
      expect(companies.rows[0]?.count).toBe('1');

      // One company, one prospect, one homepage fetch — not four of each.
      const jobs = await fetchJobs();
      expect(jobs).toHaveLength(1);
      const prospects = await app.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM prospects',
      );
      expect(prospects.rows[0]?.count).toBe('1');
    });

    it('rejects the second attempt at a firm already in this campaign', async () => {
      const first = await claimResolveJob('firm-twice.com.au');
      await handleCompanyResolve(first, { pool: app });

      const second = await claimResolveJob('www.firm-twice.com.au');
      const result = await handleCompanyResolve(second, { pool: app });
      expect(result).toMatchObject({ kind: 'rejected', reason: 'already_a_prospect' });

      // The rejection is the §10 stage 2 decision, so it enqueues nothing new
      // and the company row is untouched.
      expect(await fetchJobs()).toHaveLength(1);
      const events = await app.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM events WHERE kind = 'company.rejected'`,
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.payload).toMatchObject({
        reason: 'already_a_prospect',
        stage: 'discovered',
      });
    });

    it('is idempotent on replay: no duplicate provenance and no duplicate jobs', async () => {
      // The same claimed job run twice, which is what a reaper requeue produces.
      const job = await claimResolveJob('firm-replay.com.au');
      const first = await handleCompanyResolve(job, { pool: app, occurrence: '2026-10-08' });
      expect(first).toMatchObject({ kind: 'resolved', fetchesEnqueued: 1 });

      const again = await handleCompanyResolve(job, { pool: app, occurrence: '2026-10-08' });
      // The prospect now exists, so stage 2 answers before the fan-out — and
      // the fan-out would have inserted nothing anyway, because §7's keys are
      // the same work.
      expect(again).toMatchObject({ kind: 'rejected', reason: 'already_a_prospect' });

      expect(await fetchJobs()).toHaveLength(1);
      const sources = await app.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM company_sources',
      );
      expect(sources.rows[0]?.count).toBe('1');
    });

    it('re-enqueues nothing twice when the same page is replayed', async () => {
      // Same company, same page, same occurrence: the key collides and
      // `inserted` is false, which is what makes a replay a no-op.
      const job = await claimResolveJob('firm-keys.com.au');
      const result = await handleCompanyResolve(job, { pool: app, occurrence: '2026-10-08' });
      if (result.kind !== 'resolved') {
        throw new Error('expected a resolution');
      }
      const home = planHomePage('firm-keys.com.au');
      const { inserted } = await enqueue(app, {
        kind: 'web.fetch',
        dedupeKey: dedupeKey.webFetch(
          result.companyId,
          fetchUrlHash([home?.url as string]),
          '2026-10-08',
        ),
        traceId: TRACE,
        payload: { company_id: result.companyId, urls: [home?.url as string] },
      });
      expect(inserted).toBe(false);
    });
  });

  // ------------------------------------------------------------- the rejections
  describe('§10 stage 2, the two filters a domain can answer', () => {
    it('rejects a suppressed domain and leaves no company row behind', async () => {
      await db.adminPool.query(
        `INSERT INTO suppressions (match_type, match_value, reason)
         VALUES ('domain', 'Blocked-Firm.com.au', 'do_not_contact')`,
      );

      const job = await claimResolveJob('https://www.blocked-firm.com.au/about');
      const result = await handleCompanyResolve(job, { pool: app });
      expect(result).toMatchObject({ kind: 'rejected', reason: 'suppressed_domain' });

      // A suppressed firm leaves the audit event and nothing else: no company,
      // no provenance, no prospect, no fetch.
      for (const table of ['companies', 'company_sources', 'prospects']) {
        const { rows } = await app.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        expect(rows[0]?.count, table).toBe('0');
      }
      expect(await fetchJobs()).toHaveLength(0);

      const events = await app.query<{ entity_type: string; payload: Record<string, unknown> }>(
        `SELECT entity_type, payload FROM events WHERE kind = 'company.rejected'`,
      );
      expect(events.rows[0]?.entity_type).toBe('job');
      expect(events.rows[0]?.payload).toMatchObject({ reason: 'suppressed_domain' });
    });

    it('matches suppression on the registrable domain, not the submitted host', async () => {
      await db.adminPool.query(
        `INSERT INTO suppressions (match_type, match_value, reason)
         VALUES ('domain', 'suppressed-firm.com.au', 'competitor')`,
      );
      // A subdomain of a suppressed firm is the same firm. Host matching would
      // have let this through.
      const job = await claimResolveJob('https://nsw.suppressed-firm.com.au/contact');
      expect(await handleCompanyResolve(job, { pool: app })).toMatchObject({
        reason: 'suppressed_domain',
      });
    });

    it('rejects a candidate with no registrable domain before touching the database', async () => {
      for (const [candidate, reason] of [
        ['203.0.113.10', 'ip_address'],
        ['com.au', 'no_registrable_domain'],
        ['localhost', 'no_registrable_domain'],
        ['not a domain', 'no_registrable_domain'],
      ] as const) {
        const job = await claimResolveJob(candidate);
        const result = await handleCompanyResolve(job, { pool: app });
        expect(result, candidate).toMatchObject({ kind: 'rejected', reason, companyId: null });
        await db.adminPool.query(`DELETE FROM jobs WHERE id = $1`, [job.id]).catch(() => undefined);
      }

      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM companies',
      );
      expect(rows[0]?.count).toBe('0');
      expect(await fetchJobs()).toHaveLength(0);
    });

    it('does not reject a firm for being on a non-.au domain', async () => {
      const job = await claimResolveJob('firm-global.com');
      expect(await handleCompanyResolve(job, { pool: app })).toMatchObject({
        kind: 'resolved',
        canonicalDomain: 'firm-global.com',
      });
    });
  });

  // --------------------------------------------------------------- atomicity
  describe('one transaction or none of it', () => {
    it('leaves nothing behind when the fan-out cannot commit', async () => {
      // A campaign id that does not exist: the prospect insert violates its
      // foreign key after the company and its provenance row have been written.
      // If those were separate transactions, the firm would be left with a
      // company row, no prospect and no fetches — which reads as "already
      // resolved" for ever.
      const job = await claimResolveJob('firm-rollback.com.au', {
        campaign_id: '00000000-0000-4000-8000-0000000000ff',
      });
      await expect(handleCompanyResolve(job, { pool: app })).rejects.toThrow();

      for (const table of ['companies', 'company_sources', 'prospects', 'events']) {
        const { rows } = await app.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        expect(rows[0]?.count, table).toBe('0');
      }
      expect(await fetchJobs()).toHaveLength(0);
    });

    it('can be retried after a rollback and then succeeds completely', async () => {
      const failing = await claimResolveJob('firm-retry.com.au', {
        campaign_id: '00000000-0000-4000-8000-0000000000ff',
      });
      await expect(handleCompanyResolve(failing, { pool: app })).rejects.toThrow();

      const job = await claimResolveJob('firm-retry.com.au');
      expect(await handleCompanyResolve(job, { pool: app })).toMatchObject({
        kind: 'resolved',
        companyCreated: true,
        prospectCreated: true,
        fetchesEnqueued: 1,
      });
    });
  });

  // ------------------------------------------------------------ the queue itself
  describe('through the real queue (§6)', () => {
    it('leaves one claimable homepage job with its own attempt budget', async () => {
      const job = await claimResolveJob('firm-queue.com.au');
      await handleCompanyResolve(job, { pool: app });

      const next = await claimJob(app, 'w0');
      expect(next?.kind).toBe('web.fetch');
      expect(next?.attempts).toBe(1);
      expect(next?.max_attempts).toBe(3);
      expect((next?.payload as { page_kind: string }).page_kind).toBe('home');
      // And nothing else: the second wave needs the homepage read first.
      expect(await claimJob(app, 'w-last')).toBeUndefined();
    });
  });

  describe('the payload contract', () => {
    it('refuses a payload that is missing a field or carries an extra one', () => {
      const valid = {
        candidate_domain: 'firm.com.au',
        campaign_id: '00000000-0000-4000-8000-000000000001',
        source_kind: 'manual',
        source_ref: 'x',
      };
      expect(() => companyResolvePayloadSchema.parse(valid)).not.toThrow();
      expect(() => companyResolvePayloadSchema.parse({ ...valid, urls: ['x'] })).toThrow();
      expect(() => companyResolvePayloadSchema.parse({ ...valid, campaign_id: 'x' })).toThrow();
      expect(() => companyResolvePayloadSchema.parse({ ...valid, source_kind: 'apollo' })).toThrow();
      expect(() => companyResolvePayloadSchema.parse({ ...valid, candidate_domain: '' })).toThrow();
    });

    it('defaults the fetch occurrence to today in UTC (§7)', () => {
      expect(todayUtc(new Date('2026-10-08T23:59:59Z'))).toBe('2026-10-08');
      expect(todayUtc(new Date('2026-10-09T00:00:00Z'))).toBe('2026-10-09');
    });
  });
});
