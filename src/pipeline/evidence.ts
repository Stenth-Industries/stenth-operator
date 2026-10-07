/**
 * Snapshot eligibility: which stored pages may be sent to a paid model call.
 *
 * Day 3's production run made the case for this file. Two sites returned 200
 * and extracted to **zero characters** — sydneycriminallawyers.com.au and
 * cridlandhua.com — almost certainly client-rendered pages whose visible text
 * never exists in the HTML the fetcher received. A 2xx status says the server
 * answered; it says nothing about whether there is anything to read.
 *
 * So the rule is deterministic, enforced before any provider is contacted, and
 * recorded when it refuses. Nothing here is a judgement call at runtime.
 *
 * ## Why the threshold is not the acceptance harness's 500
 *
 * The harness's >=500 answers "is this a real page rather than an error page" —
 * a low bar, chosen to separate a law firm's homepage from "403 Forbidden".
 * Production asks a harder question: *is there enough of the firm's own content
 * to ground the facts §9 and §10 need?* Those are firm shape, practice areas,
 * office locations, a named decision maker and a published contact. A page that
 * cannot supply them produces a valid-but-empty extraction, and §10's grounding
 * filter then drops every reason and downgrades the verdict to uncertain. The
 * call is paid for and the result is a shrug.
 *
 * The threshold is therefore set by what the extraction needs, and bounded by
 * the asymmetry of the two errors:
 *
 *   * A false *positive* — paying for a page too thin to ground anything —
 *     costs one call. At §22's ceiling of $0.15 per assessed company that is
 *     0.3% of the $50 month.
 *   * A false *negative* — skipping a real firm because its one-page site is
 *     terse — costs a prospect, and V1 only shows 5-8 a day for review.
 *
 * The second error is worse, so the floor is set to exclude what *cannot*
 * ground an extraction rather than what is merely brief: **1,000 characters of
 * normalised text and at least 50 distinct alphabetic words**. 1,000 characters
 * is roughly 150 words — below that a law-firm homepage has no practice areas,
 * no location and no name in prose, and §10 would disqualify it as "dead,
 * parked or under construction" anyway. The distinct-word test catches the page
 * whose 1,000 characters are one navigation block repeated, which a character
 * count alone waves through.
 *
 * Both numbers are here, named, with this reasoning attached, and are mirrored
 * by a SQL predicate so the gate is queryable as well as enforced.
 */

import { isFirstPartyUrl } from './domain';

/** §25's acceptance harness floor, for comparison only. Not used in production. */
export const ACCEPTANCE_TEXT_FLOOR = 500;

export const MIN_EXTRACT_CHARS = 1_000;
export const MIN_EXTRACT_DISTINCT_WORDS = 50;

/** Every reason a snapshot can be refused. Machine tokens: logged and stored. */
export type IneligibilityReason =
  | 'missing_snapshot'
  | 'http_status_not_2xx'
  | 'robots_not_allowed'
  | 'text_null'
  | 'text_too_short'
  | 'text_too_repetitive'
  | 'off_domain_final_url'
  | 'already_extracted';

export interface SnapshotForEligibility {
  readonly id: string;
  readonly company_id: string;
  /** The snapshot's final URL, which may differ from the requested one. */
  readonly url: string;
  readonly http_status: number | null;
  readonly robots_allowed: boolean;
  readonly text: string | null;
  /** The firm's registrable domain, from companies.canonical_domain. */
  readonly canonical_domain: string;
}

export type Eligibility =
  | { readonly eligible: true; readonly textLength: number; readonly distinctWords: number }
  | { readonly eligible: false; readonly reason: IneligibilityReason; readonly detail: string };

/** Collapses whitespace so the character count measures content, not layout. */
export function normaliseForMeasurement(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function countDistinctWords(text: string): number {
  const words = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z'-]{1,}/g)) {
    words.add(match[0]);
  }
  return words.size;
}

