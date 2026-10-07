/**
 * The web.extract handler (SPEC.md §6, §8, §9, §16).
 *
 * §6: web.extract does "isolated tool-less extraction, validated" and enqueues
 * company.assess "when all pages done". company.assess is Day 6, so this stores
 * the extraction and stops there — the enqueue arrives with the handler that
 * can act on it, as web.fetch's did.
 *
 * The order of operations is the design, and every step before the call is a
 * reason not to make it:
 *
 *   1. Load the snapshot and the firm's canonical domain.
 *   2. Is there already an extraction for this (snapshot, schema, model)? Then
 *      the work is done. No call. §4's unique key is the guarantee; this lookup
 *      is the fast path that keeps a retry from paying twice.
 *   3. The eligibility gate (src/pipeline/evidence.ts). Deterministic, and it
 *      refuses a page that cannot ground an extraction.
 *   4. Are model calls enabled at all, and is this provider billable?
 *   5. The budget gate (§16), which runs *before* the call.
 *   6. The isolated call — the only step that sees page content.
 *   7. One transaction: the extraction, the llm_calls row, the event.
 *
 * Steps 2 to 5 cost nothing and can each stop the job. That ordering is §10's
 * "cheap deterministic ones first, so no model is paid to reject an obvious
 * miss", applied one stage earlier than §10 describes it.
 */
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import {
  finalizeCall,
  recordRefusal,
  reserveCall,
  type RefusalReason,
} from '../../ai/budget';
import { isolatedExtract, MAX_OUTPUT_TOKENS, PROMPT_VERSION, requestHashFor } from '../../ai/isolated';
import { attestValidated, type Validated } from '../../ai/privileged';
import { estimateTokens } from '../../ai/pricing';
import type { ModelProvider } from '../../ai/provider';
import {
  EXTRACTION_SCHEMA_VERSION,
  extractionPayloadSchema,
  type ExtractionPayload,
} from '../../ai/schemas/extraction-v1';
import { SIGNALS_VERSION, type TierASignals } from '../../fetch/signals';
import { ControlRefusal, type ClaimedJob } from '../../jobs/queue';
import { withTrace } from '../../obs/log';
import {
  assessEligibility,
  type IneligibilityReason,
  type SnapshotForEligibility,
} from '../../pipeline/evidence';

export const webExtractPayloadSchema = z
  .object({
    snapshot_id: z.string().uuid(),
  })
  .strict();

/**
 * Every reason web.extract can be blocked, as a distinct machine token.
 *
 * These reach `jobs.last_error`, the `job.blocked` event payload and the
 * operator's screen, and each one needs a different human response — so one
 * generic "blocked" would be useless:
 *
 *   model_calls_disabled   MODEL_CALLS_ENABLED is not set and the configured
 *                          provider spends money. Set the switch.
 *   provider_unconfigured  No provider is registered under MODEL_PROVIDER.
 *                          Record the Day 6 decision and configure it.
 *   budget_hard_stop       The §16 ceiling. Raise it, or wait for the month.
 *   missing_pricing        No model_pricing row in force. Add the price.
 *   reservation_in_flight  A reservation for this exact work already exists and
 *                          its outcome is unknown. Reconcile it against the
 *                          provider's billing; do not retry.
 *   security_refusal       A §8 control refused the input itself.
 */
export type ExtractBlockedReason =
  | 'model_calls_disabled'
  | 'provider_unconfigured'
  | RefusalReason
  | 'security_refusal';

/**
 * Raised when a control stopped the job before any provider was contacted, or
 * before its result could be believed.
 *
 * A ControlRefusal, so the worker loop moves the job to blocked — terminal and
 * alerting (§6) — rather than retrying it. None of these improves by being
 * tried again: the ceiling is still the ceiling, the price is still missing,
 * the switch is still off, and an ambiguous charge is still ambiguous.
 */
export class ExtractBlocked extends ControlRefusal {
  override readonly name = 'ExtractBlocked';

  constructor(
    override readonly reason: ExtractBlockedReason,
    detail: string,
  ) {
    super(reason, detail);
  }
}

/**
 * The identity of one unit of extraction work.
 *
 * Snapshot, schema version, extractor model and request identity — exactly what
 * the review asked for, as one unique string. Two workers that compute this key
 * cannot both reach the provider, because `llm_calls.reservation_key` is unique
 * while it is set.
 */
