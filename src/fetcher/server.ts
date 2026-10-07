/**
 * The fetcher service (SPEC.md §8, §19, §20).
 *
 * One process, one endpoint, one job: take a URL from the worker over the
 * internal Docker network, apply every control in §8, and insert the snapshot
 * with its own narrow role.
 *
 * What it does not have is the point of it: no model API key, no mail
 * credential of any kind, no general application database role, no scheduler
 * role, and no published host port. Its database role can insert a snapshot and
 * maintain the robots cache — it cannot even read back the text it just stored,
 * let alone a contact or a draft. That is the entire blast radius of a
 * compromise in the one process that touches hostile input.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Pool } from 'pg';

import { getConfig } from '../config';
import { createPool } from '../db/client';
import { assertAllowedUrl, guardedFetch, FetchRefused } from '../fetch/http';
import { htmlToText, plainToText } from '../fetch/html-to-text';
import { HostPoliteness } from '../fetch/politeness';
import { FROZEN_POLICY, type FetchPolicy } from '../fetch/policy';
import { decide, parseRobots, RobotsCache } from '../fetch/robots';
import { getLogger, withTrace } from '../obs/log';
import { adoptTraceId } from '../obs/trace';
import {
  AUTH_HEADER,
  fetchRequestSchema,
  type FetchResponse,
} from './contract';

/** Request bodies are tiny; anything larger is not one of ours. */
const MAX_REQUEST_BYTES = 8 * 1024;

export interface FetcherDeps {
  readonly pool: Pool;
  readonly sharedSecret: string;
  readonly policy?: FetchPolicy;
  readonly politeness?: HostPoliteness;
  readonly now?: () => Date;
}

/** Constant-time comparison, so a wrong secret leaks nothing by timing. */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) {
    return false;
  }
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/**
 * Performs one fetch and stores the snapshot.
 *
 * Exported so the suite can drive the whole pipeline — robots, guard, extract,
 * store — without an HTTP layer in the way.
 */
