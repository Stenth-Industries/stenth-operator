import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PAGE_LINKS_VERSION } from '../../src/fetch/links';
import { SIGNALS_VERSION } from '../../src/fetch/signals';
import { AUTH_HEADER } from '../../src/fetcher/contract';
import { createFetcherServer } from '../../src/fetcher/server';
import { FROZEN_POLICY, type FetchPolicy } from '../../src/fetch/policy';
import { HostPoliteness } from '../../src/fetch/politeness';
import { EXTRACTION_SCHEMA_VERSION } from '../../src/ai/schemas/extraction-v1';
import { enqueue } from '../../src/jobs/enqueue';
import { dedupeKey } from '../../src/jobs/kinds';
import { claimJob, completeJob, failJob } from '../../src/jobs/queue';
import { handleWebFetch, MAX_PAGES_PER_JOB, webFetchPayloadSchema } from '../../src/worker/handlers/web-fetch';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const SECRET = 'w'.repeat(48);
const TRACE = '01JA2BCDEFGHJKMNPQRSTVWXYZ';
const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the web.fetch handler suite.');
}

describeWithDb('the web.fetch handler: worker to fetcher over the internal network (§6, §8)', () => {
  let db: TestDatabase;
  let app: Pool;
  let companyId: string;
  let origin: Server;
  let originUrl: string;
  let service: Server;
  let fetcherUrl: string;
  /** Every path the origin served, so "did not retry" can be measured. */
  let requests: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');

    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO companies (canonical_domain) VALUES ('example-legal.com.au') RETURNING id`,
    );
    companyId = rows[0]!.id;

    origin = createServer((request, response) => {
      const url = request.url ?? '/';
      requests.push(url);
      const status = /^\/status\/(\d{3})$/.exec(url);
      if (url === '/robots.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('User-agent: *\nDisallow: /private\n');
      } else if (url.startsWith('/private')) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<p>never</p>');
      } else if (status !== null) {
        // A branded error page, because that is what real sites serve.
        response.writeHead(Number(status[1]), { 'content-type': 'text/html' });
        response.end('<html><body><h1>Access Denied</h1><p>HANDLER_ERROR_MARKER</p></body></html>');
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<p>page at ${url}</p>`);
      }
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()));
    const originPort = (origin.address() as AddressInfo).port;
    originUrl = `http://127.0.0.1:${originPort}`;

    const policy: FetchPolicy = {
      ...FROZEN_POLICY,
      permitLoopback: true,
      allowedPorts: [...FROZEN_POLICY.allowedPorts, originPort],
      minHostIntervalMs: 0,
    };

    service = createFetcherServer({
      pool: db.poolAs('operator_fetch'),
      sharedSecret: SECRET,
      policy,
      politeness: new HostPoliteness({ minIntervalMs: 0 }),
    });
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', () => resolve()));
    fetcherUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  }, 120_000);

  afterEach(async () => {
    // Each case claims the next queued job, and web.fetch now leaves
    // web.extract jobs behind it, so the queue is reset between cases. The
    // snapshots stay: several cases read web_snapshots directly.
    await db.resetQueue();
  });

  afterAll(async () => {
    service?.close();
    origin?.close();
    await db?.close();
  });

  function deps() {
    // The pool is required: web.fetch enqueues web.extract per stored snapshot
    // (§6), and a handler that skipped its successor without one would be a
    // pipeline that stops silently.
    return { fetcherUrl, sharedSecret: SECRET, pool: app };
  }

  async function claimFetchJob(urls: string[], maxAttempts?: number) {
    await enqueue(app, {
      kind: 'web.fetch',
      dedupeKey: `fetch:${companyId}:${Math.random().toString(36).slice(2)}:2026-10-06`,
      traceId: TRACE,
      // Claimed ahead of the web.extract jobs this handler now leaves behind:
      // the claim orders by priority DESC, and several cases fetch twice.
      priority: 10,
      payload: { company_id: companyId, urls },
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    });
    const job = await claimJob(app, 'test-worker');
    if (job === undefined) {
      throw new Error('no job claimed');
    }
    // The handler now enqueues web.extract per stored snapshot (§6), so the
    // queue is no longer web.fetch-only and a blind claim could pick one up.
    if (job.kind !== 'web.fetch') {
      throw new Error(`claimed a ${job.kind} job; the queue was not clean`);
    }
    return job;
  }

  it('fetches every page and stores a snapshot for each', async () => {
    const job = await claimFetchJob([`${originUrl}/`, `${originUrl}/about`, `${originUrl}/contact`]);
    const result = await handleWebFetch(job, deps());

    expect(result.stored).toBe(3);
    expect(result.refused).toBe(0);
    expect(result.extractableSnapshotIds).toHaveLength(3);

    const { rows } = await db.adminPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM web_snapshots WHERE company_id = $1 AND robots_allowed',
      [companyId],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('records a robots refusal without fetching the page', async () => {
    const job = await claimFetchJob([`${originUrl}/private/secret`]);
    const result = await handleWebFetch(job, deps());
    expect(result.robotsDisallowed).toBe(1);
    expect(result.stored).toBe(0);
  }, 60_000);

  it('counts a blocked destination as refused and fails the job when nothing lands', async () => {
    // The guard refusing every page is a failed attempt, so the job retries
    // with backoff and eventually goes dead rather than succeeding with nothing.
    const job = await claimFetchJob(['http://169.254.169.254/latest/meta-data/']);
    await expect(handleWebFetch(job, deps())).rejects.toThrow(/no page could be fetched/);
  }, 60_000);

  it('never sends the page body to the worker, only metadata', async () => {
    const job = await claimFetchJob([`${originUrl}/about`]);
    const result = await handleWebFetch(job, deps());
    // The worker learns ids and counts. The text stays in the database, where
    // only the privileged zone can read it.
    expect(JSON.stringify(result)).not.toContain('page at');
    expect(Object.keys(result).sort()).toStrictEqual([
      'extractableSnapshotIds', 'extractsEnqueued', 'followUpBasis',
      'followUpsDiscovered', 'followUpsEnqueued', 'httpError', 'httpUnavailable',
      'refused', 'robotsDisallowed', 'stored',
    ]);
  }, 60_000);

  it('rejects a job whose payload does not match the schema', async () => {
    expect(() => webFetchPayloadSchema.parse({ company_id: 'x', urls: ['u'] })).toThrow();
    expect(() => webFetchPayloadSchema.parse({ company_id: companyId, urls: [] })).toThrow();
    // §10 stage 3: at most six pages.
    expect(() =>
      webFetchPayloadSchema.parse({
        company_id: companyId,
        urls: Array.from({ length: MAX_PAGES_PER_JOB + 1 }, (_u, i) => `http://x/${i}`),
      }),
    ).toThrow();
    // No extra keys: a job cannot hand the fetcher options.
    expect(() =>
      webFetchPayloadSchema.parse({ company_id: companyId, urls: ['http://x/'], proxy: 'http://evil' }),
    ).toThrow();
  });

  it('fails rather than proceeding when the fetcher rejects its credentials', async () => {
    const job = await claimFetchJob([`${originUrl}/about`]);
    await expect(
      handleWebFetch(job, { ...deps(), sharedSecret: 'wrong-secret' }),
    ).rejects.toThrow(/fetcher returned 401/);
  }, 60_000);

  it('does not believe a malformed reply from the fetcher', async () => {
    // The fetcher is the process that handles hostile input, so the worker
    // validates what comes back rather than trusting it.
    const liar = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ outcome: 'stored', snapshot_id: 'not-a-uuid' }));
    });
    await new Promise<void>((resolve) => liar.listen(0, '127.0.0.1', () => resolve()));
    try {
      const job = await claimFetchJob([`${originUrl}/about`]);
      await expect(
        handleWebFetch(job, {
          ...deps(),
          fetcherUrl: `http://127.0.0.1:${(liar.address() as AddressInfo).port}`,
        }),
      ).rejects.toThrow(/failed validation/);
    } finally {
      liar.close();
    }
  }, 60_000);

  it('sends the shared secret on the documented header', async () => {
    let seenHeader: string | undefined;
    const spy = createServer((request, response) => {
      seenHeader = request.headers[AUTH_HEADER] as string | undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ outcome: 'refused', robots_allowed: false, reason: 'x', trace_id: TRACE }));
    });
    await new Promise<void>((resolve) => spy.listen(0, '127.0.0.1', () => resolve()));
    try {
      const job = await claimFetchJob([`${originUrl}/about`]);
      await handleWebFetch(job, {
        ...deps(),
        fetcherUrl: `http://127.0.0.1:${(spy.address() as AddressInfo).port}`,
      }).catch(() => undefined);
      expect(seenHeader).toBe(SECRET);
    } finally {
      spy.close();
    }
  }, 60_000);
  // ------------------------------------------------- terminal vs retryable
  describe('a terminal HTTP error ends the job; a transient one retries (§6, §8)', () => {
    it('counts a 4xx as http_error, not stored, and does not list it as extractable', async () => {
      const job = await claimFetchJob([`${originUrl}/status/403`]);
      const result = await handleWebFetch(job, deps());

      expect(result.httpError).toBe(1);
      expect(result.stored).toBe(0);
      expect(result.refused).toBe(0);
      expect(result.httpUnavailable).toBe(0);
      // The id exists in web_snapshots, and deliberately not here: this list is
      // what Day 4 iterates to enqueue web.extract.
      expect(result.extractableSnapshotIds).toHaveLength(0);
    }, 60_000);

    it('does not throw for an all-4xx job, so the job completes instead of retrying', async () => {
      // Throwing would be a failed attempt, and a failed attempt means two more
      // requests at a site that has already answered 403.
      const job = await claimFetchJob([`${originUrl}/status/404`]);
      await expect(handleWebFetch(job, deps())).resolves.toMatchObject({ httpError: 1 });
    }, 60_000);

    it('a 429 behaves the same way and is never worked around', async () => {
      requests = [];
      const job = await claimFetchJob([`${originUrl}/status/429`]);
      const result = await handleWebFetch(job, deps());
      expect(result.httpError).toBe(1);
      expect(result.extractableSnapshotIds).toHaveLength(0);
      expect(requests.filter((path) => path === '/status/429')).toHaveLength(1);
    }, 60_000);

    it('throws for a 5xx, which is what drives §6 backoff', async () => {
      const job = await claimFetchJob([`${originUrl}/status/503`]);
      await expect(handleWebFetch(job, deps())).rejects.toThrow(/no page could be fetched/);
    }, 60_000);

    it('never lets the error page text reach the worker or the table', async () => {
      const job = await claimFetchJob([`${originUrl}/status/403`]);
      const result = await handleWebFetch(job, deps());
      expect(JSON.stringify(result)).not.toContain('HANDLER_ERROR_MARKER');

      const { rows } = await db.adminPool.query<{ hits: string }>(
        `SELECT count(*) AS hits FROM web_snapshots WHERE text LIKE '%HANDLER_ERROR_MARKER%'`,
      );
      expect(rows[0]?.hits).toBe('0');
    }, 60_000);
  });

  describe('the link harvest reaches the database and nothing else', () => {
    it('is written into web_snapshots.signals by the fetcher, with a version', async () => {
      // End to end through the real fetcher: the harvest is stamped onto the
      // snapshot beside the Tier A scan, in the process that read the markup.
      const job = await claimFetchJob([`${originUrl}/`]);
      const result = await handleWebFetch(job, deps());
      expect(result.stored).toBe(1);

      const { rows } = await db.adminPool.query<{
        links_version: string | null;
        candidates: unknown;
        tier_a: string | null;
      }>(
        `SELECT signals -> 'page_links' ->> 'links_version' AS links_version,
                signals -> 'page_links' -> 'candidates'    AS candidates,
                signals ->> 'signals_version'              AS tier_a
           FROM web_snapshots WHERE id = $1`,
        [result.extractableSnapshotIds[0]],
      );
      expect(rows[0]?.links_version).toBe(PAGE_LINKS_VERSION);
      // The Tier A scan is untouched: one column, two independent reads.
      expect(rows[0]?.tier_a).toBe(SIGNALS_VERSION);

      // This origin is a loopback IP, which has no registrable domain, so
      // nothing on it can be first party to anything. An honest empty harvest,
      // not an error — and the proof that the filter runs inside the fetcher.
      expect(rows[0]?.candidates).toStrictEqual([]);
    }, 60_000);

    it('never returns markup or a link list across the fetch boundary', async () => {
      const job = await claimFetchJob([`${originUrl}/`]);
      const result = await handleWebFetch(job, deps());
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('page at');
      expect(serialised).not.toContain('href');
      expect(serialised).not.toContain('page_links');
      expect(serialised).not.toContain('candidates');
    }, 60_000);
  });

  describe('§6: enqueues web.extract per snapshot', () => {
    async function extractJobs() {
      const { rows } = await app.query<{
        dedupe_key: string;
        payload: Record<string, unknown>;
        parent_job_id: string | null;
      }>(`SELECT dedupe_key, payload, parent_job_id FROM jobs WHERE kind = 'web.extract'`);
      return rows;
    }

    it('enqueues one extract per stored page, keyed by §7’s permanent key', async () => {
      const job = await claimFetchJob([`${originUrl}/`, `${originUrl}/about`]);
      const result = await handleWebFetch(job, deps());
      expect(result.stored).toBe(2);
      expect(result.extractsEnqueued).toBe(2);

      const jobs = await extractJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((row) => row.dedupe_key).sort()).toStrictEqual(
        [...result.extractableSnapshotIds]
          .map((id) => dedupeKey.webExtract(id, EXTRACTION_SCHEMA_VERSION))
          .sort(),
      );
      for (const row of jobs) {
        expect(row.parent_job_id).toBe(job.id);
        expect(Object.keys(row.payload)).toStrictEqual(['snapshot_id']);
      }
    }, 60_000);

    it('enqueues nothing for a page that may never be evidence', async () => {
      // A 4xx row and a robots row both exist with text NULL. Neither is
      // extractable, so neither produces a job that would reserve budget.
      const errorJob = await claimFetchJob([`${originUrl}/status/403`]);
      expect((await handleWebFetch(errorJob, deps())).extractsEnqueued).toBe(0);
      expect(await extractJobs()).toHaveLength(0);

      const robotsJob = await claimFetchJob([`${originUrl}/private/page`]);
      expect((await handleWebFetch(robotsJob, deps())).extractsEnqueued).toBe(0);
      expect(await extractJobs()).toHaveLength(0);
    }, 60_000);

    it('does not enqueue a second time for the same snapshot', async () => {
      // §7's extract key is permanent, so a replayed fetch of unchanged bytes
      // produces the same key and inserts nothing.
      const first = await claimFetchJob([`${originUrl}/about`]);
      expect((await handleWebFetch(first, deps())).extractsEnqueued).toBe(1);

      const second = await claimFetchJob([`${originUrl}/about`]);
      const result = await handleWebFetch(second, deps());
      expect(result.stored).toBe(1);
      expect(result.extractsEnqueued).toBe(0);
      expect(await extractJobs()).toHaveLength(1);
    }, 60_000);
  });

  describe('through the real queue (§6)', () => {
    it('a 403 job succeeds on its first attempt, having asked once', async () => {
      requests = [];
      const job = await claimFetchJob([`${originUrl}/status/403`], 3);
      await handleWebFetch(job, deps());
      await completeJob(app, job);

      const { rows } = await app.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM jobs WHERE id = $1',
        [job.id],
      );
      expect(rows[0]?.status).toBe('succeeded');
      expect(rows[0]?.attempts).toBe(1);
      expect(requests.filter((path) => path === '/status/403')).toHaveLength(1);
    }, 60_000);

    it('retries the 5xx page without ever asking the 4xx page again (Day 5)', async () => {
      // This is ops/day3-acceptance/findings.md's "Known residual, bounded and
      // deliberate", closed. The residual was a single job carrying both URLs:
      // the 5xx made the job fail, the retry re-ran the whole payload, and the
      // 404 — which had already given its final answer — was requested again.
      //
      // The fix is structural rather than a change to the retry rules: since
      // company.resolve fans out one job per page (§7's key is per URL), the
      // two pages have separate jobs and separate attempt budgets. Nothing
      // about terminal-vs-retryable moved.
      requests = [];
      const terminal = await claimFetchJob([`${originUrl}/status/404`], 3);
      await handleWebFetch(terminal, deps());
      await completeJob(app, terminal);

      let transient = await claimFetchJob([`${originUrl}/status/503`], 2);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const failure = await handleWebFetch(transient, deps()).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        const outcome = await failJob(app, transient, failure);
        if (outcome.status === 'dead') {
          break;
        }
        await db.adminPool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [transient.id]);
        const next = await claimJob(app, 'test-worker');
        if (next === undefined) {
          throw new Error('the job did not return to the queue');
        }
        transient = next;
      }

      // The 503 was asked once per attempt, as §6 intends.
      expect(requests.filter((path) => path === '/status/503')).toHaveLength(2);
      // The 404 was asked exactly once, in total, ever. That is the residual.
      expect(requests.filter((path) => path === '/status/404')).toHaveLength(1);

      const rows = await app.query<{ id: string; status: string; attempts: number }>(
        'SELECT id, status::text AS status, attempts FROM jobs WHERE id = ANY($1::uuid[])',
        [[terminal.id, transient.id]],
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      // One page answered and is finished; the other exhausted its own budget.
      expect(byId.get(terminal.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(byId.get(transient.id)).toMatchObject({ status: 'dead', attempts: 2 });
    }, 120_000);

    it('a 503 job exhausts its budget and goes dead, asking once per attempt', async () => {
      requests = [];
      let job = await claimFetchJob([`${originUrl}/status/503`], 2);

      const outcomes: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const failure = await handleWebFetch(job, deps()).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        const result = await failJob(app, job, failure);
        outcomes.push(result.status);

        if (result.status === 'dead') {
          break;
        }
        // Backoff is min(60 * 2^attempts, 3600) seconds, so the next attempt is
        // not claimable for at least two minutes. Standing in for the passage
        // of time is the only way to exercise the budget in a test.
        await db.adminPool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [job.id]);
        const next = await claimJob(app, 'test-worker');
        if (next === undefined) {
          throw new Error('the job did not return to the queue');
        }
        job = next;
      }

      expect(outcomes).toStrictEqual(['queued', 'dead']);

      const { rows } = await app.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM jobs WHERE id = $1',
        [job.id],
      );
      expect(rows[0]?.status).toBe('dead');
      expect(rows[0]?.attempts).toBe(2);
      // Two attempts, two requests: bounded, not a loop.
      expect(requests.filter((path) => path === '/status/503')).toHaveLength(2);

      // And nothing was stored for it, at any attempt.
      const stored = await db.adminPool.query<{ hits: string }>(
        'SELECT count(*) AS hits FROM web_snapshots WHERE company_id = $1 AND http_status = 503',
        [companyId],
      );
      expect(stored.rows[0]?.hits).toBe('0');
    }, 120_000);
  });
});