export function reservationKeyFor(
  snapshotId: string,
  model: string,
  requestHash: string,
): string {
  return `web.extract:${snapshotId}:${EXTRACTION_SCHEMA_VERSION}:${model}:${requestHash}`;
}

export interface WebExtractDeps {
  readonly pool: Pool;
  readonly provider: ModelProvider;
  /** False unless MODEL_CALLS_ENABLED is set, so a real call is deliberate. */
  readonly modelCallsEnabled: boolean;
}

export type WebExtractResult =
  | { readonly outcome: 'extracted'; readonly extractionId: string; readonly valid: boolean }
  | { readonly outcome: 'already_extracted'; readonly extractionId: string }
  | { readonly outcome: 'skipped'; readonly reason: IneligibilityReason };

interface SnapshotRow extends SnapshotForEligibility {
  readonly signals: TierASignals | null;
}

async function loadSnapshot(
  db: Pool,
  snapshotId: string,
): Promise<SnapshotRow | undefined> {
  // web_snapshots, not usable_snapshots: the gate has to see an ineligible row
  // in order to report *why* it is ineligible. The view's job is to stop a
  // later query treating a non-2xx row as evidence; the gate's job is to say so
  // out loud.
  const { rows } = await db.query<SnapshotRow>(
    `SELECT s.id, s.company_id, s.url, s.http_status, s.robots_allowed, s.text,
            s.signals, c.canonical_domain::text AS canonical_domain
       FROM web_snapshots s
       JOIN companies c ON c.id = s.company_id
      WHERE s.id = $1`,
    [snapshotId],
  );
  return rows[0];
}

/**
 * Tier A, assembled from the scanner's output — never from the model's.
 *
 * §9: the signals are "read out of stored HTML by code, not inferred by a
 * model". §23 case 13: a page claiming "we run Google Ads" must not move the
 * signal. Both hold structurally here, because the model's schema has no field
 * for any of this and these values come from the snapshot row.
 *
 * A NULL scan is `unknown`, not `absent`. Only the scanner may say absent,
 * because only the scanner has looked — and §10 pays 35 points for absence.
 */
function assembleSignals(signals: TierASignals | null): ExtractionPayload['signals'] {
  const presence = (value: boolean): 'present' | 'absent' =>
    value ? 'present' : 'absent';

  if (signals === null) {
    return {
      signals_version: 'none',
      paid_search_tag: 'unknown',
      currently_advertising: 'unknown',
      analytics_ga4: 'unknown',
      tag_manager: 'unknown',
      call_tracking: 'unknown',
      tel_link: 'unknown',
      contact_form: 'unknown',
      responsive_viewport: 'unknown',
      location_page_links: null,
      copyright_year: null,
    };
  }

  return {
    signals_version: signals.signals_version ?? SIGNALS_VERSION,
    paid_search_tag: presence(signals.paid_search_tag),
    // §9: "currently_advertising, which in Tier A is always unknown".
    currently_advertising: 'unknown',
    analytics_ga4: presence(signals.ga4),
    tag_manager: presence(signals.gtm),
    call_tracking: presence(signals.call_tracking),
    tel_link: presence(signals.tel_link),
    contact_form: presence(signals.form_present),
    responsive_viewport: presence(signals.viewport_meta),
    location_page_links: signals.location_page_links,
    copyright_year: signals.copyright_year,
  };
}

async function findExtraction(
  db: Pool | PoolClient,
  snapshotId: string,
  model: string,
): Promise<string | undefined> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM extractions
      WHERE snapshot_id = $1 AND schema_version = $2 AND extractor_model = $3`,
    [snapshotId, EXTRACTION_SCHEMA_VERSION, model],
  );
  return rows[0]?.id;
}

/** Records a refusal. Ids and a machine reason only — events carries no prose. */
async function recordSkip(
  db: Pool,
  snapshot: { id: string; company_id: string },
  reason: IneligibilityReason,
  traceId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload, trace_id)
     VALUES ('web_snapshot', $1, 'extract.skipped', 'system', $2::jsonb, $3)`,
    [snapshot.id, JSON.stringify({ reason, company_id: snapshot.company_id }), traceId],
  );
}

