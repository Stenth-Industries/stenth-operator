/**
 * Retry backoff (SPEC.md §6): min(60 * 2^attempts, 3600) seconds with ±20% jitter.
 *
 * The jitter source is a parameter rather than a direct Math.random call, which
 * is the whole reason this is testable: the suite pins it and asserts the exact
 * schedule, instead of asserting a range and hoping.
 */

export const BASE_SECONDS = 60;
export const MAX_BACKOFF_SECONDS = 3600;
export const JITTER_FRACTION = 0.2;

/**
 * Seconds to wait before a failed job becomes claimable again.
 *
 * `attempts` is the value after the claim incremented it, so the first failure
 * passes 1 and waits ~120s.
 */
export function backoffSeconds(attempts: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`backoffSeconds expects a positive integer attempt, got ${attempts}`);
  }

  const base = Math.min(BASE_SECONDS * 2 ** attempts, MAX_BACKOFF_SECONDS);
  // random() in [0,1) maps to a factor in [0.8, 1.2).
  const factor = 1 + (random() * 2 - 1) * JITTER_FRACTION;
  return base * factor;
}

/** The un-jittered base, which is what the cap applies to. */
export function baseBackoffSeconds(attempts: number): number {
  return Math.min(BASE_SECONDS * 2 ** attempts, MAX_BACKOFF_SECONDS);
}
