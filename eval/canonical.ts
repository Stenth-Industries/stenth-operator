/**
 * Canonical JSON, so a fixture frozen twice is the same bytes twice.
 *
 * A fixture is evidence. Evidence whose file changes when nothing about the
 * evidence changed is evidence nobody can diff, and a corpus nobody can diff is
 * a corpus nobody can review. So every file this harness writes goes through
 * here: keys sorted, two-space indent, one trailing newline, no insertion-order
 * dependence and no `undefined` holes.
 *
 * `JSON.stringify` alone is not enough — it preserves insertion order, so two
 * objects built by different code paths from identical data serialise
 * differently. Arrays keep their order, because in a fixture an array's order is
 * data (page one is the homepage).
 */

/** Recursively sorts object keys. Arrays keep their order; it is meaningful. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // undefined would vanish at stringify time and take its key with it,
      // which makes "same data, different bytes" possible. Dropped here, once.
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, child]) => [key, sortKeys(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * The same thing without the whitespace, for hashing.
 *
 * A digest over the pretty form would change if the indent ever changed, which
 * would silently invalidate every content digest in the corpus.
 */
export function canonicalCompact(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
