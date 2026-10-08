/**
 * The second wave: the homepage chooses the other five pages (§10 stage 3).
 *
 * This suite is about the trust boundary, not about parsing. The harvest was
 * produced by the fetcher from attacker-controlled markup and stored as jsonb;
 * the worker re-derives every candidate before any of them becomes a job. So
 * each case writes a `signals.page_links` value by hand — including values no
 * honest harvester would ever produce — and asserts what the worker does with
 * it.
 *
 * The fetcher is stubbed here on purpose. The real one is exercised in
 * tests/reliability/web-fetch-handler.test.ts against a loopback origin, and a
 * loopback origin is an IP address, which has no registrable domain and so can
 * never be first party to anything. Discovery cannot be tested through it, and
 * pretending otherwise would be a test that proves the filter refuses an IP.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { fetchResponseSchema } from '../../src/fetcher/contract';
import { enqueue } from '../../src/jobs/enqueue';
import { dedupeKey, fetchUrlHash } from '../../src/jobs/kinds';
import { claimJob, type ClaimedJob } from '../../src/jobs/queue';
import { FOLLOW_UP_KINDS, PAGE_PATHS } from '../../src/pipeline/resolve';
import { handleWebFetch } from '../../src/worker/handlers/web-fetch';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const TRACE = '01JA2BCDEFGHJKMNPQRSTVWXYZ';
const DOMAIN = 'example-legal.com.au';
const HOME = `https://${DOMAIN}/`;
const OCCURRENCE = '2026-10-08';
const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the homepage fan-out suite.');
}

describeWithDb('the homepage fan-out (§8, §10 stage 3)', () => {
  let db: TestDatabase;
  let app: Pool;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO companies (canonical_domain) VALUES ($1) RETURNING id`,
      [DOMAIN],
    );
    companyId = rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.resetQueue();
    await db.adminPool.query('TRUNCATE web_snapshots CASCADE');
  });

  /** A stored 2xx homepage snapshot carrying exactly this harvest. */
  async function storeHomepage(pageLinks: unknown, url = HOME): Promise<string> {
    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO web_snapshots
         (company_id, url, http_status, content_hash, text, bytes, robots_allowed,
          trace_id, signals)
       VALUES ($1, $2, 200, $3, $4, 2048, true, $5, $6::jsonb)
       RETURNING id`,
      [
        companyId,
        url,
        `hash-${Math.random().toString(36).slice(2)}`,
        'The firm. '.repeat(200),
        TRACE,
        JSON.stringify({ signals_version: 'tier-a-v1', page_links: pageLinks }),
      ],
    );
    return rows[0]!.id;
  }

  async function claimHomeJob(pageKind = 'home', maxAttempts?: number): Promise<ClaimedJob> {
    await enqueue(app, {
      kind: 'web.fetch',
      dedupeKey: dedupeKey.webFetch(companyId, fetchUrlHash([HOME]), `${Math.random()}`),
      traceId: TRACE,
      priority: 10,
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      payload: {
        company_id: companyId,
        urls: [HOME],
        page_kind: pageKind,
        page_source: 'root',
        occurrence: OCCURRENCE,
      },
    });
    const job = await claimJob(app, 'test-worker');
    if (job === undefined || job.kind !== 'web.fetch') {
      throw new Error(`expected a web.fetch job, got ${job?.kind ?? 'none'}`);
    }
    return job;
  }

  /** A fetcher that reports the snapshot we already stored, and nothing else. */
  function stubFetcher(snapshotId: string): typeof globalThis.fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          outcome: 'stored',
          snapshot_id: snapshotId,
          http_status: 200,
          content_hash: 'c'.repeat(64),
          bytes: 2048,
          text_length: 2000,
          robots_allowed: true,
          final_url: HOME,
          trace_id: TRACE,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
  }

  /** A fetcher that replies with exactly this body. */
  function stubReply(body: Record<string, unknown>): typeof globalThis.fetch {
    return (async () =>
      new Response(JSON.stringify({ trace_id: TRACE, ...body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
  }

  function fetcherDeps(fetchImpl: typeof globalThis.fetch) {
    return {
      fetcherUrl: 'http://fetcher.invalid',
      sharedSecret: 's'.repeat(48),
      pool: app,
      fetchImpl,
    };
  }

  async function runHome(
    pageLinks: unknown,
    options: { pageKind?: string; url?: string } = {},
  ) {
    const snapshotId = await storeHomepage(pageLinks, options.url);
    const job = await claimHomeJob(options.pageKind);
    const result = await handleWebFetch(job, {
      fetcherUrl: 'http://fetcher.invalid',
      sharedSecret: 's'.repeat(48),
      pool: app,
      fetchImpl: stubFetcher(snapshotId),
    });
    return { job, result, snapshotId };
  }

  async function followUps() {
    const { rows } = await app.query<{
      payload: { urls: string[]; page_kind?: string; page_source?: string; occurrence?: string };
      dedupe_key: string;
      parent_job_id: string | null;
    }>(
      // parent_job_id IS NOT NULL is what makes these the *fan-out*: the job a
      // case seeds has no parent, so it never counts as its own follow-up.
      `SELECT payload, dedupe_key, parent_job_id FROM jobs
        WHERE kind = 'web.fetch' AND parent_job_id IS NOT NULL`,
    );
    return rows;
  }

  function harvest(candidates: { kind: string; url: string }[]) {
    return { links_version: 'links-v1', considered: 40, kept: candidates.length, candidates };
  }

  // ------------------------------------------------------------ the happy path
  it('prefers a discovered URL for every kind the homepage offered', async () => {
    const { result } = await runHome(
      harvest([
        { kind: 'about', url: `https://${DOMAIN}/about-us` },
        { kind: 'practice_areas', url: `https://${DOMAIN}/areas-of-law` },
        { kind: 'contact', url: `https://${DOMAIN}/contact-us` },
        { kind: 'team', url: `https://${DOMAIN}/our-people` },
        { kind: 'location', url: `https://${DOMAIN}/offices` },
      ]),
    );

    expect(result.followUpsEnqueued).toBe(5);
    expect(result.followUpsDiscovered).toBe(5);

    const rows = await followUps();
    expect(
      rows.map((row) => [row.payload.page_kind, row.payload.urls[0], row.payload.page_source]),
    ).toStrictEqual(
      expect.arrayContaining([
        ['about', `https://${DOMAIN}/about-us`, 'discovered'],
        ['practice_areas', `https://${DOMAIN}/areas-of-law`, 'discovered'],
        ['contact', `https://${DOMAIN}/contact-us`, 'discovered'],
        ['team', `https://${DOMAIN}/our-people`, 'discovered'],
        ['location', `https://${DOMAIN}/offices`, 'discovered'],
      ]),
    );
    for (const row of rows) {
      expect(row.payload.urls).toHaveLength(1);
      expect(row.payload.occurrence).toBe(OCCURRENCE);
    }
  });

  it('falls back to a conventional path for a kind the homepage did not offer', async () => {
    const { result } = await runHome(
      harvest([
        { kind: 'contact', url: `https://${DOMAIN}/contact-us` },
        { kind: 'team', url: `https://${DOMAIN}/our-people` },
      ]),
    );

    expect(result.followUpsEnqueued).toBe(5);
    expect(result.followUpsDiscovered).toBe(2);

    const rows = await followUps();
    const byKind = new Map(rows.map((row) => [row.payload.page_kind, row.payload]));
    expect(byKind.get('contact')).toMatchObject({
      urls: [`https://${DOMAIN}/contact-us`],
      page_source: 'discovered',
    });
    expect(byKind.get('about')).toMatchObject({
      urls: [`https://${DOMAIN}${PAGE_PATHS.about}`],
      page_source: 'fallback',
    });
    expect(byKind.get('location')).toMatchObject({ page_source: 'fallback' });
  });

  it('uses all five fallbacks when there is no harvest at all', async () => {
    for (const stored of [null, undefined, {}, { candidates: [] }, [], 'nonsense', 7]) {
      const { result } = await runHome(stored);
      expect(result.followUpsEnqueued, JSON.stringify(stored ?? null)).toBe(5);
      expect(result.followUpsDiscovered).toBe(0);
      const rows = await followUps();
      expect(rows.map((row) => row.payload.urls[0]).sort()).toStrictEqual(
        FOLLOW_UP_KINDS.map((kind) => `https://${DOMAIN}${PAGE_PATHS[kind]}`).sort(),
      );
      await db.resetQueue();
      await db.adminPool.query('TRUNCATE web_snapshots CASCADE');
    }
  });

  // ------------------------------------------------- the worker trusts nothing
  describe('the stored harvest is re-derived, never believed', () => {
    it('drops every candidate the §8 filter refuses and falls back instead', async () => {
      const { result } = await runHome(
        harvest([
          // A deceptive suffix, a lookalike, and a sibling domain.
          { kind: 'about', url: `https://${DOMAIN}.attacker.tld/about` },
          { kind: 'about', url: 'https://example-legаl.com.au/about' },
          { kind: 'about', url: 'https://not-example-legal.com.au/about' },
          // Schemes that are not pages.
          { kind: 'contact', url: 'javascript:alert(1)' },
          { kind: 'contact', url: 'data:text/html,<script>1</script>' },
          { kind: 'contact', url: 'file:///etc/passwd' },
          // Credentials, and the firm's domain used as userinfo.
          { kind: 'team', url: `https://user:pass@${DOMAIN}/team` },
          { kind: 'team', url: `https://${DOMAIN}@evil.example/team` },
          // Ports the frozen policy would not open.
          { kind: 'location', url: `https://${DOMAIN}:8080/locations` },
          { kind: 'location', url: `http://${DOMAIN}:5432/offices` },
          // Depth, and a path outside the allowlist.
          { kind: 'practice_areas', url: `https://${DOMAIN}/services/a/b/c` },
          { kind: 'practice_areas', url: `https://${DOMAIN}/wp-admin` },
          // Hosts with no registrable domain.
          { kind: 'about', url: 'http://169.254.169.254/about' },
          { kind: 'about', url: 'http://127.0.0.1/about' },
        ]),
      );

      // Nothing survived, so all five pages are conventional paths on the
      // firm's own domain.
      expect(result.followUpsDiscovered).toBe(0);
      expect(result.followUpsEnqueued).toBe(5);
      for (const row of await followUps()) {
        expect(row.payload.page_source).toBe('fallback');
        expect(new URL(row.payload.urls[0] as string).hostname).toBe(DOMAIN);
      }
    });

    it('recomputes the page kind rather than trusting the stored label', async () => {
      // The fetcher says this is the about page. The path says contact.
      const { result } = await runHome(
        harvest([{ kind: 'about', url: `https://${DOMAIN}/contact-us` }]),
      );
      expect(result.followUpsDiscovered).toBe(1);

      const byKind = new Map(
        (await followUps()).map((row) => [row.payload.page_kind, row.payload]),
      );
      expect(byKind.get('contact')).toMatchObject({
        urls: [`https://${DOMAIN}/contact-us`],
        page_source: 'discovered',
      });
      // And `about` was not filled by the mislabelled entry.
      expect(byKind.get('about')).toMatchObject({ page_source: 'fallback' });
    });

    it('accepts a legitimate subdomain, and still only one page per kind', async () => {
      const { result } = await runHome(
        harvest([
          { kind: 'about', url: `https://www.${DOMAIN}/about-us` },
          { kind: 'about', url: `https://nsw.${DOMAIN}/about` },
        ]),
      );
      expect(result.followUpsDiscovered).toBe(1);
      const byKind = new Map(
        (await followUps()).map((row) => [row.payload.page_kind, row.payload]),
      );
      expect(byKind.get('about')).toMatchObject({
        urls: [`https://www.${DOMAIN}/about-us`],
        page_source: 'discovered',
      });
    });

    it('stays bounded at five when the stored list holds thousands', async () => {
      const { result } = await runHome(
        harvest([
          ...Array.from({ length: 2_000 }, (_u, index) => ({
            kind: 'location',
            url: `https://${DOMAIN}/locations/branch-${index}`,
          })),
          ...Array.from({ length: 2_000 }, (_u, index) => ({
            kind: 'about',
            url: `https://evil-${index}.example/about`,
          })),
        ]),
      );
      // One per kind, whatever the list contains: the loop is over the kinds.
      expect(result.followUpsEnqueued).toBe(5);
      expect(result.followUpsDiscovered).toBe(1);
      const rows = await followUps();
      expect(rows).toHaveLength(5);
      const byKind = new Map(rows.map((row) => [row.payload.page_kind, row.payload]));
      expect(byKind.get('location')).toMatchObject({
        urls: [`https://${DOMAIN}/locations/branch-0`],
      });
    });

    it('drops malformed entries without failing the job', async () => {
      const { result } = await runHome({
        links_version: 'links-v1',
        candidates: [
          null,
          7,
          'https://example-legal.com.au/about',
          { kind: 'about' },
          { url: null },
          { url: '' },
          { url: `https://${DOMAIN}/our-firm` },
        ],
      });
      // Only the one well-formed entry counts; a bare string is not an entry.
      expect(result.followUpsDiscovered).toBe(1);
      const byKind = new Map(
        (await followUps()).map((row) => [row.payload.page_kind, row.payload]),
      );
      expect(byKind.get('about')).toMatchObject({ urls: [`https://${DOMAIN}/our-firm`] });
    });

    it('re-derives against the canonical domain, not the snapshot’s final URL', async () => {
      // A redirect moved the homepage snapshot to another domain. §4 makes
      // companies.canonical_domain the firm's identity, so a candidate on the
      // redirect target is not first party even though it matches the page.
      const { result } = await runHome(
        harvest([{ kind: 'about', url: 'https://parked-domains.example/about' }]),
        { url: 'https://parked-domains.example/' },
      );
      expect(result.followUpsDiscovered).toBe(0);
      for (const row of await followUps()) {
        expect(new URL(row.payload.urls[0] as string).hostname).toBe(DOMAIN);
      }
    });
  });

  // --------------------------------------------------------------- the ceiling
  describe('§10 stage 3’s ceiling of six', () => {
    it('fans out once, from the homepage only, so the depth is one', async () => {
      const { result } = await runHome(
        harvest([{ kind: 'about', url: `https://${DOMAIN}/about-us` }]),
        { pageKind: 'about' },
      );
      // A discovered page does not discover more pages. Without this the
      // ceiling would be unenforceable: five pages each fanning out to five.
      expect(result.followUpsEnqueued).toBe(0);
      expect(await followUps()).toHaveLength(0);
    });

    it('reaches exactly six pages for the firm, across both waves', async () => {
      await runHome(harvest([{ kind: 'about', url: `https://${DOMAIN}/about-us` }]));
      const { rows } = await app.query<{ count: string; urls: string[] }>(
        `SELECT count(*)::text AS count, array_agg(payload ->> 'urls') AS urls
           FROM jobs WHERE kind = 'web.fetch'`,
      );
      // One homepage job plus five follow-ups.
      expect(rows[0]?.count).toBe('6');
    });

    it('is idempotent: a replayed homepage job enqueues nothing new', async () => {
      const links = harvest([{ kind: 'contact', url: `https://${DOMAIN}/contact-us` }]);
      const snapshotId = await storeHomepage(links);
      const job = await claimHomeJob();
      const deps = {
        fetcherUrl: 'http://fetcher.invalid',
        sharedSecret: 's'.repeat(48),
        pool: app,
        fetchImpl: stubFetcher(snapshotId),
      };

      expect((await handleWebFetch(job, deps)).followUpsEnqueued).toBe(5);
      // Same company, same URLs, same occurrence: every §7 key collides.
      expect((await handleWebFetch(job, deps)).followUpsEnqueued).toBe(0);
      expect(await followUps()).toHaveLength(5);
    });

  });

  // ------------------------------------------- a homepage that refuses us
  //
  // The firm does not end at a blocked root. A site with a 403 on `/` and a
  // perfectly readable `/about` is ordinary, and Day 3's correction was about
  // not re-asking a URL that has already answered — not about giving up on a
  // company. So a terminal homepage outcome falls back to the five
  // conventional paths, built from companies.canonical_domain.
  describe('a terminal homepage outcome falls back, it does not end the firm', () => {
    const terminal = (overrides: Record<string, unknown>) =>
      stubReply({ robots_allowed: true, final_url: HOME, ...overrides });

    async function runTerminal(body: Record<string, unknown>, maxAttempts?: number) {
      const job = await claimHomeJob('home', maxAttempts);
      const result = await handleWebFetch(job, fetcherDeps(terminal(body)));
      return { job, result };
    }

    it('a 403 homepage still reaches /about, through a fallback job', async () => {
      const { result } = await runTerminal({
        outcome: 'http_error',
        http_status: 403,
        bytes: 120,
        reason: 'http_status_403',
      });

      expect(result.httpError).toBe(1);
      expect(result.stored).toBe(0);
      expect(result.followUpBasis).toBe('terminal_fallback');
      expect(result.followUpsEnqueued).toBe(5);
      expect(result.followUpsDiscovered).toBe(0);

      // The /about job exists, on the firm's own domain, marked as a guess.
      const rows = await followUps();
      const about = rows.find((row) => row.payload.page_kind === 'about');
      expect(about?.payload).toMatchObject({
        urls: [`https://${DOMAIN}${PAGE_PATHS.about}`],
        page_source: 'fallback',
      });

      // And it is claimable and works: the site answers for /about, so the
      // firm is reached despite the blocked root.
      const next = await claimJob(app, 'w-about');
      expect(next?.kind).toBe('web.fetch');
      const aboutUrl = (next?.payload as { urls: string[] }).urls[0] as string;
      const snapshotId = await storeHomepage(null, aboutUrl);
      const aboutResult = await handleWebFetch(
        next as ClaimedJob,
        fetcherDeps(stubFetcher(snapshotId)),
      );
      expect(aboutResult.stored).toBe(1);
      expect(aboutResult.extractsEnqueued).toBe(1);
      // A fallback page does not fan out again: the depth stays at one.
      expect(aboutResult.followUpBasis).toBe('not_eligible');
      expect(aboutResult.followUpsEnqueued).toBe(0);
    });

    it('a 404 homepage enqueues exactly five bounded fallbacks', async () => {
      const { result } = await runTerminal({
        outcome: 'http_error',
        http_status: 404,
        bytes: 90,
        reason: 'http_status_404',
      });
      expect(result.followUpBasis).toBe('terminal_fallback');
      expect(result.followUpsEnqueued).toBe(5);

      const rows = await followUps();
      expect(rows).toHaveLength(5);
      // One per frozen page kind, every URL on the canonical domain, every one
      // a conventional path — no discovery happened and none was invented.
      expect(rows.map((row) => row.payload.page_kind).sort()).toStrictEqual(
        [...FOLLOW_UP_KINDS].sort(),
      );
      expect(rows.map((row) => row.payload.urls[0]).sort()).toStrictEqual(
        FOLLOW_UP_KINDS.map((kind) => `https://${DOMAIN}${PAGE_PATHS[kind]}`).sort(),
      );
      for (const row of rows) {
        expect(row.payload.page_source).toBe('fallback');
        expect(row.payload.urls).toHaveLength(1);
        expect(new URL(row.payload.urls[0] as string).hostname).toBe(DOMAIN);
      }
    });

    it('a 401 and a 429 behave the same way, and neither is worked around', async () => {
      for (const status of [401, 429]) {
        const { result } = await runTerminal({
          outcome: 'http_error',
          http_status: status,
          bytes: 100,
          reason: `http_status_${status}`,
        });
        expect(result.followUpsEnqueued, String(status)).toBe(5);
        // The homepage itself is never asked again: the job succeeds.
        expect(result.httpError).toBe(1);
        await db.resetQueue();
        await db.adminPool.query('TRUNCATE web_snapshots CASCADE');
      }
    });

    it('a robots Disallow falls back, bounded at five, with no fetch of the root', async () => {
      const job = await claimHomeJob();
      const result = await handleWebFetch(
        job,
        fetcherDeps(
          stubReply({ outcome: 'robots_disallowed', robots_allowed: false, reason: 'robots_disallowed' }),
        ),
      );
      expect(result.robotsDisallowed).toBe(1);
      expect(result.followUpBasis).toBe('terminal_fallback');
      expect(result.followUpsEnqueued).toBe(5);
      expect(await followUps()).toHaveLength(5);
      // Bounded: five, not five per kind, and not one per candidate.
      expect(result.followUpsDiscovered).toBe(0);
    });

    it('a guarded refusal waits for its retries, then falls back once', async () => {
      // A guard refusal is retryable (§6), so fanning out while an attempt
      // remains would be unsound: the retry could store the homepage, discovery
      // would run, and the discovered URLs would be *added* to five fallbacks
      // already queued. Eleven pages for one firm.
      const pending = await claimHomeJob('home', 3);
      await expect(
        handleWebFetch(
          pending,
          fetcherDeps(stubReply({ outcome: 'refused', robots_allowed: false, reason: 'blocked_address' })),
        ),
      ).rejects.toThrow(/no page could be fetched/);
      expect(await followUps()).toHaveLength(0);

      // On the last attempt no later attempt can discover anything, so the
      // fallbacks go out — and the job still fails, so it goes dead, not green.
      const last = await claimHomeJob('home', 1);
      expect(last.attempts).toBe(last.max_attempts);
      await expect(
        handleWebFetch(
          last,
          fetcherDeps(stubReply({ outcome: 'refused', robots_allowed: false, reason: 'blocked_address' })),
        ),
      ).rejects.toThrow(/no page could be fetched/);
      expect(await followUps()).toHaveLength(5);
    });

    it('a 5xx never falls back: §6’s retry is the answer to no answer', async () => {
      const job = await claimHomeJob('home', 1);
      await expect(
        handleWebFetch(
          job,
          fetcherDeps(
            stubReply({
              outcome: 'http_unavailable',
              http_status: 503,
              robots_allowed: true,
              final_url: HOME,
              reason: 'http_status_503',
            }),
          ),
        ),
      ).rejects.toThrow(/no page could be fetched/);
      // Asking five more URLs of a server returning 503s is load, not fallback.
      expect(await followUps()).toHaveLength(0);
    });

    it('is idempotent: a replayed terminal homepage enqueues nothing new', async () => {
      const job = await claimHomeJob();
      const deps = fetcherDeps(
        terminal({ outcome: 'http_error', http_status: 403, bytes: 120, reason: 'http_status_403' }),
      );
      expect((await handleWebFetch(job, deps)).followUpsEnqueued).toBe(5);
      // Same company, same five URLs, same occurrence: every §7 key collides.
      expect((await handleWebFetch(job, deps)).followUpsEnqueued).toBe(0);
      expect(await followUps()).toHaveLength(5);
    });

    it('never exceeds six pages for the firm, on any homepage outcome', async () => {
      for (const body of [
        { outcome: 'http_error', http_status: 403, bytes: 1, reason: 'http_status_403' },
        { outcome: 'http_error', http_status: 404, bytes: 1, reason: 'http_status_404' },
        { outcome: 'robots_disallowed', robots_allowed: false, reason: 'robots_disallowed' },
      ]) {
        const job = await claimHomeJob();
        await handleWebFetch(job, fetcherDeps(terminal(body)));
        const { rows } = await app.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM jobs WHERE kind = 'web.fetch'`,
        );
        // The seeded homepage job plus five follow-ups.
        expect(rows[0]?.count, JSON.stringify(body)).toBe('6');
        await db.resetQueue();
        await db.adminPool.query('TRUNCATE web_snapshots CASCADE');
      }
    });

    it('cannot reach eleven pages when a refusal is followed by a success', async () => {
      // The unsoundness the retry_pending rule exists to prevent, driven end to
      // end: refuse on the first attempt, succeed on the last.
      const first = await claimHomeJob('home', 2);
      await expect(
        handleWebFetch(
          first,
          fetcherDeps(stubReply({ outcome: 'refused', robots_allowed: false, reason: 'blocked_address' })),
        ),
      ).rejects.toThrow();
      expect(await followUps()).toHaveLength(0);

      // The retry stores the homepage, and discovery runs for the first time.
      const snapshotId = await storeHomepage(
        harvest([{ kind: 'about', url: `https://${DOMAIN}/about-us` }]),
      );
      await db.adminPool.query(
        `UPDATE jobs SET status = 'queued', run_after = now() WHERE id = $1`,
        [first.id],
      );
      const retried = await claimJob(app, 'w-retry');
      const result = await handleWebFetch(retried as ClaimedJob, fetcherDeps(stubFetcher(snapshotId)));

      expect(result.followUpBasis).toBe('homepage_read');
      expect(result.followUpsEnqueued).toBe(5);
      expect(result.followUpsDiscovered).toBe(1);

      const { rows } = await app.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE kind = 'web.fetch'`,
      );
      expect(rows[0]?.count).toBe('6');
    });
  });

  // ------------------------------------------------- the parked-domain guard
  describe('an off-domain homepage is not authoritative, in either direction', () => {
    it('does not fan out when a 2xx homepage redirected off the firm’s domain', async () => {
      // The snapshot is already ineligible for extraction (off_domain_final_url
      // in src/pipeline/evidence.ts). §10 calls this parked, and a parked domain
      // does not get to nominate pages — nor does it earn five guesses at the
      // domain it left.
      const snapshotId = await storeHomepage(
        harvest([{ kind: 'about', url: 'https://parked-domains.example/about' }]),
        'https://parked-domains.example/',
      );
      const job = await claimHomeJob();
      const result = await handleWebFetch(
        job,
        fetcherDeps(
          stubReply({
            outcome: 'stored',
            snapshot_id: snapshotId,
            http_status: 200,
            content_hash: 'c'.repeat(64),
            bytes: 2048,
            text_length: 2000,
            robots_allowed: true,
            final_url: 'https://parked-domains.example/',
          }),
        ),
      );
      expect(result.followUpBasis).toBe('off_domain');
      expect(result.followUpsEnqueued).toBe(0);
      expect(await followUps()).toHaveLength(0);
    });

    it('does not fan out when a terminal homepage answered from another domain', async () => {
      const job = await claimHomeJob();
      const result = await handleWebFetch(
        job,
        fetcherDeps(
          stubReply({
            outcome: 'http_error',
            http_status: 404,
            bytes: 80,
            robots_allowed: true,
            final_url: 'https://parked-domains.example/',
            reason: 'http_status_404',
          }),
        ),
      );
      expect(result.followUpBasis).toBe('off_domain');
      expect(await followUps()).toHaveLength(0);
    });

    it('treats a lookalike redirect target as off-domain', async () => {
      for (const finalUrl of [
        `https://${DOMAIN}.attacker.tld/`,
        'https://example-legаl.com.au/',
        'https://203.0.113.10/',
      ]) {
        const job = await claimHomeJob();
        const result = await handleWebFetch(
          job,
          fetcherDeps(
            stubReply({
              outcome: 'http_error',
              http_status: 404,
              bytes: 80,
              robots_allowed: true,
              final_url: finalUrl,
              reason: 'http_status_404',
            }),
          ),
        );
        expect(result.followUpBasis, finalUrl).toBe('off_domain');
        await db.resetQueue();
      }
    });

    it('still fans out for a legitimate subdomain redirect', async () => {
      const job = await claimHomeJob();
      const result = await handleWebFetch(
        job,
        fetcherDeps(
          stubReply({
            outcome: 'http_error',
            http_status: 403,
            bytes: 80,
            robots_allowed: true,
            final_url: `https://www.${DOMAIN}/`,
            reason: 'http_status_403',
          }),
        ),
      );
      expect(result.followUpBasis).toBe('terminal_fallback');
      expect(result.followUpsEnqueued).toBe(5);
      for (const row of await followUps()) {
        expect(new URL(row.payload.urls[0] as string).hostname).toBe(DOMAIN);
      }
    });
  });

  // ------------------------------------------------------- the worker boundary
  describe('no markup and no unfiltered link set crosses the boundary', () => {
    it('is structurally impossible for the fetch reply to carry links', () => {
      // The response schema is .strict(), so a field carrying markup or a link
      // list could not be added on one side without the other refusing it.
      const valid = {
        outcome: 'stored',
        snapshot_id: '00000000-0000-4000-8000-000000000001',
        robots_allowed: true,
        trace_id: TRACE,
      };
      expect(fetchResponseSchema.safeParse(valid).success).toBe(true);
      for (const extra of ['page_links', 'links', 'html', 'body', 'candidates', 'anchors']) {
        expect(
          fetchResponseSchema.safeParse({ ...valid, [extra]: ['https://x.example/'] }).success,
          extra,
        ).toBe(false);
      }
    });

    it('returns counts to the handler’s caller, never URLs', async () => {
      const { result } = await runHome(
        harvest([{ kind: 'about', url: `https://${DOMAIN}/about-us` }]),
      );
      // The handler's own result is numbers and snapshot ids. The chosen URLs
      // live in the jobs it enqueued, in the database.
      expect(JSON.stringify(result)).not.toContain('about-us');
      expect(result.followUpsEnqueued).toBe(5);
      expect(result.followUpsDiscovered).toBe(1);
    });
  });
});
