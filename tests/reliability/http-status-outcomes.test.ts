/**
 * HTTP status handling: what becomes evidence, and what is retried.
 *
 * The bug this suite exists for was live in production on 2026-10-07. A 403
 * from Doogue + George was stored as a snapshot with `robots_allowed = true`
 * and the error page's own prose in `text`, and the job was marked succeeded.
 * Nothing downstream could tell it from a page we had actually read — and §9's
 * Tier A signals are all *absent* from an error page, which is exactly what
 * §10's Visible execution gap dimension, the largest of the five, pays for. A
 * firm that blocked us would have scored like a strong prospect on no evidence.
 *
 * So the assertions here are about the trust boundary, not about tidiness:
 *
 *   4xx  the site answered, and the answer is no. Terminal — one request, no
 *        retry — recorded with text NULL, and never extractable.
 *   5xx  no answer was given. Retryable within §6's budget, then dead. No row.
 *   2xx  unchanged: text stored, extractable.
 *
 * Three independent layers have to hold, because any one of them could be
 * undone by a future change: the handler never lists a non-2xx snapshot as
 * extractable, the row's text is NULL, and the database refuses a text-bearing
 * non-2xx row outright (migration 005).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchResponseSchema } from '../../src/fetcher/contract';
import { fetchAndStore } from '../../src/fetcher/server';
import { FROZEN_POLICY, type FetchPolicy } from '../../src/fetch/policy';
import { HostPoliteness } from '../../src/fetch/politeness';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const TRACE = '01JA2BCDEFGHJKMNPQRSTVWXYZ';
const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the HTTP status suite.');
}

/**
 * A realistic error page: real sites serve branded HTML with a 403, not an
 * empty body. The marker and the fake Tier A tag are what must never land.
 */
const ERROR_PAGE = [
  '<!doctype html><html><body>',
  '<h1>Access Denied</h1>',
  '<p>FORBIDDEN_MARKER_DO_NOT_PERSIST</p>',
  '<script>gtag("config", "AW-99999999")</script>',
  '</body></html>',
].join('');

const GOOD_PAGE = '<!doctype html><html><body><p>Example Legal, Melbourne. Real content.</p></body></html>';

