/**
 * The frozen fetch policy (SPEC.md §8).
 *
 * Every number here is a transcription, not a choice. It is a value rather than
 * a set of constants so the suite can exercise the guard against a local HTTP
 * server — which necessarily lives on loopback, the one thing the policy exists
 * to refuse. `permitLoopback` is the single switch that allows that, it is
 * false in FROZEN_POLICY, and tests assert both that it is false and that the
 * fetcher service never passes anything else.
 */
export interface FetchPolicy {
  readonly allowedSchemes: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly maxRedirects: number;
  readonly maxBodyBytes: number;
  readonly timeoutMs: number;
  readonly allowedContentTypes: readonly string[];
  readonly userAgent: string;
  /** Minimum gap between two requests to one host (§6 politeness). */
  readonly minHostIntervalMs: number;
  /** robots.txt cache lifetime (§8). */
  readonly robotsTtlMs: number;
  /** TEST ONLY. False in the frozen policy; the service never overrides it. */
  readonly permitLoopback: boolean;
}

/**
 * The User-Agent is a descriptive identity with a contact URL (§8), so an
 * operator who sees us in their logs can find out who we are and tell us to
 * stop.
 */
export const USER_AGENT =
  'StenthOperator/1.1 (+https://stenth.com/crawler; australian law firm research)';

export const FROZEN_POLICY: FetchPolicy = Object.freeze({
  allowedSchemes: Object.freeze(['http:', 'https:']),
  allowedPorts: Object.freeze([80, 443]),
  maxRedirects: 3,
  maxBodyBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  allowedContentTypes: Object.freeze(['text/html', 'text/plain']),
  userAgent: USER_AGENT,
  minHostIntervalMs: 2_000,
  robotsTtlMs: 24 * 60 * 60 * 1_000,
  permitLoopback: false,
});
