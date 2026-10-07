/**
 * The three bake-off adapters (SPEC.md §1, §8, §17, §22).
 *
 * Driven against a local stub that speaks each vendor's response shape, on
 * loopback. **No real provider is contacted and no real key exists**: the
 * adapters take a base URL precisely so the request they build can be inspected
 * without spending money or choosing a winner.
 *
 * What is asserted is the part that must be identical across the three, because
 * §22 ranks models and not harnesses: no tools in the body, the static prompt
 * and the nonce-delimited block in the right places, the configured model id,
 * the caps, and usage mapped onto one shape. Plus the §17 rule that a key is
 * read from the environment at call time and never appears in a URL, a log or
 * an error.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createAnthropicProvider } from '../../src/ai/providers/anthropic';
import { createGoogleProvider } from '../../src/ai/providers/google';
import { createOpenAiProvider } from '../../src/ai/providers/openai';
import { ProviderHttpError } from '../../src/ai/providers/http';
import type { ModelProvider, ModelRequest } from '../../src/ai/provider';

const SYSTEM = 'static version-pinned system prompt';
const USER = '<<<UNTRUSTED nonce=deadbeefdeadbeefdeadbeefdeadbeef>>>\npage text\n<<<END deadbeefdeadbeefdeadbeefdeadbeef>>>';

const request: ModelRequest = {
  system: SYSTEM,
  user: USER,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  temperature: 0,
};

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

describe('the vendor adapters build one request shape (§8, §22)', () => {
  let server: Server;
  let base: string;
  let seen: Seen[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((incoming: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        seen.push({
          method: incoming.method ?? '',
          url: incoming.url ?? '',
          headers: incoming.headers,
          body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
        });
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
  });

  afterEach(() => {
    seen = [];
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  const families: {
    name: string;
    variable: string;
    make: () => ModelProvider;
    reply: unknown;
    expectedText: string;
  }[] = [
    {
      name: 'anthropic',
      variable: 'ANTHROPIC_API_KEY',
      make: () => createAnthropicProvider({ model: 'configured-anthropic-model', baseUrl: base }),
      reply: {
        model: 'served-anthropic-model',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: 3 },
      },
      expectedText: '{"ok":true}',
    },
    {
      name: 'openai',
      variable: 'OPENAI_API_KEY',
      make: () => createOpenAiProvider({ model: 'configured-openai-model', baseUrl: base }),
      reply: {
        model: 'served-openai-model',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 111,
          completion_tokens: 22,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
      expectedText: '{"ok":true}',
    },
    {
      name: 'google',
      variable: 'GOOGLE_API_KEY',
      make: () => createGoogleProvider({ model: 'configured-google-model', baseUrl: base }),
      reply: {
        modelVersion: 'served-google-model',
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 111,
          candidatesTokenCount: 22,
          cachedContentTokenCount: 3,
        },
      },
      expectedText: '{"ok":true}',
    },
  ];

  describe.each(families)('$name', (family) => {
    it('declares itself billable, so the handler refuses it unless enabled', () => {
      expect(family.make().billable).toBe(true);
    });

    it('uses the configured model id, with no default of its own', () => {
      expect(family.make().model).toBe(`configured-${family.name}-model`);
    });

    it('refuses to run without its key, naming the variable and not the value', async () => {
      const provider = family.make();
      await expect(provider.complete(request)).rejects.toThrow(
        new RegExp(`needs ${family.variable} in the environment`),
      );
      expect(seen).toHaveLength(0);
    });

    it('sends no tools field of any kind (§8)', async () => {
      process.env[family.variable] = 'test-key-not-real';
      reply = { status: 200, body: family.reply };
      await family.make().complete(request);

      const body = JSON.stringify(seen[0]?.body);
      for (const forbidden of [
        'tools', 'tool_choice', 'functions', 'function_call', 'toolConfig',
        'tool_config', 'code_execution', 'web_search',
      ]) {
        expect(body, forbidden).not.toContain(forbidden);
      }
    });

    it('carries the static prompt and the nonce block, and the §8 caps', async () => {
      process.env[family.variable] = 'test-key-not-real';
      reply = { status: 200, body: family.reply };
      await family.make().complete(request);

      const body = JSON.stringify(seen[0]?.body);
      expect(body).toContain(SYSTEM);
      expect(body).toContain('<<<UNTRUSTED nonce=');
      expect(body).toContain('4000');
      // Deterministic: temperature zero, every family.
      expect(body).toMatch(/"temperature":0/);
    });

    it('maps usage onto one shape and reports the served model', async () => {
      process.env[family.variable] = 'test-key-not-real';
      reply = { status: 200, body: family.reply };
      const response = await family.make().complete(request);

      expect(response.text).toBe(family.expectedText);
      expect(response.usage).toStrictEqual({
        inputTokens: 111,
        outputTokens: 22,
        cachedTokens: 3,
      });
      expect(response.servedModel).toBe(`served-${family.name}-model`);
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('never puts the key in the URL (§17)', async () => {
      process.env[family.variable] = 'test-key-not-real';
      reply = { status: 200, body: family.reply };
      await family.make().complete(request);
      expect(seen[0]?.url).not.toContain('test-key-not-real');
      expect(seen[0]?.url).not.toMatch(/key=/i);
    });

    it('does not leak the key into an error message', async () => {
      process.env[family.variable] = 'test-key-not-real';
      reply = { status: 429, body: { error: { message: 'slow down' } } };
      const error = await family.make().complete(request).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as Error).message).not.toContain('test-key-not-real');
      expect((error as Error).message).toContain('429');
    });

    it('does not retry: a second billable call is the reservation\'s problem', async () => {
      process.env[family.variable] = 'test-key-not-real';
      reply = { status: 500, body: { error: 'boom' } };
      await family.make().complete(request).catch(() => undefined);
      expect(seen).toHaveLength(1);
    });
  });

  it('reads an Anthropic safety decline as an empty answer, not as content', async () => {
    // A decline arrives as HTTP 200 with stop_reason "refusal". Returning an
    // empty answer makes the strict parse fail, which stores the extraction
    // with valid = false and stops the page there (§8) — rather than throwing,
    // which would leave the reservation ambiguous for no reason.
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
    reply = {
      status: 200,
      body: {
        model: 'served-anthropic-model',
        stop_reason: 'refusal',
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    };
    const response = await createAnthropicProvider({
      model: 'configured-anthropic-model',
      baseUrl: base,
    }).complete(request);
    expect(response.text).toBe('');
    expect(response.usage.inputTokens).toBe(10);
  });

  it('rejects a response with no usable content', async () => {
    process.env.OPENAI_API_KEY = 'test-key-not-real';
    reply = { status: 200, body: { choices: [{ message: { content: '' } }] } };
    await expect(
      createOpenAiProvider({ model: 'm', baseUrl: base }).complete(request),
    ).rejects.toThrow(/unexpected response/);
  });
});
