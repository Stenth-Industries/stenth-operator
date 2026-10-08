/**
 * Job kinds, retry budgets and dedupe keys (SPEC.md §6, §7).
 *
 * The tables below are transcriptions of the specification, not choices made
 * here. tests/unit/kinds.test.ts asserts them against §6 and §7 literally, so
 * a drift shows up as a failing test rather than as a quietly different system.
 */

import { createHash } from 'node:crypto';

/** The nine kinds of §6. gmail.create_draft and maintenance.tick are gone in v1.1. */
export const JOB_KINDS = [
  'discover.search',
  'company.resolve',
  'web.fetch',
  'web.extract',
  'company.assess',
  'contact.resolve',
  'outreach.draft',
  'maintenance.prune',
  'eval.run',
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(JOB_KINDS);

export function isJobKind(value: string): value is JobKind {
  return KIND_SET.has(value);
}

/** Max attempts per kind, from the §6 table. */
export const MAX_ATTEMPTS: Readonly<Record<JobKind, number>> = {
  'discover.search': 3,
  'company.resolve': 3,
  'web.fetch': 3,
  'web.extract': 2,
  'company.assess': 2,
  'contact.resolve': 2,
  'outreach.draft': 2,
  'maintenance.prune': 3,
  'eval.run': 1,
};

/**
 * Dedupe keys, from the §7 table. The key is derived from the work, never from
 * a random id.
 *
 * The rule that keeps these consistent: anything the scheduler enqueues must
 * include the occurrence in its key, and anything a handler enqueues must not.
 * A permanent key on recurring work runs once and then never again, silently.
 */
export const dedupeKey = {
  /** Per-occurrence (daily). */
  discoverSearch: (campaign: string, queryHash: string, occurrence: string): string =>
    `discover:${campaign}:${queryHash}:${occurrence}`,

  /** Permanent. */
  companyResolve: (canonicalDomain: string): string => `resolve:${canonicalDomain}`,

  /** Per-occurrence (daily). */
  webFetch: (companyId: string, urlHash: string, occurrence: string): string =>
    `fetch:${companyId}:${urlHash}:${occurrence}`,

  /** Permanent. */
  webExtract: (snapshotId: string, schemaVersion: string): string =>
    `extract:${snapshotId}:${schemaVersion}`,

  /** Permanent. The key that saves real money: re-assess only when the rubric or the content moved. */
  companyAssess: (
    companyId: string,
    campaignId: string,
    rubricVersion: string,
    contentHash: string,
  ): string => `assess:${companyId}:${campaignId}:${rubricVersion}:${contentHash}`,

  /** Permanent. */
  contactResolve: (companyId: string, assessmentId: string): string =>
    `contact:${companyId}:${assessmentId}`,

  /** Permanent. */
  outreachDraft: (
    prospectId: string,
    contactId: string,
    promptVersion: string,
    assessmentId: string,
  ): string => `draft:${prospectId}:${contactId}:${promptVersion}:${assessmentId}`,

  /** Per-occurrence, written by the scheduler. */
  maintenancePrune: (occurrence: string): string => `prune:${occurrence}`,
} as const;

/**
 * The `url_hash` component of §7's web.fetch key.
 *
 * §7 writes the key as `fetch:{company_id}:{url_hash}:{yyyy-mm-dd}`, so the
 * hash has to be bounded, deterministic and derived from the work — never from
 * a random id. sha256 truncated to 16 hex characters: the key is an identity,
 * not a security claim, and a URL list of six cannot collide at 64 bits.
 *
 * Lives here, beside the key it is part of, because company.resolve's fan-out
 * and the Day 3 acceptance harness must produce the same key for the same work
 * or a re-run would duplicate jobs instead of deduplicating them.
 */
/**
 * Today in UTC, as §7's `yyyy-mm-dd` occurrence.
 *
 * Here rather than in a handler because two handlers need the same answer: the
 * occurrence a firm's six pages share is part of the key, not part of either
 * stage.
 */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function fetchUrlHash(urls: readonly string[]): string {
  return createHash('sha256').update(urls.join('\n'), 'utf8').digest('hex').slice(0, 16);
}
