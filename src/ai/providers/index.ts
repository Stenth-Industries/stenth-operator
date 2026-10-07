/**
 * Provider registration (SPEC.md §1, §22).
 *
 * Importing an adapter must not make it the runtime provider: §1 freezes that
 * choice to the Day 6 evaluation. So registration and selection are two steps —
 * this file makes adapters *available*, and MODEL_PROVIDER picks one.
 *
 * Four are available. The offline adapter reaches no network and costs nothing,
 * which is what lets the whole Day 4 boundary run end to end before a provider
 * is chosen. The three vendor families are the §22 bake-off, and each registers
 * only when its model id is configured — a family with no model id is not a
 * candidate, and guessing one would be exactly the product decision this file
 * refuses to make.
 */
import { getConfig } from '../../config';
import { registerProvider, registeredProviders, type ModelProvider } from '../provider';

import { createAnthropicProvider } from './anthropic';
import { createGoogleProvider } from './google';
import { offlineProvider } from './offline';
import { createOpenAiProvider } from './openai';

/** Idempotent: safe to call from a worker boot and from a test. */
export function registerAvailableProviders(): void {
  const config = getConfig();
  const already = new Set(registeredProviders());

  const candidates: (ModelProvider | undefined)[] = [
    offlineProvider,
    config.ANTHROPIC_MODEL === undefined
      ? undefined
      : createAnthropicProvider({
          model: config.ANTHROPIC_MODEL,
          baseUrl: config.ANTHROPIC_BASE_URL,
        }),
    config.OPENAI_MODEL === undefined
      ? undefined
      : createOpenAiProvider({
          model: config.OPENAI_MODEL,
          baseUrl: config.OPENAI_BASE_URL,
        }),
    config.GOOGLE_MODEL === undefined
      ? undefined
      : createGoogleProvider({
          model: config.GOOGLE_MODEL,
          baseUrl: config.GOOGLE_BASE_URL,
        }),
  ];

  for (const provider of candidates) {
    if (provider !== undefined && !already.has(provider.id)) {
      registerProvider(provider);
    }
  }
}
