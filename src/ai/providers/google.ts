/**
 * The Google adapter (SPEC.md §1, §8, §22).
 *
 * One of three bake-off families. generateContent, non-streaming, single turn,
 * no tools: the static prompt goes in systemInstruction and the nonce-delimited
 * block is the only user part. `tools` is absent from the body (§8).
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

export const GOOGLE_PROVIDER_ID = 'google';

export function createGoogleProvider(config: VendorAdapterConfig): ModelProvider {
  const base = (config.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
    /\/$/,
    '',
  );

  return {
    id: GOOGLE_PROVIDER_ID,
    model: config.model,
    billable: true,

    async complete(modelRequest: ModelRequest): Promise<ModelResponse> {
      const key = requireKey(GOOGLE_PROVIDER_ID, 'GOOGLE_API_KEY');

      // The key goes in a header, not the query string: a URL reaches access
      // logs and error messages, and §17 keeps the credential out of both.
      const { json, latencyMs } = await postJson(
        GOOGLE_PROVIDER_ID,
        `${base}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
        { 'x-goog-api-key': key },
        {
          systemInstruction: { parts: [{ text: modelRequest.system }] },
          contents: [{ role: 'user', parts: [{ text: modelRequest.user }] }],
          generationConfig: {
            maxOutputTokens: modelRequest.maxOutputTokens,
            temperature: modelRequest.temperature,
            responseMimeType: 'application/json',
          },
        },
        modelRequest.timeoutMs,
      );

      const payload = json as {
        candidates?: {
          content?: { parts?: { text?: string }[] };
          finishReason?: string;
        }[];
        modelVersion?: string;
      };

      const text = (payload.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');

      if (text === '') {
        // A safety block arrives as a candidate with no parts, so an empty
        // answer here is the same case as Anthropic's refusal stop reason.
        throw new ProviderShapeError(
          GOOGLE_PROVIDER_ID,
          `no text part (finishReason ${payload.candidates?.[0]?.finishReason ?? 'absent'})`,
        );
      }

      return {
        text,
        usage: usageOf(
          numberAt(json, 'usageMetadata', 'promptTokenCount'),
          numberAt(json, 'usageMetadata', 'candidatesTokenCount'),
          numberAt(json, 'usageMetadata', 'cachedContentTokenCount'),
        ),
        latencyMs,
        ...(payload.modelVersion === undefined ? {} : { servedModel: payload.modelVersion }),
      };
    },
  };
}
