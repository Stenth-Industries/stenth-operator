/**
 * The transport every vendor adapter shares (SPEC.md §1, §22).
 *
 * One request shape, one timeout, one error type, for all three bake-off
 * families. §22 ranks providers on accuracy, schema adherence, injection
 * resistance, latency and cost — and that comparison is only about the models
 * if the harness around them is identical. A per-vendor SDK would give each
 * candidate its own retry policy, its own timeout semantics and its own default
 * parameters, and the bake-off would be measuring those.
 *
 * Raw HTTP over undici, which the fetcher already depends on, rather than three
 * vendor SDKs: the isolated call is one non-streaming request with no tools, no
 * files and no streaming, which is the smallest surface any of these APIs has.
 * Three SDKs would add three dependency trees to a repository whose §19 rule 5
 * and no-mail lint both scan that tree, for no behaviour we need. If the
 * Day 6 decision is to use a vendor SDK instead, it replaces this one file.
 */
import { request } from 'undici';

import type { ModelUsage } from '../provider';

export class ProviderHttpError extends Error {
  override readonly name = 'ProviderHttpError';

  constructor(
    readonly providerId: string,
    readonly status: number,
    /** The vendor's own message, truncated. Never a credential. */
    readonly detail: string,
  ) {
    super(`${providerId} returned HTTP ${status}: ${detail}`);
  }
}

export class ProviderShapeError extends Error {
  override readonly name = 'ProviderShapeError';

  constructor(providerId: string, what: string) {
    super(`${providerId} returned an unexpected response: ${what}`);
  }
}

/**
 * One JSON POST, with a hard timeout and no retry.
 *
 * No retry on purpose. The caller holds a budget reservation by the time this
 * runs, and a silent retry inside the transport would be a second billable call
 * that the reservation never accounted for — exactly the race the reservation
 * design exists to close. A failure is returned to the caller, which leaves the
 * reservation open for reconciliation.
 */
export async function postJson(
  providerId: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ json: unknown; latencyMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await request(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.body.text();
    const latencyMs = Date.now() - startedAt;

    if (response.statusCode < 200 || response.statusCode >= 300) {
      // Bounded, because a vendor error body can be long and this reaches logs.
      throw new ProviderHttpError(providerId, response.statusCode, text.slice(0, 500));
    }

    try {
      return { json: JSON.parse(text) as unknown, latencyMs };
    } catch {
      throw new ProviderShapeError(providerId, 'the body was not JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a number from an unknown payload, defaulting to zero. */
export function numberAt(source: unknown, ...path: string[]): number {
  let cursor: unknown = source;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) {
      return 0;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0;
}

export function usageOf(
  input: number,
  output: number,
  cached: number,
): ModelUsage {
  return { inputTokens: input, outputTokens: output, cachedTokens: cached };
}

/**
 * The key, read from the environment at call time.
 *
 * At call time rather than at construction so a key never sits on a long-lived
 * object, and from the environment only: §17 keeps it out of source, out of
 * logs and out of the database. It is never returned, printed or put in an
 * error message — a missing key names the variable, not its value.
 */
export function requireKey(providerId: string, variable: string): string {
  const value = process.env[variable];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${providerId} needs ${variable} in the environment (§17). It is read at ` +
        'call time, never stored and never logged.',
    );
  }
  return value;
}
