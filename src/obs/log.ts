/**
 * Structured logging (SPEC.md §16, §17).
 *
 * pino, JSON to stdout, trace_id on every line. No APM in V1 — a grep by trace
 * id over a day of logs is sufficient at this volume.
 *
 * §17: "The log formatter redacts anything matching a key-shaped pattern or a
 * Bearer header before it reaches stdout." That is implemented here as a value
 * scrubber over both the message and the merged object, not as a convention
 * that every call site has to remember.
 */
import { pino, type Logger } from 'pino';

import { getConfig } from '../config';
import { newTraceId } from './trace';

export const REDACTED = '[redacted]';

/** Credentials in a connection string or URL: scheme://user:secret@host */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/** An Authorization header value, however it was embedded in a string. */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * key=value and "key": "value" forms, where the key's name marks it secret.
 *
 * Matched as a whole identifier and then split on _ - . so that a segment has
 * to equal a secret word. A \b word boundary would miss the name that matters
 * most here — FETCHER_SHARED_SECRET, where nothing delimits SECRET but an
 * underscore — and a bare substring match would redact the author of a log line
 * for containing "auth".
 */
const SECRET_ASSIGNMENT =
  /([A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*)(\s*[:=]\s*"?)((?:Bearer\s+)?[^\s",;&}]+)/g;

const SECRET_SEGMENTS = new Set([
  'key',
  'apikey',
  'secret',
  'token',
  'password',
  'passwd',
  'pwd',
  'auth',
  'credential',
  'credentials',
]);

function nameIsSecret(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[_.-]/)
    .some((segment) => SECRET_SEGMENTS.has(segment));
}

/** Known provider key prefixes, which are key-shaped by construction. */
const PREFIXED_KEY =
  /\b(sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{10,}|AKIA[A-Z0-9]{8,}|tskey-[A-Za-z0-9-]{8,})/g;

/**
 * Generic key-shaped token: a long mixed-case alphanumeric run.
 *
 * Deliberately narrow. Requiring an upper-case letter, a lower-case letter and
 * a digit across at least 40 characters catches base64 and base62 secrets while
 * sparing the identifiers that legitimately appear in logs — lower-case hex
 * content hashes, and upper-case 26-character ULID trace ids.
 */
const GENERIC_KEY_SHAPED = /\b[A-Za-z0-9_\-+/]{40,}={0,2}\b/g;

function looksLikeKey(token: string): boolean {
  return (
    /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token)
  );
}

/** Redacts key-shaped values and Bearer headers from one string. */
export function scrubString(value: string): string {
  return value
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(SECRET_ASSIGNMENT, (match, name: string, separator: string) =>
      nameIsSecret(name) ? `${name}${separator}${REDACTED}` : match,
    )
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(PREFIXED_KEY, REDACTED)
    .replace(GENERIC_KEY_SHAPED, (token) =>
      looksLikeKey(token) ? REDACTED : token,
    );
}

const MAX_DEPTH = 8;

/** Keys whose value is replaced outright, whatever shape it has. */
const SECRET_KEY_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'password_hash',
  'passwordhash',
  'secret',
  'token',
  'apikey',
  'api_key',
  'database_url',
  'admin_database_url',
  'model_api_key',
  'fetcher_shared_secret',
  'session_signing_key',
]);

/** Deep-scrubs a value for logging. Cycle-safe and depth-capped. */
export function scrubValue(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof input === 'string') {
    return scrubString(input);
  }
  if (input === null || typeof input !== 'object') {
    return input;
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  if (seen.has(input)) {
    return '[circular]';
  }
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((item) => scrubValue(item, depth + 1, seen));
  }
  if (input instanceof Error) {
    return {
      type: input.name,
      message: scrubString(input.message),
      stack: input.stack === undefined ? undefined : scrubString(input.stack),
    };
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    output[key] = SECRET_KEY_NAMES.has(key.toLowerCase())
      ? REDACTED
      : scrubValue(value, depth + 1, seen);
  }
  return output;
}

/**
 * The process-level trace id. It keeps the literal §16 guarantee — trace_id on
 * every line — true for boot and shutdown lines that belong to no pipeline run.
 */
export const processTraceId = newTraceId();

function build(): Logger {
  const config = getConfig();
  return pino({
    level: config.LOG_LEVEL,
    base: {
      service: config.SERVICE_NAME,
      trace_id: processTraceId,
    },
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => scrubValue(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((arg) =>
          typeof arg === 'string' ? scrubString(arg) : arg,
        );
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  });
}

let root: Logger | undefined;

/** The root logger. JSON to stdout. */
export function getLogger(): Logger {
  root ??= build();
  return root;
}

/** A child logger bound to a trace id (§16). */
export function withTrace(traceId: string): Logger {
  return getLogger().child({ trace_id: traceId });
}
