/**
 * isolated() — the only function that ever sees page content (SPEC.md §8).
 *
 * Everything in this file is one side of the trust boundary in §5. Above it,
 * input is assumed hostile. Below it, the only thing that crosses is an object
 * whose shape was declared in advance.
 *
 * §8's controls, each implemented here and each asserted in a test rather than
 * assumed:
 *
 *   * The request is built without a tools field, and a runtime assertion
 *     throws if one is present. The request type has no such field either, so
 *     the assertion is a second lock on a door that has no handle.
 *   * The system prompt is static and version-pinned.
 *   * The untrusted text arrives in a single user message wrapped as
 *     <<<UNTRUSTED nonce=…>>> … <<<END nonce>>>, with a random nonce per call.
 *     A page containing a literal end-marker cannot close the block, because it
 *     cannot guess the nonce.
 *   * Output is parsed with a strict Zod schema. One repair attempt on failure,
 *     then the extraction is stored with valid = false and the pipeline stops
 *     for that page.
 *   * Input capped at 150,000 characters, truncated with a logged note. Output
 *     tokens capped. 60-second timeout.
 *
 * What this file deliberately does not import: a database client, the fetcher,
 * anything that could send mail. §19 rule 4 — "src/ai/isolated.ts imports
 * nothing that holds a credential. If that import ever becomes necessary, stop
 * and raise a blocker." The provider is handed in; it is not reached for.
 */
import { createHash, randomBytes } from 'node:crypto';

import { getLogger } from '../obs/log';

import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_REPAIR_INSTRUCTION,
  EXTRACTION_RESPONSE_CONTRACT,
  EXTRACTION_SYSTEM_PROMPT,
} from './prompts/extraction-v1';
import type { ModelProvider, ModelRequest, ModelUsage } from './provider';
import { SanitiserRejection, sanitiseExtraction } from './sanitise';
import {
  isolatedExtractionSchema,
  type IsolatedExtraction,
} from './schemas/extraction-v1';

/** §8: "Input capped at 150,000 characters (truncated with a logged note)". */
export const MAX_UNTRUSTED_CHARS = 150_000;

/** §8: "output tokens capped, 60-second timeout". */
export const MAX_OUTPUT_TOKENS = 4_000;
export const TIMEOUT_MS = 60_000;

/** Deterministic, so the same page produces the same temperature every time. */
const TEMPERATURE = 0;

export const PROMPT_VERSION = EXTRACTION_PROMPT_VERSION;

export interface IsolatedResult {
  readonly valid: boolean;
  readonly extraction?: IsolatedExtraction;
  /** Machine-readable, no page content: this is logged and stored. */
  readonly validationErrors?: readonly { path: string; rule: string }[];
  readonly attempts: number;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
  /** sha256 of the exact prompt pair, so a call is identifiable without storing it. */
  readonly requestHash: string;
  readonly truncated: boolean;
  readonly servedModel?: string;
}

/**
 * Throws if a request object carries anything that could grant a capability.
 *
 * §8 asks for a runtime assertion, and the useful version of it checks the
 * object actually about to be sent rather than the type that described it:
 * a provider adapter is the one place a `tools` key could be introduced, and a
 * type does not survive into the adapter's own serialisation.
 */
export function assertNoCapabilities(request: object): void {
  const forbidden = [
    'tools',
    'tool_choice',
    'toolChoice',
    'functions',
    'function_call',
    'tool_use',
    'mcp_servers',
    'computer_use',
    'web_search',
    'file_search',
    'code_interpreter',
    'retrieval',
  ];
  for (const key of forbidden) {
    if (key in request) {
      throw new Error(
        `The isolated model request carries "${key}". The isolated call has no ` +
          'tools, ever (SPEC.md §8). This is a bug, not a configuration.',
      );
    }
  }
}

/** The nonce-delimited envelope of §8. */
export function wrapUntrusted(text: string, nonce: string): string {
  return `<<<UNTRUSTED nonce=${nonce}>>>\n${text}\n<<<END ${nonce}>>>`;
}

/**
 * 128 bits from the CSPRNG, per call.
 *
 * §23 case 6 asserts the nonce is not predictable: a page that contains a
 * literal `<<<END ...>>>` cannot close the block without guessing this.
 */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Identifies the input without storing it (§4 llm_calls.request_hash, §16).
 *
 * Over the system prompt and the page text, deliberately *not* over the wrapped
 * user message: that carries a fresh nonce per call, so a hash of it would
 * differ on every attempt and could never answer the question it exists for —
 * "has this exact input already been charged for?"
 */
