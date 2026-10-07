/**
 * The model provider boundary (SPEC.md §1, §8, §22).
 *
 * §1 freezes "one runtime provider, chosen by eval on Day 6", and §22 says that
 * choice weighs Precision@5 and @10, rejection precision, recall, grounding
 * rate, hard-disqualifier failures, cost per assessed company and p95 latency
 * together, across overlapping batches. None of that can be known on Day 4. So
 * Day 4 builds the seam and refuses to choose:
 *
 *   * No provider is a default. `resolveProvider` reads MODEL_PROVIDER from the
 *     environment and throws if it is unset or unregistered, so a deployment
 *     that has not made the decision fails at boot rather than inheriting
 *     whichever adapter happened to be imported first.
 *   * The request shape is deliberately plain — a system prompt, one user
 *     message, caps, a timeout. Nothing provider-specific leaks into the
 *     caller, which is what makes two candidates comparable in the Day 6
 *     bake-off: it has to compare models, not harnesses.
 *   * `tools` does not exist in the request type. §8's no-tools rule is not a
 *     flag set to false that a later edit could set to true; there is no field.
 */

/** Usage as the provider reports it. Cost is computed from model_pricing (§16). */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

export interface ModelRequest {
  /** Static and version-pinned (§8). Never carries page content. */
  readonly system: string;
  /** The one variable part: nonce-delimited untrusted text (§8). */
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Zero, for an isolated call. Kept explicit so the value is auditable. */
  readonly temperature: number;
}

export interface ModelResponse {
  readonly text: string;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
  /** What to record in llm_calls.model — the model actually served, if known. */
  readonly servedModel?: string;
}

export interface ModelProvider {
  /** Stable id, used in config, in llm_calls.provider and in model_pricing. */
  readonly id: string;
  /** The model id, used in llm_calls.model and in model_pricing. */
  readonly model: string;
  /**
   * True when the adapter reaches a real API over the network.
   *
   * The extract handler refuses to run a billable provider unless
   * MODEL_CALLS_ENABLED is set, so an offline test or a dry run cannot become a
   * production call by accident, and a real call is an explicit decision.
   */
  readonly billable: boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

const registry = new Map<string, ModelProvider>();

export function registerProvider(provider: ModelProvider): void {
  if (registry.has(provider.id)) {
    throw new Error(`A provider is already registered as "${provider.id}"`);
  }
  registry.set(provider.id, provider);
}

export function registeredProviders(): string[] {
  return [...registry.keys()].sort();
}

/** Tests register their own and need a clean registry between cases. */
export function clearProviders(): void {
  registry.clear();
}

export function getProvider(id: string): ModelProvider {
  const provider = registry.get(id);
  if (provider === undefined) {
    throw new Error(
      `No model provider is registered as "${id}". Registered: ` +
        `${registeredProviders().join(', ') || '(none)'}. The runtime provider is ` +
        'chosen by the Day 6 evaluation (§1, §22) and set with MODEL_PROVIDER; ' +
        'there is deliberately no default.',
    );
  }
  return provider;
}

/**
 * The configured provider, or a refusal.
 *
 * Deliberately not "pick the only one registered": that would quietly make the
 * first adapter anyone imports the production choice.
 */
export function resolveProvider(configuredId: string | undefined): ModelProvider {
  if (configuredId === undefined || configuredId === '') {
    throw new Error(
      'MODEL_PROVIDER is not set. Day 4 builds the provider seam and does not ' +
        'choose a provider: §1 freezes that choice to the Day 6 evaluation, and ' +
        '§22 decides it from the full metric set. Set MODEL_PROVIDER once that ' +
        'decision is recorded.',
    );
  }
  return getProvider(configuredId);
}
