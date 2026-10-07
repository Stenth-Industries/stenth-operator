/**
 * The budget gate (SPEC.md §16).
 *
 * §16, and the sentence the whole file exists for: "The budget check runs
 * before the call, not after it. If month-to-date spend plus the estimated cost
 * of this call exceeds budgets.hard_stop_usd, the job moves to blocked and
 * raises an alert without contacting the provider. A budget that is only
 * discovered after the money is gone is a report, not a control."
 *
 * V1: $50 a month, warning at $35, hard stop at $50 — rows in budgets, not
 * constants, so raising the ceiling is a data change rather than a deploy.
 */
import type { Pool, PoolClient } from 'pg';

import { getConfig } from '../config';
import { getLogger } from '../obs/log';

import { costUsd, priceFor } from './pricing';

type Queryable = Pool | PoolClient;

export interface BudgetWindow {
  readonly periodMonth: string;
  readonly monthToDateUsd: number;
  readonly limitUsd: number;
  readonly warnUsd: number;
  readonly hardStopUsd: number;
}

export type BudgetDecision =
  | { readonly allowed: true; readonly estimatedUsd: number; readonly window: BudgetWindow }
  | {
      readonly allowed: false;
      /** Machine token, safe to log and to store in a job's last_error. */
      readonly reason: 'hard_stop' | 'no_pricing';
      readonly estimatedUsd: number | null;
      readonly window: BudgetWindow;
      readonly detail: string;
    };

/**
 * Makes sure this month has a budgets row, then returns the window.
 *
 * The row is created from the configured defaults when it is missing, rather
 * than the gate falling back to config every month: once the row exists the
 * ceiling can be changed with an UPDATE, which is what §16 asks for. Idempotent,
 * so two workers racing on the first call of the month produce one row.
 */
export async function budgetWindow(db: Queryable): Promise<BudgetWindow> {
  const config = getConfig();

  await db.query(
    `INSERT INTO budgets (period_month, limit_usd, warn_usd, hard_stop_usd)
     VALUES (date_trunc('month', now())::date, $1, $2, $3)
     ON CONFLICT (period_month) DO NOTHING`,
    [config.AI_BUDGET_MONTHLY_USD, config.AI_BUDGET_WARN_USD, config.AI_BUDGET_HARD_STOP_USD],
  );

  const { rows } = await db.query<{
    period_month: string;
    month_to_date_usd: string;
    limit_usd: string;
    warn_usd: string;
    hard_stop_usd: string;
  }>(
    `SELECT b.period_month::text AS period_month,
            coalesce((
              SELECT sum(cost_usd) FROM llm_calls
               WHERE created_at >= date_trunc('month', now())
            ), 0)::text        AS month_to_date_usd,
            b.limit_usd::text     AS limit_usd,
            b.warn_usd::text      AS warn_usd,
            b.hard_stop_usd::text AS hard_stop_usd
       FROM budgets b
      WHERE b.period_month = date_trunc('month', now())::date`,
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error('the budgets row for this month is missing after an upsert');
  }
  return {
    periodMonth: row.period_month,
    monthToDateUsd: Number(row.month_to_date_usd),
    limitUsd: Number(row.limit_usd),
    warnUsd: Number(row.warn_usd),
    hardStopUsd: Number(row.hard_stop_usd),
  };
}

/**
 * Raises the §16 warning once per month, and only once.
 *
 * "When month-to-date spend first crosses budgets.warn_usd, a warning alert is
 * raised once for that month and calls continue." Once is enforced by looking
 * for the event, not by a flag in memory: the worker restarts, and a warning
 * that repeats every tick is a warning nobody reads.
 */