/**
 * Whether the snapshot's final URL is first-party evidence for the firm.
 *
 * Finding 2 in ops/day3-acceptance/findings.md: §8 re-validates every redirect
 * hop for scheme, port and address but not for host, so a redirect can land a
 * snapshot on another site. The policy, approved for Day 5:
 *
 *   * the firm's own registrable domain (eTLD+1) is first-party, including a
 *     legitimate subdomain and either direction of apex <-> www;
 *   * a different registrable domain is not, and is reported rather than
 *     promoted, until company.resolve verifies it belongs to the same firm.
 *
 * Delegated to src/pipeline/domain.ts, which asks the Public Suffix List. The
 * earlier host-equality version refused a legitimate subdomain and would have
 * been fooled by nothing — but it also could not tell `firm.com.au` from
 * `firm.com.attacker.tld` on principle, only by accident of equality.
 */
export function isOnOwnDomain(finalUrl: string, canonicalDomain: string): boolean {
  return isFirstPartyUrl(finalUrl, canonicalDomain).sameFirm;
}

/**
 * The gate. Pure, deterministic, and the only place the rule lives.
 *
 * `alreadyExtracted` is passed in rather than queried here so the function
 * stays pure and testable without a database; the handler does the lookup.
 */
export function assessEligibility(
  snapshot: SnapshotForEligibility | undefined,
  options: { readonly alreadyExtracted: boolean },
): Eligibility {
  if (snapshot === undefined) {
    return { eligible: false, reason: 'missing_snapshot', detail: 'no such snapshot' };
  }

  // Ordered cheapest and most categorical first, which also means a snapshot is
  // never measured before it is known to be a page we were allowed to read.
  if (
    snapshot.http_status === null ||
    snapshot.http_status < 200 ||
    snapshot.http_status > 299
  ) {
    return {
      eligible: false,
      reason: 'http_status_not_2xx',
      detail: `http_status ${snapshot.http_status ?? 'null'}`,
    };
  }

  if (!snapshot.robots_allowed) {
    return {
      eligible: false,
      reason: 'robots_not_allowed',
      detail: 'robots_allowed is false',
    };
  }

  if (snapshot.text === null) {
    // A robots row, or a snapshot whose text maintenance.prune removed past its
    // retention window (§15). Never a non-2xx row: that is refused above.
    return { eligible: false, reason: 'text_null', detail: 'text is null' };
  }

  if (!isOnOwnDomain(snapshot.url, snapshot.canonical_domain)) {
    return {
      eligible: false,
      reason: 'off_domain_final_url',
      detail: `final URL is not on ${snapshot.canonical_domain}`,
    };
  }

  const normalised = normaliseForMeasurement(snapshot.text);
  if (normalised.length < MIN_EXTRACT_CHARS) {
    return {
      eligible: false,
      reason: 'text_too_short',
      detail: `${normalised.length} characters, floor ${MIN_EXTRACT_CHARS}`,
    };
  }

  const distinctWords = countDistinctWords(normalised);
  if (distinctWords < MIN_EXTRACT_DISTINCT_WORDS) {
    return {
      eligible: false,
      reason: 'text_too_repetitive',
      detail: `${distinctWords} distinct words, floor ${MIN_EXTRACT_DISTINCT_WORDS}`,
    };
  }

  // Last, because it is the only reason that is about our own state rather than
  // about the page: an extraction that already exists is a success, not a skip.
  if (options.alreadyExtracted) {
    return {
      eligible: false,
      reason: 'already_extracted',
      detail: 'an extraction already exists for this snapshot, schema and model',
    };
  }

  return { eligible: true, textLength: normalised.length, distinctWords };
}

/**
 * The measurable part of the rule, as SQL, for the dashboard and for counting.
 *
 * Deliberately **not** the whole gate. The first-party test needs the Public
 * Suffix List, and SQL has no access to it — the previous version of this
 * constant approximated it with host equality, which both refused legitimate
 * subdomains and could not tell `firm.com.au` from `firm.com.au.attacker.tld`
 * on principle. An approximation in the reporting query is worse than an
 * honest gap, because it reads as agreement.
 *
 * So this covers status, permission, text presence and length, and the domain
 * decision stays in code where the list is. A test asserts the containment that
 * matters: everything the code accepts, this accepts — the difference is
 * exactly the off-domain rows.
 */
export const ELIGIBLE_SNAPSHOT_SQL = `
  SELECT s.id
    FROM usable_snapshots s
    JOIN companies c ON c.id = s.company_id
   WHERE length(regexp_replace(s.text, '\\s+', ' ', 'g')) >= ${MIN_EXTRACT_CHARS}
`;
