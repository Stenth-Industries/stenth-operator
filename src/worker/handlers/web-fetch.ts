/**
 * The web.fetch handler (SPEC.md §6, §8).
 *
 * The worker claims the job with the ordinary application role and then asks
 * the fetcher to do the dangerous part. It never opens a socket to the public
 * internet itself, and it never sees the page.
 *
 * §6 says web.fetch "Asks the fetcher service for up to 6 pages over the
 * internal network" and enqueues web.extract per snapshot. web.extract is Day
 * 4, so this stores snapshots and stops there; the enqueue arrives with the
 * handler that can act on it.
 */
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  AUTH_HEADER,
  EXTRACTABLE_OUTCOMES,
  fetchResponseSchema,
  isRetryable,
  type FetchResponse,
} from '../../fetcher/contract';
import { EXTRACTION_SCHEMA_VERSION } from '../../ai/schemas/extraction-v1';
import { enqueue } from '../../jobs/enqueue';
import { dedupeKey } from '../../jobs/kinds';
import type { ClaimedJob } from '../../jobs/queue';
import { withTrace } from '../../obs/log';
import { TRACE_HEADER } from '../../obs/trace';
import { PAGE_KINDS } from '../../pipeline/resolve';

/** §10 stage 3: "max 6 pages: home, about, services or practice areas, contact, team, one location page". */
export const MAX_PAGES_PER_JOB = 6;

export const webFetchPayloadSchema = z
  .object({
    company_id: z.string().uuid(),
    urls: z.array(z.string().min(1).max(2_048)).min(1).max(MAX_PAGES_PER_JOB),
    /**
     * Which of §10 stage 3's six page kinds this job covers, when a planner set
     * it. Provenance, not an option: it is never forwarded to the fetcher —
     * fetchRequestSchema is strict and takes company_id, url and trace_id and
     * nothing else — and the handler only logs it. company.resolve writes it so
     * the 404 rate per page kind is measurable, which is the evidence that
     * decides the candidate paths in src/pipeline/resolve.ts.
     */
    page_kind: z.enum(PAGE_KINDS).optional(),
  })
  .strict();

export interface WebFetchDeps {
  readonly fetcherUrl: string;
  readonly sharedSecret: string;
  /**
   * The application pool, for the §6 enqueue of web.extract per snapshot.
   *
   * Required rather than optional: a handler that silently skips its successor
   * when a dependency is missing is a pipeline that stops without an error, and
   * "the enqueue only happens in production" is not a property a test can
   * verify. Day 3 left this out because web.extract had no handler yet; it has
   * one now.
   */
  readonly pool: Pool;
  /** Injected so the suite can drive the handler without a live service. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface WebFetchResult {
  /** 2xx pages whose text was stored. The only source of research evidence. */
  readonly stored: number;
  readonly robotsDisallowed: number;
  /** 4xx: the site answered no. Terminal, so it never causes a retry. */
  readonly httpError: number;
  /** 5xx and the like: no answer, so another attempt is legitimate. */
  readonly httpUnavailable: number;
  /** A §8 guard refusal. Retryable, as before. */
  readonly refused: number;
  /**
   * Snapshots that carry page text and so may be extracted.
   *
   * Deliberately not "every snapshot this job touched". A robots-disallowed row
   * and a 4xx row both exist in web_snapshots and both have text NULL; neither
   * belongs in the list Day 4 will iterate to enqueue web.extract. Keeping them
   * out of this list is the first of three layers that stop a non-page becoming
   * evidence — the other two are text being NULL and the CHECK constraint in
   * migration 005.
   */
  readonly extractableSnapshotIds: readonly string[];
  /**
   * web.extract jobs this call inserted (§6: "enqueues web.extract per
   * snapshot"). Lower than the snapshot count on a replay, because §7's extract
   * key is permanent and the second enqueue is a no-op rather than a duplicate.
   */
  readonly extractsEnqueued: number;
}

/**
 * Asks the fetcher for one page.
 *
 * The reply is parsed with Zod before anything is believed: the fetcher is the
 * process that handles hostile input, so its output is the least trustworthy
 * thing crossing into the privileged zone.
 */