export async function fetchAndStore(
  deps: FetcherDeps,
  input: { companyId: string; url: string; traceId: string },
): Promise<FetchResponse> {
  const policy = deps.policy ?? FROZEN_POLICY;
  const now = deps.now ?? (() => new Date());
  const politeness =
    deps.politeness ?? new HostPoliteness({ minIntervalMs: policy.minHostIntervalMs });
  const log = withTrace(input.traceId);

  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return {
      outcome: 'refused',
      robots_allowed: false,
      reason: 'invalid_url',
      trace_id: input.traceId,
    };
  }

  // The target's shape is judged before anything else happens. Without this,
  // a page on a forbidden port or scheme would first send us to fetch its
  // robots.txt on that same port, and the refusal would be reported against
  // robots rather than against the page — and a cache row would be written for
  // a host we never reached.
  try {
    assertAllowedUrl(target, policy);
  } catch (error) {
    if (error instanceof FetchRefused) {
      log.warn({ refusal: error.refusal, url: target.href }, 'target refused by the guard');
      return {
        outcome: 'refused',
        robots_allowed: false,
        reason: error.refusal,
        trace_id: input.traceId,
      };
    }
    throw error;
  }

  const robotsCache = new RobotsCache(deps.pool, policy.robotsTtlMs);

  // --- robots.txt, cached 24h (§8) ---
  let robotsBody: string | undefined;
  let crawlDelaySeconds: number | undefined;

  const cached = await robotsCache.read(target.hostname, now());
  if (cached !== undefined) {
    robotsBody = cached.body;
    crawlDelaySeconds = cached.crawlDelaySeconds;
  } else {
    const robotsUrl = `${target.protocol}//${target.host}/robots.txt`;
    await politeness.waitForTurn(target.hostname);

    /**
     * Three outcomes, and they are not the same thing (§8, §15).
     *
     *   2xx          obey what it says, and cache it for 24h.
     *   4xx          there is no robots.txt, which permits everything. Cache
     *                that too: it is a real answer.
     *   anything else — 5xx, a timeout, a refused connection — is not an
     *                answer at all. Treating it as "allow everything" would
     *                cache permission we were never given, for a day, on the
     *                strength of one failed request. So the page is skipped
     *                and nothing is cached; the job's own retry budget tries
     *                again later.
     */
    let unavailable: string | undefined;
    try {
      const fetched = await guardedFetch(robotsUrl, policy);
      if (fetched.httpStatus >= 200 && fetched.httpStatus < 300) {
        robotsBody = fetched.body;
      } else if (fetched.httpStatus >= 400 && fetched.httpStatus < 500) {
        robotsBody = '';
      } else {
        unavailable = `robots_http_${fetched.httpStatus}`;
      }
    } catch (error) {
      if (error instanceof FetchRefused) {
        // The guard refusing the host for robots means it refuses it for a
        // page too.
        if (error.refusal === 'address_blocked') {
          log.warn(
            { host: target.hostname, refusal: error.refusal },
            'robots fetch refused by the guard',
          );
          return {
            outcome: 'refused',
            robots_allowed: false,
            reason: error.refusal,
            trace_id: input.traceId,
          };
        }
        unavailable = `robots_${error.refusal}`;
      } else {
        unavailable = 'robots_unavailable';
      }
    }

    if (unavailable !== undefined || robotsBody === undefined) {
      log.warn(
        { host: target.hostname, reason: unavailable ?? 'robots_unavailable' },
        'robots.txt could not be read; skipping rather than assuming permission',
      );
      return {
        outcome: 'refused',
        robots_allowed: false,
        reason: unavailable ?? 'robots_unavailable',
        trace_id: input.traceId,
      };
    }

    const parsed = parseRobots(robotsBody);
    crawlDelaySeconds = parsed.groups.find((g) => g.crawlDelaySeconds !== undefined)
      ?.crawlDelaySeconds;
    await robotsCache.write(target.hostname, robotsBody, crawlDelaySeconds, now());
  }

  const robots = decide(parseRobots(robotsBody), `${target.pathname}${target.search}`, policy.userAgent);

  if (!robots.allowed) {
    // "disallow means skip, recorded as robots_allowed = false" (§8). The row
    // is written so the audit trail shows the decision rather than asserting it
    // (§15) — with no text, because nothing was fetched.
    const snapshotId = await storeSnapshot(deps.pool, {
      companyId: input.companyId,
      url: target.href,
      httpStatus: undefined,
      contentHash: hashOf(''),
      text: undefined,
      bytes: undefined,
      robotsAllowed: false,
      traceId: input.traceId,
    });
    log.info(
      { host: target.hostname, matched_rule: robots.matchedRule },
      'robots.txt disallows this path; not fetched',
    );
    return {
      outcome: 'robots_disallowed',
      robots_allowed: false,
      ...(snapshotId === undefined ? {} : { snapshot_id: snapshotId }),
      reason: 'robots_disallowed',
      trace_id: input.traceId,
    };
  }

  // --- the fetch itself ---
  await politeness.waitForTurn(target.hostname, robots.crawlDelaySeconds ?? crawlDelaySeconds);

  let outcome;
  try {
    outcome = await guardedFetch(target.href, policy);
  } catch (error) {
    if (error instanceof FetchRefused) {
      log.warn(
        { refusal: error.refusal, url: error.url },
        'fetch refused by the guard',
      );
      return {
        outcome: 'refused',
        robots_allowed: true,
        reason: error.refusal,
        trace_id: input.traceId,
      };
    }
    throw error;
  }

  // --- what came back decides whether it is evidence at all ---
  //
  // §9's Tier A signals are observations of the firm's own public site, read
  // out of stored HTML by code. An error page is not that site, and every Tier
  // A signal is absent from it — which is exactly what §10's Visible execution
  // gap dimension, the largest of the five, pays for. Scored against a 403 a
  // blocked firm would come out looking like a strong prospect, on no evidence
  // at all. So a non-2xx response never becomes text, here, before anything
  // downstream has a chance to read it.
  const statusClass = classifyStatus(outcome.httpStatus);

  if (statusClass === 'client_error') {
    // 4xx: the site answered, and the answer is no. Terminal.
    //
    // The row is kept for the audit trail and for the acceptance report — §8
    // already writes a text-free row to record the robots decision, and this is
    // the same idea for a second kind of refusal. `text` is NULL, so no later
    // stage can mistake it for a page we read, and migration 005 makes that a
    // database constraint rather than a promise.
    const snapshotId = await storeSnapshot(deps.pool, {
      companyId: input.companyId,
      url: outcome.finalUrl,
      httpStatus: outcome.httpStatus,
      contentHash: statusSentinelHash(outcome.httpStatus),
      text: undefined,
      bytes: outcome.bytes,
      robotsAllowed: true,
      traceId: input.traceId,
    });
    log.warn(
      { url: outcome.finalUrl, http_status: outcome.httpStatus, bytes: outcome.bytes },
      'the site refused the page; recorded with no text and not retried',
    );
    return {
      outcome: 'http_error',
      http_status: outcome.httpStatus,
      bytes: outcome.bytes,
      robots_allowed: true,
      final_url: outcome.finalUrl,
      ...(snapshotId === undefined ? {} : { snapshot_id: snapshotId }),
      reason: `http_status_${outcome.httpStatus}`,
      trace_id: input.traceId,
    };
  }

  if (statusClass === 'unavailable') {
    // 5xx, and anything else that is neither 2xx nor 4xx: no answer was given.
    // No row — a snapshot row records a decision that is final, and this one is
    // not — and the job's §6 retry budget decides whether to ask again.
    log.warn(
      { url: outcome.finalUrl, http_status: outcome.httpStatus },
      'the site gave no answer; the job may try again',
    );
    return {
      outcome: 'http_unavailable',
      http_status: outcome.httpStatus,
      bytes: outcome.bytes,
      robots_allowed: true,
      final_url: outcome.finalUrl,
      reason: `http_status_${outcome.httpStatus}`,
      trace_id: input.traceId,
    };
  }

  // --- untrusted content becomes text, then a row ---
  const extracted =
    outcome.contentType === 'text/plain'
      ? plainToText(outcome.body)
      : htmlToText(outcome.body);

  const contentHash = hashOf(extracted.text);
  const snapshotId = await storeSnapshot(deps.pool, {
    companyId: input.companyId,
    url: outcome.finalUrl,
    httpStatus: outcome.httpStatus,
    contentHash,
    text: extracted.text,
    bytes: outcome.bytes,
    robotsAllowed: true,
    traceId: input.traceId,
  });

  log.info(
    {
      url: outcome.finalUrl,
      http_status: outcome.httpStatus,
      bytes: outcome.bytes,
      text_length: extracted.text.length,
      redirects: outcome.chain.length - 1,
      removed: extracted.removed,
    },
    'snapshot stored',
  );

  return {
    outcome: 'stored',
    ...(snapshotId === undefined ? {} : { snapshot_id: snapshotId }),
    http_status: outcome.httpStatus,
    content_hash: contentHash,
    bytes: outcome.bytes,
    text_length: extracted.text.length,
    robots_allowed: true,
    final_url: outcome.finalUrl,
    trace_id: input.traceId,
  };
}

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type StatusClass = 'success' | 'client_error' | 'unavailable';