export async function handleWebExtract(
  job: ClaimedJob,
  deps: WebExtractDeps,
): Promise<WebExtractResult> {
  const payload = webExtractPayloadSchema.parse(job.payload);
  const log = withTrace(job.trace_id);

  const snapshot = await loadSnapshot(deps.pool, payload.snapshot_id);
  if (snapshot === undefined) {
    // Nothing to record against: the row the payload names does not exist.
    // The job completes rather than retrying — a missing snapshot does not
    // appear later.
    log.warn({ snapshot_id: payload.snapshot_id }, 'no such snapshot; nothing to extract');
    return { outcome: 'skipped', reason: 'missing_snapshot' };
  }

  const existing = await findExtraction(deps.pool, snapshot.id, deps.provider.model);

  const eligibility = assessEligibility(snapshot, {
    alreadyExtracted: existing !== undefined,
  });

  if (!eligibility.eligible) {
    if (eligibility.reason === 'already_extracted' && existing !== undefined) {
      // Not a skip: the work is done. A retry lands here and costs nothing,
      // which is the whole point of §4's unique key on
      // (snapshot_id, schema_version, extractor_model).
      log.info(
        { snapshot_id: payload.snapshot_id, extraction_id: existing },
        'extraction already exists; no model call',
      );
      return { outcome: 'already_extracted', extractionId: existing };
    }

    await recordSkip(deps.pool, snapshot, eligibility.reason, job.trace_id);
    log.info(
      {
        snapshot_id: payload.snapshot_id,
        reason: eligibility.reason,
        detail: eligibility.detail,
      },
      'snapshot is not eligible for extraction; no model call',
    );
    return { outcome: 'skipped', reason: eligibility.reason };
  }

  // Past this line a provider may be contacted, so the controls come first.
  const text = snapshot.text as string;

  if (deps.provider.billable && !deps.modelCallsEnabled) {
    throw new ExtractBlocked(
      'model_calls_disabled',
      `provider "${deps.provider.id}" is billable and MODEL_CALLS_ENABLED is ` +
        'not set, so no real call may be made',
    );
  }

  // --- the atomic reservation: check and claim in one act (§16) ---
  //
  // Committed spend plus everything in flight is compared with the ceiling
  // inside a transaction holding the month's budgets row, and the row that
  // claims this work is inserted in the same transaction. Two workers cannot
  // both pass, and nothing reaches a provider without a row that already counts
  // against the month.
  const requestHash = requestHashFor(text);
  const reservationKey = reservationKeyFor(snapshot.id, deps.provider.model, requestHash);

  const reservation = await reserveCall(deps.pool, {
    reservationKey,
    traceId: job.trace_id,
    jobId: job.id,
    purpose: 'web.extract',
    isolation: 'isolated_untrusted',
    provider: deps.provider.id,
    model: deps.provider.model,
    estimatedInputTokens: estimateTokens(text),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    requestHash,
  });

  if (reservation.kind === 'refused') {
    if (reservation.reason !== 'reservation_in_flight') {
      // The control fired before anything was claimed, so the refusal is
      // recorded at zero cost and without a key: it must not consume budget,
      // and it must not block the work once the cause is fixed.
      await recordRefusal(deps.pool, {
        traceId: job.trace_id,
        jobId: job.id,
        purpose: 'web.extract',
        isolation: 'isolated_untrusted',
        provider: deps.provider.id,
        model: deps.provider.model,
        requestHash,
        reason: reservation.reason,
      });
    }

    log.error(
      {
        snapshot_id: snapshot.id,
        reason: reservation.reason,
        month_to_date_usd: reservation.window.monthToDateUsd,
        hard_stop_usd: reservation.window.hardStopUsd,
        estimated_usd: reservation.estimatedUsd,
        existing_call_id: reservation.existingCallId,
        existing_status: reservation.existingStatus,
      },
      'ALERT: the budget gate refused a model call',
    );
    throw new ExtractBlocked(reservation.reason, reservation.detail);
  }

  // Past this line the reservation exists and the budget is already committed
  // to it. Every path from here either finalises it or deliberately leaves it
  // standing for a human — never silently releases it.
  let result: Awaited<ReturnType<typeof isolatedExtract>>;
  try {
    // The one step that sees page content.
    result = await isolatedExtract(deps.provider, {
      text,
      sourceUrl: snapshot.url,
      traceId: job.trace_id,
    });
  } catch (error) {
    // The provider may or may not have billed us: a timeout can arrive after
    // the work was done. The reservation stays `reserved`, so its pessimistic
    // cost keeps counting and this work cannot be retried against the provider
    // until a human has checked the billing (§16, review item 1).
    log.error(
      {
        snapshot_id: snapshot.id,
        call_id: reservation.callId,
        reservation_key: reservationKey,
        err: error,
      },
      'ALERT: the provider call failed after its reservation was taken; the ' +
        'reservation is left open for reconciliation and will not be replayed',
    );
    throw new ExtractBlocked(
      'reservation_in_flight',
      `the provider call failed after llm_calls ${reservation.callId} was ` +
        'reserved, so whether it was charged is unknown. Reconcile it with ' +
        'ops/day4-reservations before re-enqueueing this snapshot.',
    );
  }

  const stored = result.valid && result.extraction !== undefined
    ? extractionPayloadSchema.parse({
        schema_version: EXTRACTION_SCHEMA_VERSION,
        prompt_version: PROMPT_VERSION,
        source_snapshot_id: snapshot.id,
        source_url: snapshot.url,
        firm: result.extraction,
        signals: assembleSignals(snapshot.signals),
      })
    : undefined;

  // One transaction. A charge with no fact, or a fact with no charge, would
  // make the month-to-date figure fiction — so both rows land together or
  // neither does.
  const client = await deps.pool.connect();
  let extractionId: string;
  try {
    await client.query('BEGIN');

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO extractions
         (snapshot_id, schema_version, extractor_model, payload, valid,
          validation_errors, trace_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
       ON CONFLICT (snapshot_id, schema_version, extractor_model) DO NOTHING
       RETURNING id`,
      [
        snapshot.id,
        EXTRACTION_SCHEMA_VERSION,
        deps.provider.model,
        JSON.stringify(stored ?? {}),
        result.valid,
        result.validationErrors === undefined ? null : JSON.stringify(result.validationErrors),
        job.trace_id,
      ],
    );

    // A concurrent worker won the race. Its row is as good as ours; the call we
    // made is still recorded, because it still happened and still cost money.
    extractionId =
      inserted.rows[0]?.id ??
      ((await findExtraction(client, snapshot.id, deps.provider.model)) as string);

    // The reservation becomes the record of what actually happened, in the
    // same transaction as the fact it produced: a charge never exists without
    // its fact, and a fact never exists without its charge.
    await finalizeCall(client, {
      callId: reservation.callId,
      usage: result.usage,
      latencyMs: result.latencyMs,
      status: result.valid ? 'succeeded' : 'failed',
    });

    await client.query(
      `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload, trace_id)
       VALUES ('extraction', $1, $2, 'model', $3::jsonb, $4)`,
      [
        extractionId,
        result.valid ? 'extract.succeeded' : 'extract.invalid',
        JSON.stringify({
          snapshot_id: snapshot.id,
          company_id: snapshot.company_id,
          schema_version: EXTRACTION_SCHEMA_VERSION,
          prompt_version: PROMPT_VERSION,
          provider: deps.provider.id,
          model: deps.provider.model,
          attempts: result.attempts,
          truncated: result.truncated,
          valid: result.valid,
        }),
        job.trace_id,
      ],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  log.info(
    {
      snapshot_id: snapshot.id,
      extraction_id: extractionId,
      valid: result.valid,
      attempts: result.attempts,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
    },
    result.valid ? 'extraction stored' : 'extraction stored as invalid; the page stops here',
  );

  // Day 6 enqueues company.assess from here, "when all pages done" (§6).

  return { outcome: 'extracted', extractionId, valid: result.valid };
}

/**
 * The validated facts, for the privileged zone.
 *
 * The only place `attestValidated` is called: after a strict parse and the
 * sanitiser, on a payload that has been through the §8 boundary. A privileged
 * caller takes `Validated<ExtractionPayload>` and therefore cannot be handed
 * page content wearing the right shape.
 */
export function asValidatedFacts(payload: ExtractionPayload): Validated<ExtractionPayload> {
  return attestValidated(payload);
}
