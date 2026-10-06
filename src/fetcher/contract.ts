/**
 * The worker/fetcher boundary (SPEC.md §8).
 *
 * The fetcher takes a target URL and a trace id, and nothing else. That is the
 * whole input, deliberately: everything a job payload could otherwise reach —
 * a proxy, a bind address, extra headers, a redirect budget, a timeout, a
 * credential — stays in the fetcher's own frozen policy, where a hostile or
 * buggy upstream cannot touch it.
 *
 * Both directions are parsed with Zod. The worker does not trust the fetcher's
 * reply either: the fetcher is the process that handles hostile input, so its
 * output is the least trustworthy thing in the privileged zone.
 */
import { z } from 'zod';

/** Bounded because it is a URL from a job, not from a person. */
const MAX_URL_LENGTH = 2_048;

export const fetchRequestSchema = z
  .object({
    /** The company the snapshot belongs to. */
    company_id: z.string().uuid(),
    url: z.string().min(1).max(MAX_URL_LENGTH),
    trace_id: z.string().min(1).max(64),
  })
  .strict();

export type FetchRequest = z.infer<typeof fetchRequestSchema>;

/** Why a fetch produced no snapshot. Mirrors FetchRefusal plus robots. */
export const fetchOutcomeSchema = z.enum([
  'stored',
  'robots_disallowed',
  'refused',
]);

export const fetchResponseSchema = z
  .object({
    outcome: fetchOutcomeSchema,
    /** Present when outcome is 'stored'. */
    snapshot_id: z.string().uuid().optional(),
    http_status: z.number().int().min(0).max(599).optional(),
    content_hash: z.string().max(64).optional(),
    bytes: z.number().int().min(0).optional(),
    /** Length of the extracted text, never the text itself. */
    text_length: z.number().int().min(0).optional(),
    robots_allowed: z.boolean(),
    final_url: z.string().max(MAX_URL_LENGTH).optional(),
    /** Stable machine reason, safe to log and to branch on. */
    reason: z.string().max(200).optional(),
    trace_id: z.string().max(64),
  })
  .strict();

export type FetchResponse = z.infer<typeof fetchResponseSchema>;

/** The header the shared secret travels on. */
export const AUTH_HEADER = 'x-fetcher-secret';