describeWithDb('HTTP status decides whether a fetch is evidence (§8, §9, §10)', () => {
  let db: TestDatabase;
  let fetchPool: Pool;
  let companyId: string;
  let origin: Server;
  let originUrl: string;
  let policy: FetchPolicy;
  /** Every path the origin served, so "did not retry" is measurable. */
  let requests: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    fetchPool = db.poolAs('operator_fetch');

    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO companies (canonical_domain) VALUES ('status-example.com.au') RETURNING id`,
    );
    companyId = rows[0]!.id;

    origin = createServer((request, response) => {
      const url = request.url ?? '/';
      requests.push(url);

      if (url === '/robots.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('User-agent: *\nDisallow: /private\n');
        return;
      }
      if (url === '/ok') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(GOOD_PAGE);
        return;
      }
      if (url.startsWith('/private')) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<p>never fetched</p>');
        return;
      }

      const match = /^\/status\/(\d{3})$/.exec(url);
      if (match !== null) {
        response.writeHead(Number(match[1]), { 'content-type': 'text/html' });
        response.end(ERROR_PAGE);
        return;
      }

      response.writeHead(404, { 'content-type': 'text/html' });
      response.end(ERROR_PAGE);
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()));
    const port = (origin.address() as AddressInfo).port;
    originUrl = `http://127.0.0.1:${port}`;
    policy = {
      ...FROZEN_POLICY,
      permitLoopback: true,
      allowedPorts: [...FROZEN_POLICY.allowedPorts, port],
      minHostIntervalMs: 0,
    };
  }, 120_000);

  afterAll(async () => {
    origin?.close();
    await db?.close();
  });

  function deps() {
    return {
      pool: fetchPool,
      sharedSecret: 's'.repeat(48),
      policy,
      politeness: new HostPoliteness({ minIntervalMs: 0 }),
    };
  }

  function fetchStatus(code: number) {
    return fetchAndStore(deps(), {
      companyId,
      url: `${originUrl}/status/${code}`,
      traceId: TRACE,
    });
  }

  // ------------------------------------------------------------------- 4xx
  describe.each([401, 403, 404, 429])('a %i is terminal and is not evidence', (code) => {
    it('returns http_error with a machine reason and no content fields', async () => {
      const result = await fetchStatus(code);

      expect(result.outcome).toBe('http_error');
      expect(result.http_status).toBe(code);
      expect(result.reason).toBe(`http_status_${code}`);
      // Diagnostics are allowed; content is not.
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.text_length).toBeUndefined();
      expect(result.content_hash).toBeUndefined();
      // And the reply still satisfies the contract, which now refuses a
      // non-stored outcome that claims to describe content at all.
      expect(fetchResponseSchema.safeParse(result).success).toBe(true);
    });

    it('stores the diagnostic row with text NULL', async () => {
      const result = await fetchStatus(code);
      expect(result.snapshot_id).toBeDefined();

      const { rows } = await db.adminPool.query<{
        text: string | null;
        http_status: number;
        bytes: number;
        url: string;
        robots_allowed: boolean;
      }>(
        'SELECT text, http_status, bytes, url, robots_allowed FROM web_snapshots WHERE id = $1',
        [result.snapshot_id],
      );
      expect(rows[0]?.text).toBeNull();
      expect(rows[0]?.http_status).toBe(code);
      expect(rows[0]?.bytes).toBeGreaterThan(0);
      expect(rows[0]?.url).toBe(`${originUrl}/status/${code}`);
      expect(rows[0]?.robots_allowed).toBe(true);
    });

    it('never persists the error page body anywhere in the table', async () => {
      await fetchStatus(code);
      const { rows } = await db.adminPool.query<{ hits: string }>(
        `SELECT count(*) AS hits FROM web_snapshots
          WHERE text LIKE '%FORBIDDEN_MARKER_DO_NOT_PERSIST%'
             OR text LIKE '%AW-99999999%'`,
      );
      expect(rows[0]?.hits).toBe('0');
    });

    it('is excluded from usable_snapshots, which is what later analysis reads', async () => {
      const result = await fetchStatus(code);
      const { rows } = await db.adminPool.query<{ hits: string }>(
        'SELECT count(*) AS hits FROM usable_snapshots WHERE id = $1',
        [result.snapshot_id],
      );
      expect(rows[0]?.hits).toBe('0');
    });

    it('asks the site exactly once, however many times the fetch is attempted', async () => {
      // "Does not blindly retry" has to be measured at the socket, not inferred
      // from a return value: the point is that the site is not asked again.
      requests = [];
      await fetchStatus(code);
      const asked = requests.filter((path) => path === `/status/${code}`);
      expect(asked).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------- 5xx
  describe.each([500, 503])('a %i is retryable and stores nothing', (code) => {
    it('returns http_unavailable, not http_error and not stored', async () => {
      const result = await fetchStatus(code);
      expect(result.outcome).toBe('http_unavailable');
      expect(result.http_status).toBe(code);
      expect(result.reason).toBe(`http_status_${code}`);
      expect(result.text_length).toBeUndefined();
      expect(result.content_hash).toBeUndefined();
      expect(fetchResponseSchema.safeParse(result).success).toBe(true);
    });

    it('writes no snapshot row at all: a row records a decision that is final', async () => {
      const result = await fetchStatus(code);
      expect(result.snapshot_id).toBeUndefined();

      const { rows } = await db.adminPool.query<{ hits: string }>(
        'SELECT count(*) AS hits FROM web_snapshots WHERE company_id = $1 AND http_status = $2',
        [companyId, code],
      );
      expect(rows[0]?.hits).toBe('0');
    });
  });

  // ------------------------------------------------------------------- 2xx
  describe('a 2xx is unchanged', () => {
    it('stores the text and reports it as stored', async () => {
      const result = await fetchAndStore(deps(), {
        companyId,
        url: `${originUrl}/ok`,
        traceId: TRACE,
      });

      expect(result.outcome).toBe('stored');
      expect(result.http_status).toBe(200);
      expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.text_length).toBeGreaterThan(0);

      const { rows } = await db.adminPool.query<{ text: string | null }>(
        'SELECT text FROM web_snapshots WHERE id = $1',
        [result.snapshot_id],
      );
      expect(rows[0]?.text).toContain('Example Legal, Melbourne');
    });

    it('is the only kind of row usable_snapshots exposes', async () => {
      const result = await fetchAndStore(deps(), {
        companyId,
        url: `${originUrl}/ok`,
        traceId: TRACE,
      });
      const { rows } = await db.adminPool.query<{ hits: string }>(
        'SELECT count(*) AS hits FROM usable_snapshots WHERE id = $1',
        [result.snapshot_id],
      );
      expect(rows[0]?.hits).toBe('1');
    });
  });

  // ---------------------------------------------------------------- robots
  describe('robots behaviour is unchanged (§8)', () => {
    it('still records a disallow as a text-free row with robots_allowed = false', async () => {
      const result = await fetchAndStore(deps(), {
        companyId,
        url: `${originUrl}/private/secret`,
        traceId: TRACE,
      });

      expect(result.outcome).toBe('robots_disallowed');
      expect(result.robots_allowed).toBe(false);
      expect(result.snapshot_id).toBeDefined();

      const { rows } = await db.adminPool.query<{
        text: string | null;
        robots_allowed: boolean;
        http_status: number | null;
      }>('SELECT text, robots_allowed, http_status FROM web_snapshots WHERE id = $1', [
        result.snapshot_id,
      ]);
      expect(rows[0]?.text).toBeNull();
      expect(rows[0]?.robots_allowed).toBe(false);
      expect(rows[0]?.http_status).toBeNull();
    });

    it('does not fetch the disallowed page', async () => {
      requests = [];
      await fetchAndStore(deps(), {
        companyId,
        url: `${originUrl}/private/other`,
        traceId: TRACE,
      });
      expect(requests).not.toContain('/private/other');
    });

    it('is excluded from usable_snapshots, having no text', async () => {
      const result = await fetchAndStore(deps(), {
        companyId,
        url: `${originUrl}/private/secret`,
        traceId: TRACE,
      });
      const { rows } = await db.adminPool.query<{ hits: string }>(
        'SELECT count(*) AS hits FROM usable_snapshots WHERE id = $1',
        [result.snapshot_id],
      );
      expect(rows[0]?.hits).toBe('0');
    });
  });

  // ------------------------------------------------------- the database layer
  describe('migration 005 makes bad evidence impossible to write (§1)', () => {
    it('refuses a text-bearing non-2xx row, whoever writes it', async () => {
      // Not a hypothetical: this is the row shape the fetcher used to produce.
      // The constraint is the layer that survives a future code change.
      await expect(
        db.adminPool.query(
          `INSERT INTO web_snapshots
             (company_id, url, http_status, content_hash, text, robots_allowed)
           VALUES ($1, 'https://status-example.com.au/blocked', 403, 'deadbeef',
                   'Access Denied', true)`,
          [companyId],
        ),
      ).rejects.toThrow(/web_snapshots_text_requires_2xx/);
    });

    it('refuses it for the fetcher role too, which is the role that writes', async () => {
      await expect(
        fetchPool.query(
          `INSERT INTO web_snapshots
             (company_id, url, http_status, content_hash, text, robots_allowed)
           VALUES ($1, 'https://status-example.com.au/blocked2', 404, 'cafe',
                   'Not Found', true)`,
          [companyId],
        ),
      ).rejects.toThrow(/web_snapshots_text_requires_2xx/);
    });

    it('still permits the two text-free shapes the pipeline needs', async () => {
      // A robots decision, and a snapshot whose text maintenance.prune removed.
      await db.adminPool.query(
        `INSERT INTO web_snapshots
           (company_id, url, http_status, content_hash, text, robots_allowed)
         VALUES ($1, 'https://status-example.com.au/robots-case', NULL, 'h1', NULL, false),
                ($1, 'https://status-example.com.au/pruned-case', 200, 'h2', NULL, true)`,
        [companyId],
      );
    });

    it('keeps the fetcher role out of the view, which exposes text', async () => {
      // A view runs with its owner's privileges, so granting it to the fetcher
      // would hand back the page text migration 004 withheld column by column.
      await expect(fetchPool.query('SELECT text FROM usable_snapshots LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
