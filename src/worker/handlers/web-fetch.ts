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
import { dedupeKey, fetchUrlHash, todayUtc } from '../../jobs/kinds';
import type { ClaimedJob } from '../../jobs/queue';
import { withTrace } from '../../obs/log';
import { TRACE_HEADER } from '../../obs/trace';
import { isFirstPartyUrl } from '../../pipeline/domain';
import { safeFirstPartyUrl } from '../../pipeline/links';
import {
  classifyPageKind,
  FOLLOW_UP_KINDS,
  PAGE_KINDS,
  selectFollowUpPages,
  type DiscoveredLink,
  type PageKind,
} from '../../pipeline/resolve';

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
    /**
     * §7's `yyyy-mm-dd` occurrence, carried so that all six pages of one firm
     * share one. Without it the homepage's fan-out would stamp its own date,
     * and a home job claimed after midnight would put its five siblings in a
     * different occurrence from itself.
     */
    occurrence: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Whether this URL came from the harvest or from a conventional path. */
    page_source: z.enum(['root', 'discovered', 'fallback']).optional(),
  })
  .strict();

export interface WebFetchDeps {
  readonly fetcherUrl: string;
  readonly sharedSecret: string;
  /** The §7 occurrence for the fan-out, when the payload does not carry one. */
  readonly occurrence?: string;
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
  /**
   * The follow-up web.fetch jobs this call enqueued (§10 stage 3's second wave).
   *
   * Non-zero only for the homepage job: it is the one job that can see what the
   * firm's own homepage links to. A discovered page never fans out again, which
   * is what keeps the depth at one and the total at six.
   */
  readonly followUpsEnqueued: number;
  /** How many of those came from the harvest rather than a conventional path. */
  readonly followUpsDiscovered: number;
  /** Why the fan-out did what it did. The audit answer to "where did these come from". */
  readonly followUpBasis: FollowUpBasis;
}

/**
 * What the homepage job's own outcome made of §10 stage 3's second wave.
 *
 *   not_eligible       Not the homepage job, or a job carrying more than one
 *                      URL, so there is no single homepage outcome to read.
 *   homepage_read      The homepage was stored. Discovered URLs are preferred,
 *                      conventional paths fill the kinds it did not link.
 *   terminal_fallback  The homepage answered no, and the answer is final — a
 *                      4xx, or a robots Disallow. The firm does not end there:
 *                      the five conventional paths are enqueued instead.
 *   exhausted_fallback A guard refused the homepage and the job has no attempts
 *                      left, so no later attempt can discover anything. Same
 *                      five conventional paths.
 *   retry_pending      A guard refused it and attempts remain. Nothing is
 *                      enqueued yet, deliberately: see the note below.
 *   no_answer          5xx, or any other status that is neither 2xx nor 4xx.
 *                      The site gave no answer, so §6's retry is the answer and
 *                      asking five more URLs of it would be load, not fallback.
 *   off_domain         The final URL left the firm's registrable domain. The
 *                      firm's site is not at the firm's domain, which §10 calls
 *                      parked, and a parked domain does not get to nominate
 *                      pages.
 */
export type FollowUpBasis =
  | 'not_eligible'
  | 'homepage_read'
  | 'terminal_fallback'
  | 'exhausted_fallback'
  | 'retry_pending'
  | 'no_answer'
  | 'off_domain';

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
  /** Kept so the fan-out can read the homepage's own outcome, not just a count. */
  const outcomes: FetchResponse[] = [];

  for (const url of payload.urls) {
    const result = await requestOne(deps, {
      company_id: payload.company_id,
      url,
      trace_id: job.trace_id,
    });
    outcomes.push(result);

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

  // §10 stage 3's second wave. Only the homepage job runs it: it is the only
  // job that has seen what the firm's own homepage links to, and a discovered
  // page fanning out again would make the six-page ceiling unenforceable.
  //
  // It runs whatever the homepage's outcome was, because a homepage that
  // refuses us is not a reason to abandon the firm — only a reason to stop
  // asking the homepage. What changes is where the five URLs come from.
  const followUps = await fanOutFromHomepage(job, payload, outcomes, deps);

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
      follow_ups_enqueued: followUps.enqueued,
      follow_ups_discovered: followUps.discovered,
      follow_up_basis: followUps.basis,
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
    followUpsEnqueued: followUps.enqueued,
    followUpsDiscovered: followUps.discovered,
    followUpBasis: followUps.basis,
  };
}