/**
 * Three classes, because they need three different answers.
 *
 * Anything that is neither 2xx nor 4xx — a stray 3xx that guardedFetch did not
 * treat as a redirect, a 1xx, a 5xx — lands in 'unavailable' and is retried
 * within the §6 budget, then goes dead visibly. Guessing is worse than that.
 */
function classifyStatus(status: number): StatusClass {
  if (status >= 200 && status < 300) {
    return 'success';
  }
  if (status >= 400 && status < 500) {
    return 'client_error';
  }
  return 'unavailable';
}

/**
 * The content hash for a row that has no content.
 *
 * `UNIQUE (company_id, url, content_hash)` needs a value, and it must not be a
 * hash of anything a page could produce. Deriving it from the status keeps two
 * different refusals on one URL as two distinct rows, and keeps a re-run of the
 * same refusal idempotent.
 */
function statusSentinelHash(status: number): string {
  return hashOf(`\u0000http_status:${status}`);
}

/**
 * Inserts the snapshot with the fetcher's own role.
 *
 * The unique (company_id, url, content_hash) means re-fetching unchanged
 * content is a no-op, so this returns the existing row's id instead of a second
 * one. Both the RETURNING and the read-back need the four column grants of
 * migration 004 — and nothing wider: text is not among them, so this process
 * cannot read back the hostile content it just wrote.
 */