async function requestOne(
  deps: WebFetchDeps,
  body: { company_id: string; url: string; trace_id: string },
): Promise<FetchResponse> {
  const call = deps.fetchImpl ?? globalThis.fetch;
  const response = await call(`${deps.fetcherUrl.replace(/\/$/, '')}/fetch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AUTH_HEADER]: deps.sharedSecret,
      [TRACE_HEADER]: body.trace_id,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`fetcher returned ${response.status}`);
  }

  const parsed = fetchResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `fetcher reply failed validation: ${parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`,
    );
  }
  return parsed.data;
}

export async function handleWebFetch(
  job: ClaimedJob,
  deps: WebFetchDeps,
): Promise<WebFetchResult> {
  const payload = webFetchPayloadSchema.parse(job.payload);
  const log = withTrace(job.trace_id);

  let stored = 0;
  let robotsDisallowed = 0;
  let httpError = 0;
  let httpUnavailable = 0;
  let refused = 0;
  let retryable = 0;
  const extractableSnapshotIds: string[] = [];

  for (const url of payload.urls) {
    const result = await requestOne(deps, {
      company_id: payload.company_id,
      url,
      trace_id: job.trace_id,
    });

    if (isRetryable(result.outcome)) {
      retryable += 1;
    }

    switch (result.outcome) {
      case 'stored':
        stored += 1;
        break;
      case 'robots_disallowed':
        robotsDisallowed += 1;
        break;
      case 'http_error':
        httpError += 1;
        // Terminal. Logged, recorded by the fetcher as a text-free row, and
        // deliberately not a reason to run the job again: a site that answered
        // 403 answers 403 the next two times as well, and asking it is three
        // unwanted requests at a site that has already said no.
        log.warn({ url, reason: result.reason }, 'the site refused the page; not retrying it');
        break;
      case 'http_unavailable':
        httpUnavailable += 1;
        log.warn({ url, reason: result.reason }, 'the site gave no answer; the job may retry');
        break;
      default:
        refused += 1;
        // A refusal is the guard working. It is recorded, not retried blindly:
        // the job's own retry budget decides whether the page is tried again.
        log.warn({ url, reason: result.reason }, 'fetcher refused a page');
    }

    if (
      result.snapshot_id !== undefined &&
      EXTRACTABLE_OUTCOMES.includes(result.outcome)
    ) {
      extractableSnapshotIds.push(result.snapshot_id);
    }
  }

  // §6: "Enqueues next: web.extract per snapshot". Only the extractable ids,
  // which is only `stored` — a robots row and a 4xx row both exist with text
  // NULL and neither may become evidence (§8, migration 005).
  //
  // Before the retry decision below, deliberately. A page that was stored has
  // been stored whatever happens to its siblings, and §7's extract key is
  // permanent, so a retry's second enqueue is a no-op rather than a duplicate.
  let extractsEnqueued = 0;
  for (const snapshotId of extractableSnapshotIds) {
    const { inserted } = await enqueue(deps.pool, {
      kind: 'web.extract',
      dedupeKey: dedupeKey.webExtract(snapshotId, EXTRACTION_SCHEMA_VERSION),
      traceId: job.trace_id,
      payload: { snapshot_id: snapshotId },
      parentJobId: job.id,
    });
    if (inserted) {
      extractsEnqueued += 1;
    }
  }

  log.info(
    {
      company_id: payload.company_id,
      page_kind: payload.page_kind,
      stored,
      robots_disallowed: robotsDisallowed,
      http_error: httpError,
      http_unavailable: httpUnavailable,
      refused,
      extracts_enqueued: extractsEnqueued,
    },
    'web.fetch complete',
  );

  // Retry only when retrying could change the answer.
  //
  // A failed attempt means the job goes back to queued with backoff and
  // eventually dead, which is right when the failure was transient — a 5xx, a
  // timeout, a guard refusal that may not recur. It is wrong when every page
  // ended in a terminal state: a job whose only page returned 404 has its
  // answer, and throwing here would turn one unwanted request into three.
  if (stored === 0 && robotsDisallowed === 0 && retryable > 0) {
    throw new Error(
      `no page could be fetched for company ${payload.company_id}: ` +
        `${refused} refused, ${httpUnavailable} unavailable`,
    );
  }

  return {
    stored,
    robotsDisallowed,
    httpError,
    httpUnavailable,
    refused,
    extractableSnapshotIds,
    extractsEnqueued,
  };
}
