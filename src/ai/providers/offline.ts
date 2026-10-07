/**
 * The offline provider (SPEC.md §1, §22).
 *
 * Not a mock bolted on by the tests: a registered provider with `billable:
 * false` that reaches no network and costs nothing. It exists because Day 4's
 * job is the boundary, and the boundary has to be runnable end to end — budget
 * gate, isolated call, strict parse, sanitiser, llm_calls row, extraction row —
 * before any provider has been chosen. §1 freezes that choice to Day 6.
 *
 * It answers from a fixture table keyed by the sha256 of the untrusted block,
 * so the same page always produces the same output and a test asserts on a real
 * extraction rather than on a stub. An unknown input returns a minimal honest
 * extraction — everything unknown, nothing invented — which is exactly what a
 * well-behaved model should return for a page it cannot read, and makes the
 * thin-content path observable without a paid call.
 */
import { createHash } from 'node:crypto';

import type { ModelProvider, ModelRequest, ModelResponse } from '../provider';
import { estimateTokens } from '../pricing';

export const OFFLINE_PROVIDER_ID = 'offline';
export const OFFLINE_MODEL = 'offline-fixture-v1';

/** Everything unknown: the correct answer for a page with nothing in it. */
export const EMPTY_EXTRACTION = {
  is_australian_law_firm: false,
  appears_to_be_barrister_chambers: false,
  appears_to_be_marketing_agency: false,
  appears_to_be_community_legal_centre: false,
  appears_parked_or_under_construction: false,
  lawyer_count_band: 'unknown',
  office_locations: [],
  primary_state: 'unknown',
  practice_areas: [],
  named_people: [],
  published_contacts: [],
} as const;

/** sha256 of the user message -> the raw text the provider should return. */
const fixtures = new Map<string, string>();

export function keyForUntrusted(userMessage: string): string {
  return createHash('sha256').update(userMessage, 'utf8').digest('hex');
}

/**
 * Registers a canned reply for a page.
 *
 * Keyed on the *page text* rather than the whole user message, because the
 * message carries a random nonce per call (§8) and a fixture keyed on it would
 * never match twice.
 */
export function setOfflineReply(pageText: string, reply: string): void {
  fixtures.set(keyForUntrusted(pageText), reply);
}

export function clearOfflineReplies(): void {
  fixtures.clear();
}

/** Recovers the page text from the nonce-delimited envelope. */
function unwrap(user: string): string {
  const match = /^<<<UNTRUSTED nonce=[0-9a-f]+>>>\n([\s\S]*)\n<<<END [0-9a-f]+>>>$/.exec(user);
  return match?.[1] ?? user;
}

export const offlineProvider: ModelProvider = {
  id: OFFLINE_PROVIDER_ID,
  model: OFFLINE_MODEL,
  billable: false,

  complete(request: ModelRequest): Promise<ModelResponse> {
    const pageText = unwrap(request.user);
    const reply = fixtures.get(keyForUntrusted(pageText)) ?? JSON.stringify(EMPTY_EXTRACTION);

    return Promise.resolve({
      text: reply,
      usage: {
        // Realistic enough for the budget arithmetic to be exercised, and
        // derived from the real prompt so a longer page costs more.
        inputTokens: estimateTokens(request.system) + estimateTokens(request.user),
        outputTokens: estimateTokens(reply),
        cachedTokens: 0,
      },
      latencyMs: 0,
      servedModel: OFFLINE_MODEL,
    });
  },
};
