/**
 * Provider registration (SPEC.md §1, §22).
 *
 * Importing a provider adapter must not make it the runtime provider: §1
 * freezes that choice to the Day 6 evaluation. So registration and selection
 * are two steps — this file makes adapters *available*, and MODEL_PROVIDER
 * picks one.
 *
 * One adapter exists today. The offline provider reaches no network and costs
 * nothing, which is what lets the whole Day 4 boundary run end to end before a
 * provider has been chosen or a key exists. Candidate adapters for the Day 6
 * bake-off are a decision for the operator, not a default chosen here.
 */
import { registerProvider, registeredProviders } from '../provider';

import { offlineProvider } from './offline';

/** Idempotent: safe to call from a worker boot and from a test. */
export function registerAvailableProviders(): void {
  const already = new Set(registeredProviders());
  for (const provider of [offlineProvider]) {
    if (!already.has(provider.id)) {
      registerProvider(provider);
    }
  }
}