/**
 * Chooses and enqueues the five pages that follow the homepage.
 *
 * ## Two sources, one shape
 *
 * When the homepage was read, its own links decide: `selectFollowUpPages`
 * prefers a discovered URL per page kind and falls back to a conventional path
 * for the kinds it did not link. When the homepage refused us, there is nothing
 * to prefer, so all five are conventional paths. Either way it is five URLs, one
 * job each, `page_source` on every payload saying which it was.
 *
 * A homepage that answers 403 is not a reason to abandon the firm. It is a
 * reason to stop asking *the homepage*: a site with a blocked root and a
 * perfectly readable `/about` is ordinary, and Day 3's correction was about not
 * re-asking a URL that has already answered, not about giving up on a company.
 *
 * ## Why a retryable refusal waits
 *
 * A guard refusal and a 5xx are retryable, and fanning out while an attempt
 * remains would be unsound rather than merely eager: the retry could then store
 * the homepage, discovery would run, and the discovered URLs would be *added*
 * to five fallbacks already queued. One firm, eleven pages, §10's ceiling gone.
 * So a refusal fans out only once the homepage has no attempts left — at which
 * point no later attempt can discover anything — and a 5xx never does, because
 * "the site gave no answer" is answered by §6's retry, and asking five more
 * URLs of a server returning 500s is load, not fallback.
 *
 * ## The trust step, which is the point of this function
 *
 * The candidate list was produced by the fetcher — the process whose job is
 * handling hostile input — from attacker-controlled markup. The worker already
 * refuses to believe that process's HTTP reply without parsing it; believing its
 * stored output would be the same mistake with a database in between. So every
 * candidate is run through `safeFirstPartyUrl` again here, and against
 * `companies.canonical_domain` this time rather than the page's own final URL:
 * a redirect could have moved the snapshot, and §4 makes the canonical domain
 * the firm's identity. The page kind is re-derived too, so a mislabelled
 * candidate is reclassified rather than trusted.
 *
 * Every URL that becomes a job passes that same filter, fallbacks included.
 * They are constructed from the canonical domain, so they pass by construction
 * — which is exactly why checking them costs nothing and proves it.
 *
 * In other words the fetcher's filter is a courtesy that keeps junk out of the
 * database. This is the one that decides what gets fetched.
 */
async function fanOutFromHomepage(
  job: ClaimedJob,
  payload: z.infer<typeof webFetchPayloadSchema>,
  outcomes: readonly FetchResponse[],
  deps: WebFetchDeps,
): Promise<{ enqueued: number; discovered: number; basis: FollowUpBasis }> {
  const log = withTrace(job.trace_id);
  const nothing = (basis: FollowUpBasis) => ({ enqueued: 0, discovered: 0, basis });
  // §7's occurrence, carried from the homepage job so all six pages of one firm
  // share one date rather than splitting across midnight.
  const occurrence = payload.occurrence ?? deps.occurrence ?? todayUtc();

  // One homepage, one outcome. A hand-enqueued job carrying several URLs has no
  // single homepage result to read, so it does not fan out.
  const home = outcomes.length === 1 ? outcomes[0] : undefined;
  if (payload.page_kind !== 'home' || home === undefined) {
    return nothing('not_eligible');
  }

  const { rows } = await deps.pool.query<{ canonical_domain: string }>(
    'SELECT canonical_domain::text AS canonical_domain FROM companies WHERE id = $1',
    [payload.company_id],
  );
  const canonicalDomain = rows[0]?.canonical_domain;
  if (canonicalDomain === undefined) {
    throw new Error(`companies ${payload.company_id} does not exist`);
  }

  // Where the homepage actually ended up. A redirect off the firm's registrable
  // domain means the firm's site is not at the firm's domain — §10's "dead,
  // parked or under construction" — and a parked domain does not get to
  // nominate pages, nor does it earn five guesses at the domain it left.
  // src/pipeline/domain.ts: not company evidence "until company.resolve
  // separately verifies that the other domain belongs to the same firm".
  const observed = home.final_url ?? payload.urls[0] ?? '';
  if (!isFirstPartyUrl(observed, canonicalDomain).sameFirm) {
    log.warn(
      { company_id: payload.company_id, canonical_domain: canonicalDomain },
      'the homepage ended on another registrable domain; not fanning out',
    );
    return nothing('off_domain');
  }

  const storedHomepage =
    home.outcome === 'stored' && home.snapshot_id !== undefined ? home.snapshot_id : undefined;

  let discovered: DiscoveredLink[] = [];
  let basis: FollowUpBasis;

  if (storedHomepage !== undefined) {
    discovered = revalidateCandidates(
      await readHarvest(deps, storedHomepage),
      canonicalDomain,
    );
    basis = 'homepage_read';
  } else if (home.outcome === 'robots_disallowed' || home.outcome === 'http_error') {
    // Final. The five conventional paths are enqueued, and each one does its
    // own robots check in the fetcher — so a blanket `Disallow: /` costs one
    // cached robots.txt and five text-free rows, not five fetches.
    basis = 'terminal_fallback';
  } else if (home.outcome === 'http_unavailable') {
    return nothing('no_answer');
  } else if (job.attempts >= job.max_attempts) {
    basis = 'exhausted_fallback';
  } else {
    return nothing('retry_pending');
  }

  const pages = selectFollowUpPages(canonicalDomain, discovered);

  let enqueued = 0;
  let discoveredPages = 0;
  for (const page of pages) {
    // The last gate before a URL becomes a request, applied to discovered and
    // conventional alike.
    const verdict = safeFirstPartyUrl(page.url, base(canonicalDomain), canonicalDomain);
    if (!verdict.ok) {
      log.warn(
        { page_kind: page.kind, reason: verdict.reason },
        'a planned page failed the first-party filter and was dropped',
      );
      continue;
    }
    if (page.source === 'discovered') {
      discoveredPages += 1;
    }
    const { inserted } = await enqueue(deps.pool, {
      kind: 'web.fetch',
      dedupeKey: dedupeKey.webFetch(payload.company_id, fetchUrlHash([verdict.url]), occurrence),
      traceId: job.trace_id,
      payload: {
        company_id: payload.company_id,
        urls: [verdict.url],
        page_kind: page.kind,
        page_source: page.source,
        occurrence,
      },
      parentJobId: job.id,
    });
    if (inserted) {
      enqueued += 1;
    }
  }

  log.info(
    {
      company_id: payload.company_id,
      canonical_domain: canonicalDomain,
      basis,
      harvest_candidates: discovered.length,
      follow_ups_enqueued: enqueued,
      discovered_pages: discoveredPages,
    },
    'the homepage chose the remaining pages',
  );

  return { enqueued, discovered: discoveredPages, basis };
}

