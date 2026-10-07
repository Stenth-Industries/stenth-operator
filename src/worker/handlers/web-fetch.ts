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
import { z } from 'zod';

import {
  AUTH_HEADER,
  EXTRACTABLE_OUTCOMES,
  fetchResponseSchema,
  isRetryable,
  type FetchResponse,
} from '../../fetcher/contract';
import type { ClaimedJob } from '../../jobs/queue';
import { withTrace } from '../../obs/log';
import { TRACE_HEADER } from '../../obs/trace';

/** §10 stage 3: "max 6 pages: home, about, services or practice areas, contact, team, one location page". */
export const MAX_PAGES_PER_JOB = 6;

export const webFetchPayloadSchema = z
  .object({
    company_id: z.string().uuid(),
    urls: z.array(z.string().min(1).max(2_048)).min(1).max(MAX_PAGES_PER_JOB),
  })
  .strict();

export interface WebFetchDeps {
  readonly fetcherUrl: string;
  readonly sharedSecret: string;
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

  log.info(
    {
      company_id: payload.company_id,
      stored,
      robots_disallowed: robotsDisallowed,
      http_error: httpError,
      http_unavailable: httpUnavailable,
      refused,
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

  return { stored, robotsDisallowed, httpError, httpUnavailable, refused, extractableSnapshotIds };
}
