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

import { checkBudget, recordCall } from '../../ai/budget';
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
 * Raised when a control stopped the job before any provider was contacted.
 *
 * A ControlRefusal, so the worker loop moves the job to blocked — terminal and
 * alerting (§6) — rather than retrying it. None of the three reasons improves
 * by being tried again: the ceiling is still the ceiling, the price is still
 * missing, and the switch is still off.
 */
export class ExtractBlocked extends ControlRefusal {
  override readonly name = 'ExtractBlocked';

  constructor(
    override readonly reason: 'hard_stop' | 'no_pricing' | 'model_calls_disabled',
    detail: string,
  ) {
    super(reason, detail);
  }
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
      `provider "${deps.provider.id}" is billable and MODEL_CALLS_ENABLED is not set`,
    );
  }

  const budget = await checkBudget(deps.pool, {
    provider: deps.provider.id,
    model: deps.provider.model,
    estimatedInputTokens: estimateTokens(text),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    traceId: job.trace_id,
  });

  if (!budget.allowed) {
    // §16: the job moves to blocked and raises an alert *without contacting the
    // provider*. The refusal is recorded as an llm_calls row with status
    // blocked and zero cost, so the audit trail shows the control firing rather
    // than a gap where a call would have been.
    await recordCall(deps.pool, {
      traceId: job.trace_id,
      jobId: job.id,
      purpose: 'web.extract',
      isolation: 'isolated_untrusted',
      provider: deps.provider.id,
      model: deps.provider.model,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      latencyMs: null,
      status: 'blocked',
      requestHash: requestHashFor(text),
      costUsdOverride: 0,
    });
    log.error(
      {
        snapshot_id: snapshot.id,
        reason: budget.reason,
        month_to_date_usd: budget.window.monthToDateUsd,
        hard_stop_usd: budget.window.hardStopUsd,
        estimated_usd: budget.estimatedUsd,
      },
      'ALERT: the budget gate refused a model call',
    );
    throw new ExtractBlocked(budget.reason, budget.detail);
  }

  // The one step that sees page content.
  const result = await isolatedExtract(deps.provider, {
    text,
    sourceUrl: snapshot.url,
    traceId: job.trace_id,
  });

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

    await recordCall(client, {
      traceId: job.trace_id,
      jobId: job.id,
      purpose: 'web.extract',
      isolation: 'isolated_untrusted',
      provider: deps.provider.id,
      model: deps.provider.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
      status: result.valid ? 'succeeded' : 'failed',
      requestHash: result.requestHash,
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