async function raiseWarningOnce(db: Queryable, window: BudgetWindow, traceId: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload, trace_id)
     SELECT 'budget', b.id, 'budget.warning', 'system',
            jsonb_build_object(
              'period_month', b.period_month::text,
              'warn_usd', b.warn_usd,
              'month_to_date_usd', $1::numeric
            ),
            $2
       FROM budgets b
      WHERE b.period_month = date_trunc('month', now())::date
        AND NOT EXISTS (
          SELECT 1 FROM events e
           WHERE e.entity_type = 'budget'
             AND e.entity_id = b.id
             AND e.kind = 'budget.warning'
        )
     RETURNING id`,
    [window.monthToDateUsd, traceId],
  );

  if (rows.length > 0) {
    getLogger().warn(
      {
        trace_id: traceId,
        period_month: window.periodMonth,
        month_to_date_usd: window.monthToDateUsd,
        warn_usd: window.warnUsd,
      },
      'ALERT: month-to-date model spend has crossed the warning threshold',
    );
  }
}

export interface BudgetRequest {
  readonly provider: string;
  readonly model: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly traceId: string;
}

/**
 * Decides whether one call may happen. Nothing contacts a provider here.
 *
 * The estimate is deliberately pessimistic: input tokens estimated from the
 * prompt, output tokens assumed to hit the cap. A gate that estimates
 * optimistically is a gate that lets the ceiling be crossed once, and "once" at
 * the hard stop is the whole thing it exists to prevent.
 */
export async function checkBudget(
  db: Queryable,
  request: BudgetRequest,
): Promise<BudgetDecision> {
  const window = await budgetWindow(db);

  const price = await priceFor(db, request.provider, request.model);
  if (price === undefined) {
    // Fail closed. A call that cannot be priced cannot be budgeted, and §16's
    // control is arithmetic — without a price there is no arithmetic to do.
    return {
      allowed: false,
      reason: 'no_pricing',
      estimatedUsd: null,
      window,
      detail:
        `no model_pricing row in force for ${request.provider}/${request.model}; ` +
        'a call that cannot be priced cannot be authorised (§16)',
    };
  }

  const estimatedUsd = costUsd(
    {
      inputTokens: request.estimatedInputTokens,
      outputTokens: request.maxOutputTokens,
    },
    price,
  );

  if (window.monthToDateUsd + estimatedUsd > window.hardStopUsd) {
    return {
      allowed: false,
      reason: 'hard_stop',
      estimatedUsd,
      window,
      detail:
        `month-to-date $${window.monthToDateUsd.toFixed(6)} plus an estimated ` +
        `$${estimatedUsd.toFixed(6)} would exceed the hard stop of ` +
        `$${window.hardStopUsd.toFixed(2)} (§16)`,
    };
  }

  if (window.monthToDateUsd + estimatedUsd >= window.warnUsd) {
    await raiseWarningOnce(db, window, request.traceId);
  }

  return { allowed: true, estimatedUsd, window };
}

export interface RecordedCall {
  readonly traceId: string;
  readonly jobId: string | null;
  readonly purpose: string;
  readonly isolation: 'isolated_untrusted' | 'privileged';
  readonly provider: string;
  readonly model: string;
  readonly usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  readonly latencyMs: number | null;
  readonly status: 'succeeded' | 'failed' | 'blocked';
  /** Identifies the input without storing it (§16). */
  readonly requestHash: string;
  readonly costUsdOverride?: number;
}

/**
 * Writes the llm_calls row.
 *
 * Takes a client rather than a pool on purpose: the caller runs this inside the
 * same transaction as the extraction insert, so a call is either recorded with
 * its result or not recorded at all. A charge with no fact, or a fact with no
 * charge, would make the month-to-date figure fiction.
 */
export async function recordCall(db: Queryable, call: RecordedCall): Promise<void> {
  const price =
    call.costUsdOverride === undefined
      ? await priceFor(db, call.provider, call.model)
      : undefined;
  const cost =
    call.costUsdOverride ??
    (price === undefined ? 0 : costUsd(call.usage, price));

  await db.query(
    `INSERT INTO llm_calls
       (trace_id, job_id, purpose, isolation, provider, model,
        input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms,
        status, request_hash)
     VALUES ($1, $2, $3, $4::llm_isolation, $5, $6, $7, $8, $9, $10, $11,
             $12::llm_call_status, $13)`,
    [
      call.traceId,
      call.jobId,
      call.purpose,
      call.isolation,
      call.provider,
      call.model,
      call.usage.inputTokens,
      call.usage.outputTokens,
      call.usage.cachedTokens,
      cost,
      call.latencyMs,
      call.status,
      call.requestHash,
    ],
  );
}
