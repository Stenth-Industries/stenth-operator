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

import { AUTH_HEADER, fetchResponseSchema, type FetchResponse } from '../../fetcher/contract';
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
  readonly stored: number;
  readonly robotsDisallowed: number;
  readonly refused: number;
  readonly snapshotIds: readonly string[];
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
  let refused = 0;
  const snapshotIds: string[] = [];

  for (const url of payload.urls) {
    const result = await requestOne(deps, {
      company_id: payload.company_id,
      url,
      trace_id: job.trace_id,
    });

    if (result.outcome === 'stored') {
      stored += 1;
      if (result.snapshot_id !== undefined) {
        snapshotIds.push(result.snapshot_id);
      }
    } else if (result.outcome === 'robots_disallowed') {
      robotsDisallowed += 1;
      if (result.snapshot_id !== undefined) {
        snapshotIds.push(result.snapshot_id);
      }
    } else {
      refused += 1;
      // A refusal is the guard working. It is recorded, not retried blindly:
      // the job's own retry budget decides whether the page is tried again.
      log.warn({ url, reason: result.reason }, 'fetcher refused a page');
    }
  }

  log.info(
    { company_id: payload.company_id, stored, robots_disallowed: robotsDisallowed, refused },
    'web.fetch complete',
  );

  // Every page refused is a failed attempt: the job retries with backoff and
  // eventually goes dead rather than silently succeeding with nothing.
  if (stored === 0 && robotsDisallowed === 0) {
    throw new Error(`every page was refused for company ${payload.company_id}`);
  }

  return { stored, robotsDisallowed, refused, snapshotIds };
}