function hashRequest(system: string, text: string): string {
  return createHash('sha256').update(`${system}\n\u0000\n${text}`, 'utf8').digest('hex');
}

/** The same hash, available before a call so the budget row can carry it. */
export function requestHashFor(text: string): string {
  return hashRequest(
    `${EXTRACTION_SYSTEM_PROMPT}\n\n${EXTRACTION_RESPONSE_CONTRACT}`,
    text.length > MAX_UNTRUSTED_CHARS ? text.slice(0, MAX_UNTRUSTED_CHARS) : text,
  );
}

/** Strips a markdown fence, which is the one repair worth doing in code. */
function unfence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

function parseStrict(
  raw: string,
  sourceUrl: string,
): { ok: true; value: IsolatedExtraction } | { ok: false; errors: { path: string; rule: string }[] } {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return { ok: false, errors: [{ path: '$', rule: 'not valid JSON' }] };
  }

  const parsed = isolatedExtractionSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      // Paths and rule names only. A Zod message can quote the offending value,
      // and the offending value is hostile page content.
      errors: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.') || '$',
        rule: issue.code,
      })),
    };
  }

  try {
    return { ok: true, value: sanitiseExtraction(parsed.data, sourceUrl) };
  } catch (error) {
    if (error instanceof SanitiserRejection) {
      return { ok: false, errors: [{ path: error.field, rule: error.rule }] };
    }
    throw error;
  }
}

export interface IsolatedInput {
  /** The untrusted page text. The only hostile string in this file. */
  readonly text: string;
  /** Used to filter next_urls to the same host. Not sent to the model. */
  readonly sourceUrl: string;
  readonly traceId: string;
}

/**
 * One extraction, with at most one repair attempt.
 *
 * Returns rather than throws on invalid output: §8 says the extraction is
 * stored with valid = false and the pipeline stops for that page, which is a
 * recorded outcome, not an error. The caller still has the usage numbers, so a
 * failed extraction is paid for and accounted for like any other.
 */
export async function isolatedExtract(
  provider: ModelProvider,
  input: IsolatedInput,
): Promise<IsolatedResult> {
  const log = getLogger();

  const truncated = input.text.length > MAX_UNTRUSTED_CHARS;
  if (truncated) {
    log.warn(
      {
        trace_id: input.traceId,
        chars: input.text.length,
        cap: MAX_UNTRUSTED_CHARS,
      },
      'untrusted text truncated to the §8 input cap',
    );
  }
  const text = truncated ? input.text.slice(0, MAX_UNTRUSTED_CHARS) : input.text;

  const nonce = newNonce();
  const system = `${EXTRACTION_SYSTEM_PROMPT}\n\n${EXTRACTION_RESPONSE_CONTRACT}`;
  const user = wrapUntrusted(text, nonce);

  // Accumulated across the repair attempt: both calls are billed, so both are
  // counted. A repair that is not paid for is a cost the budget never sees.
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let latencyMs = 0;
  let attempts = 0;
  let errors: { path: string; rule: string }[] = [];
  let servedModel: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attempts = attempt;
    const request: ModelRequest = {
      system: attempt === 1 ? system : `${system}\n\n${EXTRACTION_REPAIR_INSTRUCTION}`,
      user,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: TIMEOUT_MS,
      temperature: TEMPERATURE,
    };
    assertNoCapabilities(request);

    const response = await provider.complete(request);
    inputTokens += response.usage.inputTokens;
    outputTokens += response.usage.outputTokens;
    cachedTokens += response.usage.cachedTokens;
    latencyMs += response.latencyMs;
    servedModel = response.servedModel ?? servedModel;

    const parsed = parseStrict(response.text, input.sourceUrl);
    if (parsed.ok) {
      return {
        valid: true,
        extraction: parsed.value,
        attempts,
        usage: { inputTokens, outputTokens, cachedTokens },
        latencyMs,
        requestHash: hashRequest(system, text),
        truncated,
        ...(servedModel === undefined ? {} : { servedModel }),
      };
    }

    errors = parsed.errors;
    log.warn(
      { trace_id: input.traceId, attempt, errors },
      attempt === 1
        ? 'isolated extraction failed validation; one repair attempt remains'
        : 'isolated extraction failed validation after the repair attempt',
    );
  }

  return {
    valid: false,
    validationErrors: errors,
    attempts,
    usage: { inputTokens, outputTokens, cachedTokens },
    latencyMs,
    requestHash: hashRequest(system, text),
    truncated,
    ...(servedModel === undefined ? {} : { servedModel }),
  };
}
