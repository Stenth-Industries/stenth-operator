import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_HEADER } from '../../src/fetcher/contract';
import { createFetcherServer } from '../../src/fetcher/server';
import { FROZEN_POLICY, type FetchPolicy } from '../../src/fetch/policy';
import { HostPoliteness } from '../../src/fetch/politeness';
import { enqueue } from '../../src/jobs/enqueue';
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

  afterAll(async () => {
    service?.close();
    origin?.close();
    await db?.close();
  });

  function deps() {
    return { fetcherUrl, sharedSecret: SECRET };
  }

  async function claimFetchJob(urls: string[], maxAttempts?: number) {
    await enqueue(app, {
      kind: 'web.fetch',
      dedupeKey: `fetch:${companyId}:${Math.random().toString(36).slice(2)}:2026-10-06`,
      traceId: TRACE,
      payload: { company_id: companyId, urls },
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    });
    const job = await claimJob(app, 'test-worker');
    if (job === undefined) {
      throw new Error('no job claimed');
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
      'extractableSnapshotIds', 'httpError', 'httpUnavailable',
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
      handleWebFetch(job, { fetcherUrl, sharedSecret: 'wrong-secret' }),
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
          fetcherUrl: `http://127.0.0.1:${(liar.address() as AddressInfo).port}`,
          sharedSecret: SECRET,
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
        fetcherUrl: `http://127.0.0.1:${(spy.address() as AddressInfo).port}`,
        sharedSecret: SECRET,
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
