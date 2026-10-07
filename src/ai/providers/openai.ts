/**
 * The OpenAI adapter (SPEC.md §1, §8, §22).
 *
 * One of three bake-off families. Chat Completions, non-streaming, single turn,
 * no tools: the system prompt and the nonce-delimited user message are two
 * messages, and `tools` is absent from the body rather than empty (§8).
 */
import {
  ProviderShapeError,
  numberAt,
  postJson,
  requireKey,
  usageOf,
} from './http';
import type { ModelProvider, ModelRequest, ModelResponse } from '../provider';
import type { VendorAdapterConfig } from './anthropic';

export const OPENAI_PROVIDER_ID = 'openai';

export function createOpenAiProvider(config: VendorAdapterConfig): ModelProvider {
  const base = (config.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');

  return {
    id: OPENAI_PROVIDER_ID,
    model: config.model,
    billable: true,

    async complete(modelRequest: ModelRequest): Promise<ModelResponse> {
      const key = requireKey(OPENAI_PROVIDER_ID, 'OPENAI_API_KEY');

      const { json, latencyMs } = await postJson(
        OPENAI_PROVIDER_ID,
        `${base}/v1/chat/completions`,
        { authorization: `Bearer ${key}` },
        {
          model: config.model,
          // max_completion_tokens, not max_tokens: the older field is rejected
          // by the reasoning models this family now leads with.
          max_completion_tokens: modelRequest.maxOutputTokens,
          temperature: modelRequest.temperature,
          messages: [
            { role: 'system', content: modelRequest.system },
            { role: 'user', content: modelRequest.user },
          ],
        },
        modelRequest.timeoutMs,
      );

      const payload = json as {
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
        model?: string;
      };

      const text = payload.choices?.[0]?.message?.content ?? '';
      if (typeof text !== 'string' || text === '') {
        throw new ProviderShapeError(OPENAI_PROVIDER_ID, 'no message content');
      }

      return {
        text,
        usage: usageOf(
          numberAt(json, 'usage', 'prompt_tokens'),
          numberAt(json, 'usage', 'completion_tokens'),
          numberAt(json, 'usage', 'prompt_tokens_details', 'cached_tokens'),
        ),
        latencyMs,
        ...(payload.model === undefined ? {} : { servedModel: payload.model }),
      };
    },
  };
}