async function storeSnapshot(
  pool: Pool,
  snapshot: {
    companyId: string;
    url: string;
    httpStatus: number | undefined;
    contentHash: string;
    text: string | undefined;
    bytes: number | undefined;
    robotsAllowed: boolean;
    traceId: string;
  },
): Promise<string | undefined> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO web_snapshots
       (company_id, url, http_status, content_hash, text, bytes, robots_allowed, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, url, content_hash) DO NOTHING
     RETURNING id`,
    [
      snapshot.companyId,
      snapshot.url,
      snapshot.httpStatus ?? null,
      snapshot.contentHash,
      snapshot.text ?? null,
      snapshot.bytes ?? null,
      snapshot.robotsAllowed,
      snapshot.traceId,
    ],
  );

  const id = inserted.rows[0]?.id;
  if (id !== undefined) {
    return id;
  }

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM web_snapshots
     WHERE company_id = $1 AND url = $2 AND content_hash = $3`,
    [snapshot.companyId, snapshot.url, snapshot.contentHash],
  );
  return existing.rows[0]?.id;
}

export function createFetcherServer(deps: FetcherDeps): Server {
  const log = getLogger();

  return createServer((request, response) => {
    void (async () => {
      const traceId = adoptTraceId(
        Array.isArray(request.headers['x-trace-id'])
          ? request.headers['x-trace-id'][0]
          : request.headers['x-trace-id'],
      );

      // Liveness, before auth, so the container healthcheck needs no secret.
      // It reveals nothing: a fixed string and no database access.
      if (request.method === 'GET' && request.url === '/health') {
        send(response, 200, { status: 'ok', service: 'fetcher' });
        return;
      }

      if (request.method !== 'POST' || request.url !== '/fetch') {
        send(response, 404, { error: 'not_found' });
        return;
      }

      const provided = Array.isArray(request.headers[AUTH_HEADER])
        ? request.headers[AUTH_HEADER][0]
        : request.headers[AUTH_HEADER];

      if (!secretMatches(provided, deps.sharedSecret)) {
        // Never log the value that was offered.
        log.warn({ trace_id: traceId }, 'rejected an unauthenticated fetch request');
        send(response, 401, { error: 'unauthorized' });
        return;
      }

      let raw: string;
      try {
        raw = await readBody(request);
      } catch {
        send(response, 413, { error: 'request_too_large' });
        return;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        send(response, 400, { error: 'invalid_json' });
        return;
      }

      const parsed = fetchRequestSchema.safeParse(parsedJson);
      if (!parsed.success) {
        send(response, 400, {
          error: 'invalid_request',
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        });
        return;
      }

      try {
        const result = await fetchAndStore(deps, {
          companyId: parsed.data.company_id,
          url: parsed.data.url,
          traceId: parsed.data.trace_id,
        });
        send(response, 200, result);
      } catch (error) {
        withTrace(parsed.data.trace_id).error({ err: error }, 'fetch failed unexpectedly');
        send(response, 500, { error: 'fetch_failed' });
      }
    })();
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  const log = getLogger();

  if (config.FETCHER_SHARED_SECRET === undefined) {
    throw new Error(
      'FETCHER_SHARED_SECRET is required by the fetcher: the worker authenticates ' +
        'with it and the fetcher rejects anything else (SPEC.md §8).',
    );
  }
  if (config.FETCH_DATABASE_URL === undefined) {
    throw new Error(
      'FETCH_DATABASE_URL is required by the fetcher: it connects as operator_fetch, ' +
        'whose grants are a snapshot insert and the robots cache (SPEC.md §17).',
    );
  }
  // Structural, not a comment: if a model key ever reaches this process's
  // environment, it stops rather than carrying a credential it must not have.
  if (config.MODEL_API_KEY !== undefined) {
    throw new Error(
      'MODEL_API_KEY is present in the fetcher environment. The fetcher holds no ' +
        'model credential (SPEC.md §8, §17); remove it from this service.',
    );
  }

  const pool = createPool(config.FETCH_DATABASE_URL);
  const server = createFetcherServer({
    pool,
    sharedSecret: config.FETCHER_SHARED_SECRET,
  });

  server.listen(config.FETCHER_PORT, '0.0.0.0', () => {
    log.info({ port: config.FETCHER_PORT }, 'fetcher listening on the internal network');
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'fetcher shutting down');
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    getLogger().error({ err: error }, 'fetcher failed to start');
    process.exit(1);
  });
}
