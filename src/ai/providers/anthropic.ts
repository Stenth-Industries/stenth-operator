/**
 * The Anthropic adapter (SPEC.md §1, §8, §22).
 *
 * One of three bake-off families. Nothing here chooses it: the model id comes
 * from configuration, and §1 freezes the runtime provider to the Day 6
 * evaluation.
 *
 * Messages API, non-streaming, single turn, no tools. `tools` is absent from the
 * request body because §8 says the isolated call has none — and absent rather
 * than empty, so there is nothing for a later edit to fill in.
 */
import {
  ProviderShapeError,
  numberAt,
  postJson,
  requireKey,
  usageOf,
} from './http';
import type { ModelProvider, ModelRequest, ModelResponse } from '../provider';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/** Pinned: a request shape is part of the contract, not a moving default. */
const API_VERSION = '2023-06-01';

export interface VendorAdapterConfig {
  /** From configuration. There is deliberately no default model id. */
  readonly model: string;
  readonly baseUrl?: string | undefined;
}

export function createAnthropicProvider(config: VendorAdapterConfig): ModelProvider {
  const base = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    id: ANTHROPIC_PROVIDER_ID,
    model: config.model,
    billable: true,

    async complete(modelRequest: ModelRequest): Promise<ModelResponse> {
      const key = requireKey(ANTHROPIC_PROVIDER_ID, 'ANTHROPIC_API_KEY');

      const { json, latencyMs } = await postJson(
        ANTHROPIC_PROVIDER_ID,
        `${base}/v1/messages`,
        { 'x-api-key': key, 'anthropic-version': API_VERSION },
        {
          model: config.model,
          max_tokens: modelRequest.maxOutputTokens,
          temperature: modelRequest.temperature,
          system: modelRequest.system,
          messages: [{ role: 'user', content: modelRequest.user }],
        },
        modelRequest.timeoutMs,
      );

      const payload = json as {
        content?: { type?: string; text?: string }[];
        model?: string;
        stop_reason?: string;
      };

      // A safety decline arrives as HTTP 200 with stop_reason "refusal" and no
      // usable content, so the stop reason is read before the content. Reported
      // as an empty answer: the strict parse then fails, the extraction is
      // stored with valid = false, and the page stops there (§8).
      if (payload.stop_reason === 'refusal') {
        return {
          text: '',
          usage: usageOf(
            numberAt(json, 'usage', 'input_tokens'),
            numberAt(json, 'usage', 'output_tokens'),
            numberAt(json, 'usage', 'cache_read_input_tokens'),
          ),
          latencyMs,
          ...(payload.model === undefined ? {} : { servedModel: payload.model }),
        };
      }

      const text = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      if (text === '') {
        throw new ProviderShapeError(ANTHROPIC_PROVIDER_ID, 'no text content block');
      }

      return {
        text,
        usage: usageOf(
          numberAt(json, 'usage', 'input_tokens'),
          numberAt(json, 'usage', 'output_tokens'),
          numberAt(json, 'usage', 'cache_read_input_tokens'),
        ),
        latencyMs,
        ...(payload.model === undefined ? {} : { servedModel: payload.model }),
      };
    },
  };
}
