import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_HEADER } from '../../src/fetcher/contract';
import { createFetcherServer } from '../../src/fetcher/server';
import { FROZEN_POLICY, type FetchPolicy } from '../../src/fetch/policy';
import { HostPoliteness } from '../../src/fetch/politeness';
import { enqueue } from '../../src/jobs/enqueue';
import { claimJob } from '../../src/jobs/queue';
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

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');

    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO companies (canonical_domain) VALUES ('example-legal.com.au') RETURNING id`,
    );
    companyId = rows[0]!.id;

    origin = createServer((request, response) => {
      const url = request.url ?? '/';
      if (url === '/robots.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('User-agent: *\nDisallow: /private\n');
      } else if (url.startsWith('/private')) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<p>never</p>');
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

  async function claimFetchJob(urls: string[]) {
    await enqueue(app, {
      kind: 'web.fetch',
      dedupeKey: `fetch:${companyId}:${Math.random().toString(36).slice(2)}:2026-10-06`,
      traceId: TRACE,
      payload: { company_id: companyId, urls },
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
    expect(result.snapshotIds).toHaveLength(3);

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
    await expect(handleWebFetch(job, deps())).rejects.toThrow(/every page was refused/);
  }, 60_000);

  it('never sends the page body to the worker, only metadata', async () => {
    const job = await claimFetchJob([`${originUrl}/about`]);
    const result = await handleWebFetch(job, deps());
    // The worker learns ids and counts. The text stays in the database, where
    // only the privileged zone can read it.
    expect(JSON.stringify(result)).not.toContain('page at');
    expect(Object.keys(result).sort()).toStrictEqual([
      'refused', 'robotsDisallowed', 'snapshotIds', 'stored',
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
});
