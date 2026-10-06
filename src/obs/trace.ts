/**
 * Trace ids (SPEC.md §16).
 *
 * A trace_id is a ULID created at the root of every pipeline run and propagated
 * through every job, model call, fetcher request, snapshot, extraction,
 * assessment, draft and approval. One index, one query, and any outcome can be
 * replayed from its origin.
 */
import { ulid } from 'ulid';

const TRACE_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Creates a new trace id at the root of a run. */
export function newTraceId(): string {
  return ulid();
}

export function isTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value);
}

/**
 * Accepts an inbound trace id, or mints one. Inbound ids arrive on internal
 * requests (the worker calling the fetcher, §8) and are only honoured when they
 * are well-formed, so a caller cannot inject arbitrary text into every log line.
 */
export function adoptTraceId(inbound: string | null | undefined): string {
  if (typeof inbound === 'string' && isTraceId(inbound)) {
    return inbound;
  }
  return newTraceId();
}

/** The header the trace id travels on across internal service calls. */
export const TRACE_HEADER = 'x-trace-id';