/** The firm's own root, as the base relative candidates resolve against. */
function base(canonicalDomain: string): URL {
  return new URL(`https://${canonicalDomain}/`);
}

/** The stored harvest for one snapshot, as written by the fetcher. */
async function readHarvest(deps: WebFetchDeps, snapshotId: string): Promise<unknown> {
  const { rows } = await deps.pool.query<{ page_links: unknown }>(
    `SELECT signals -> 'page_links' AS page_links FROM web_snapshots WHERE id = $1`,
    [snapshotId],
  );
  if (rows[0] === undefined) {
    throw new Error(`web_snapshots ${snapshotId} vanished between storing and reading it back`);
  }
  return rows[0].page_links;
}

/**
 * Re-derives the harvest in the privileged zone, trusting none of it.
 *
 * The stored value is jsonb written by the fetcher, so its *shape* is checked
 * before its contents: anything that is not an object with a candidate array is
 * simply no harvest, which falls back to the conventional paths rather than
 * failing the job. Within it, each entry must be a string URL that passes every
 * §8 rule against the firm's canonical domain, and its kind is computed here
 * rather than read.
 *
 * Capped at the five follow-up kinds by construction: one URL per kind, first
 * valid entry wins, so a stored list of a thousand yields at most five.
 */
function revalidateCandidates(stored: unknown, canonicalDomain: string): DiscoveredLink[] {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return [];
  }
  const raw = (stored as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) {
    return [];
  }

  let root: URL;
  try {
    root = base(canonicalDomain);
  } catch {
    return [];
  }

  const byKind = new Map<PageKind, string>();
  for (const entry of raw) {
    if (byKind.size >= FOLLOW_UP_KINDS.length) {
      break;
    }
    const candidate =
      entry !== null && typeof entry === 'object'
        ? (entry as { url?: unknown }).url
        : undefined;
    if (typeof candidate !== 'string' || candidate === '') {
      continue;
    }

    const verdict = safeFirstPartyUrl(candidate, root, canonicalDomain);
    if (!verdict.ok) {
      continue;
    }

    // Computed, not read: the stored `kind` is the fetcher's opinion.
    const kind = classifyPageKind(new URL(verdict.url).pathname);
    if (kind === null || kind === 'home' || byKind.has(kind)) {
      continue;
    }
    byKind.set(kind, verdict.url);
  }

  return FOLLOW_UP_KINDS.flatMap((kind) => {
    const url = byKind.get(kind);
    return url === undefined ? [] : [{ kind, url }];
  });
}
