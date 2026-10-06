/**
 * robots.txt (SPEC.md §8).
 *
 * "Fetched and cached 24h; disallow means skip, recorded as
 * robots_allowed = false."
 *
 * §15 is the reason this is not optional: "robots.txt is respected, requests
 * are rate-limited, only public pages are fetched, nothing behind a login is
 * touched, and no access control is circumvented. web_snapshots.robots_allowed
 * records the decision for every fetch, so the audit trail shows compliance
 * rather than asserting it."
 *
 * The parser is pure and the cache is separate, so the matching rules can be
 * tested without a network or a database.
 */
import type { Pool } from 'pg';

/** One group of rules from one or more User-agent lines. */
interface RobotsGroup {
  readonly agents: string[];
  readonly allow: string[];
  readonly disallow: string[];
  crawlDelaySeconds?: number;
}

export interface RobotsRules {
  readonly groups: readonly RobotsGroup[];
  /** True when the file had no parseable group at all. */
  readonly empty: boolean;
}

export function parseRobots(body: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') {
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (current === undefined || !lastLineWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (current === undefined) {
      continue;
    }

    if (field === 'disallow') {
      current.disallow.push(value);
    } else if (field === 'allow') {
      current.allow.push(value);
    } else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) {
        current.crawlDelaySeconds = delay;
      }
    }
  }

  return { groups, empty: groups.length === 0 };
}

/** Picks the group for our agent: an exact-ish match beats the wildcard. */
function groupFor(rules: RobotsRules, userAgentToken: string): RobotsGroup | undefined {
  const token = userAgentToken.toLowerCase();
  const specific = rules.groups.find((group) =>
    group.agents.some((agent) => agent !== '*' && token.includes(agent)),
  );
  return specific ?? rules.groups.find((group) => group.agents.includes('*'));
}

/**
 * robots path matching, with the two wildcards the de facto standard defines:
 * `*` for any run of characters and `$` to anchor the end.
 */
function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '') {
    return false;
  }
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const expression = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}${anchored ? '$' : ''}`).test(path);
}

export interface RobotsDecision {
  readonly allowed: boolean;
  readonly crawlDelaySeconds?: number;
  /** The rule that decided it, for the fetch log. */
  readonly matchedRule?: string;
}

export function decide(
  rules: RobotsRules,
  path: string,
  userAgentToken: string,
): RobotsDecision {
  const group = groupFor(rules, userAgentToken);
  if (group === undefined) {
    // No applicable group means nothing is forbidden.
    return { allowed: true };
  }

  // Longest match wins; an Allow of equal length beats a Disallow.
  let bestDisallow = '';
  for (const pattern of group.disallow) {
    if (pathMatches(pattern, path) && pattern.length > bestDisallow.length) {
      bestDisallow = pattern;
    }
  }
  let bestAllow = '';
  for (const pattern of group.allow) {
    if (pathMatches(pattern, path) && pattern.length > bestAllow.length) {
      bestAllow = pattern;
    }
  }

  const decision: RobotsDecision = {
    allowed: bestDisallow === '' || bestAllow.length >= bestDisallow.length,
    ...(group.crawlDelaySeconds === undefined
      ? {}
      : { crawlDelaySeconds: group.crawlDelaySeconds }),
    ...(bestDisallow === '' && bestAllow === ''
      ? {}
      : { matchedRule: bestAllow.length >= bestDisallow.length ? `Allow: ${bestAllow}` : `Disallow: ${bestDisallow}` }),
  };
  return decision;
}

export interface CachedRobots {
  readonly body: string;
  readonly crawlDelaySeconds: number | undefined;
  readonly fetchedAt: Date;
}

/**
 * The 24h cache, in robots_cache.
 *
 * operator_fetch holds select, insert and update on this one table and nothing
 * else of its kind: it has to maintain the cache it obeys.
 */
export class RobotsCache {
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number,
  ) {}

  async read(host: string, now: Date): Promise<CachedRobots | undefined> {
    const { rows } = await this.pool.query<{
      body: string | null;
      crawl_delay_seconds: string | null;
      fetched_at: Date;
    }>(
      'SELECT body, crawl_delay_seconds, fetched_at FROM robots_cache WHERE host = $1',
      [host],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (now.getTime() - row.fetched_at.getTime() > this.ttlMs) {
      return undefined;
    }
    return {
      body: row.body ?? '',
      crawlDelaySeconds:
        row.crawl_delay_seconds === null ? undefined : Number(row.crawl_delay_seconds),
      fetchedAt: row.fetched_at,
    };
  }

  async write(
    host: string,
    body: string,
    crawlDelaySeconds: number | undefined,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO robots_cache (host, body, crawl_delay_seconds, fetched_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (host) DO UPDATE
         SET body = excluded.body,
             crawl_delay_seconds = excluded.crawl_delay_seconds,
             fetched_at = excluded.fetched_at`,
      [host, body, crawlDelaySeconds ?? null, now],
    );
  }
}
