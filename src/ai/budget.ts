/**
 * The budget gate, as an atomic reservation (SPEC.md §16).
 *
 * §16: "The budget check runs before the call, not after it. If month-to-date
 * spend plus the estimated cost of this call exceeds budgets.hard_stop_usd, the
 * job moves to blocked and raises an alert without contacting the provider. A
 * budget that is only discovered after the money is gone is a report, not a
 * control."
 *
 * A check alone is not that control. Two workers can both read the same
 * remaining budget before either has written anything, and a provider can bill
 * us and the process can die before the row is inserted. So the call is
 * reserved first:
 *
 *   1. One transaction takes the month's `budgets` row with FOR UPDATE, which
 *      serialises every reservation for that month. No advisory lock —
 *      operator_app does not hold that namespace (migration 005 gave it to
 *      operator_sched alone), and the budgets row is the natural place to
 *      serialise a monthly ceiling.
 *   2. Inside it, month-to-date is summed and the pessimistic cost of this call
 *      is added. Over the hard stop, nothing is inserted and nothing is called.
 *   3. Under it, an `llm_calls` row is inserted with status `reserved`,
 *      `cost_usd` holding the pessimistic estimate, and a unique
 *      `reservation_key` identifying the work. The transaction commits and the
 *      lock is released — before the provider is contacted.
 *   4. The provider is called outside any transaction.
 *   5. Finalisation replaces the estimate with the real usage, in the same
 *      transaction as the fact the call produced.
 *
 * Reserved cost counts against the ceiling exactly like spent cost, so a crash
 * between 3 and 5 leaves the budget consumed and the identity taken. That is
 * the point: the system fails closed, and the ambiguous call is resolved by a
 * human who can see the provider's own billing, not replayed automatically.
 */
import type { Pool, PoolClient } from 'pg';

import { getConfig } from '../config';
import { getLogger } from '../obs/log';

import { costUsd, priceFor } from './pricing';

type Queryable = Pool | PoolClient;

export interface BudgetWindow {
  readonly periodMonth: string;
  /** Committed spend plus everything currently reserved. */
  readonly monthToDateUsd: number;
  readonly limitUsd: number;
  readonly warnUsd: number;
  readonly hardStopUsd: number;
}

/**
 * Every reason a reservation can be refused, as a machine token.
 *
 * These are the codes that reach `jobs.last_error`, the `job.blocked` event and
 * the operator's screen, so they have to distinguish the cases that need
 * different human responses: raise the ceiling, add a price, set the switch,
 * reconcile a stuck call.
 */
export type RefusalReason =
  | 'budget_hard_stop'
  | 'missing_pricing'
  | 'reservation_in_flight';

export type Reservation =
  | {
      readonly kind: 'reserved';
      readonly callId: string;
      readonly reservationKey: string;
      readonly estimatedUsd: number;
      readonly window: BudgetWindow;
    }
  | {
      readonly kind: 'refused';
      readonly reason: RefusalReason;
      readonly detail: string;
      readonly estimatedUsd: number | null;
      readonly window: BudgetWindow;
      /** Set when the refusal is an existing reservation. */
      readonly existingCallId?: string;
      readonly existingStatus?: string;
    };

/**
 * Makes sure this month has a budgets row.
 *
 * Created from the configured defaults when missing, and authoritative
 * thereafter: §16 wants the ceiling to be a row so that raising it is an UPDATE
 * rather than a deploy. Idempotent, so two workers racing on the first call of
 * the month produce one row.
 */
async function ensureBudgetRow(db: Queryable): Promise<void> {
  const config = getConfig();
  await db.query(
    `INSERT INTO budgets (period_month, limit_usd, warn_usd, hard_stop_usd)
     VALUES (date_trunc('month', now())::date, $1, $2, $3)
     ON CONFLICT (period_month) DO NOTHING`,
    [config.AI_BUDGET_MONTHLY_USD, config.AI_BUDGET_WARN_USD, config.AI_BUDGET_HARD_STOP_USD],
  );
}

interface WindowRow {
  period_month: string;
  month_to_date_usd: string;
  limit_usd: string;
  warn_usd: string;
  hard_stop_usd: string;
}

const WINDOW_SQL = `
  SELECT b.period_month::text AS period_month,
         coalesce((
           SELECT sum(cost_usd) FROM llm_calls
            WHERE created_at >= date_trunc('month', now())
         ), 0)::text          AS month_to_date_usd,
         b.limit_usd::text    AS limit_usd,
         b.warn_usd::text     AS warn_usd,
         b.hard_stop_usd::text AS hard_stop_usd
    FROM budgets b
   WHERE b.period_month = date_trunc('month', now())::date`;

function toWindow(row: WindowRow): BudgetWindow {
  return {
    periodMonth: row.period_month,
    monthToDateUsd: Number(row.month_to_date_usd),
    limitUsd: Number(row.limit_usd),
    warnUsd: Number(row.warn_usd),
    hardStopUsd: Number(row.hard_stop_usd),
  };
}

/** Read-only view of the month, for the dashboard and for tests. */
export async function budgetWindow(db: Queryable): Promise<BudgetWindow> {
  await ensureBudgetRow(db);
  const { rows } = await db.query<WindowRow>(WINDOW_SQL);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('the budgets row for this month is missing after an upsert');
  }
  return toWindow(row);
}

/**
 * Raises the §16 warning once per month, and only once.
 *
 * "When month-to-date spend first crosses budgets.warn_usd, a warning alert is
 * raised once for that month and calls continue." Once is enforced by looking
 * for the event rather than by a flag in memory: the worker restarts, and a
 * warning that repeats every tick is a warning nobody reads.
 */
async function raiseWarningOnce(
  db: Queryable,
  window: BudgetWindow,
  traceId: string,
): Promise<void> {
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

export interface ReservationRequest {
  /**
   * The work, as one string. Two workers that compute the same key cannot both
   * reach the provider, because the key is unique while it is set.
   */
  readonly reservationKey: string;
  readonly traceId: string;
  readonly jobId: string | null;
  readonly purpose: string;
  readonly isolation: 'isolated_untrusted' | 'privileged';
  readonly provider: string;
  readonly model: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  /** Identifies the input without storing it (§16). */
  readonly requestHash: string;
}

/**
 * Reserves one call, or refuses it. Nothing contacts a provider here.
 *
 * Needs a Pool rather than a client: it runs its own transaction, because the
 * whole point is that the check and the reservation are one atomic act. Callers
 * must not already be in a transaction — holding the budgets lock across a
 * provider call would serialise the entire worker on one row.
 */
export async function reserveCall(
  pool: Pool,
  request: ReservationRequest,
): Promise<Reservation> {
  await ensureBudgetRow(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The serialisation point. Every reservation for this month queues here,
    // so no two can read the same remaining budget and both pass.
    await client.query(
      `SELECT id FROM budgets
        WHERE period_month = date_trunc('month', now())::date
        FOR UPDATE`,
    );

    const windowRows = await client.query<WindowRow>(WINDOW_SQL);
    const windowRow = windowRows.rows[0];
    if (windowRow === undefined) {
      throw new Error('the budgets row for this month vanished inside the reservation');
    }
    const window = toWindow(windowRow);

    // An existing reservation for this work ends it here, whatever its state:
    // another worker is calling, or a call was made and its outcome is unknown.
    // Either way this worker must not invoke the provider.
    const existing = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM llm_calls WHERE reservation_key = $1`,
      [request.reservationKey],
    );
    const held = existing.rows[0];
    if (held !== undefined) {
      await client.query('COMMIT');
      return {
        kind: 'refused',
        reason: 'reservation_in_flight',
        detail:
          `a ${held.status} reservation already exists for this work ` +
          `(llm_calls.id ${held.id}); the provider must not be invoked again`,
        estimatedUsd: null,
        window,
        existingCallId: held.id,
        existingStatus: held.status,
      };
    }

    const price = await priceFor(client, request.provider, request.model);
    if (price === undefined) {
      await client.query('COMMIT');
      return {
        kind: 'refused',
        reason: 'missing_pricing',
        detail:
          `no model_pricing row in force for ${request.provider}/${request.model}; ` +
          'a call that cannot be priced cannot be budgeted, so it cannot be ' +
          'authorised (§16)',
        estimatedUsd: null,
        window,
      };
    }

    // Pessimistic on purpose: input estimated from the prompt, output assumed
    // to hit the cap. An estimate that reads low lets the ceiling be crossed
    // once, and once at the hard stop is the whole thing it exists to prevent.
    const estimatedUsd = costUsd(
      { inputTokens: request.estimatedInputTokens, outputTokens: request.maxOutputTokens },
      price,
    );

    if (window.monthToDateUsd + estimatedUsd > window.hardStopUsd) {
      await client.query('COMMIT');
      return {
        kind: 'refused',
        reason: 'budget_hard_stop',
        detail:
          `month-to-date $${window.monthToDateUsd.toFixed(6)} (committed plus ` +
          `reserved) plus an estimated $${estimatedUsd.toFixed(6)} would exceed ` +
          `the hard stop of $${window.hardStopUsd.toFixed(2)} (§16)`,
        estimatedUsd,
        window,
      };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO llm_calls
         (trace_id, job_id, purpose, isolation, provider, model,
          cost_usd, estimated_cost_usd, status, request_hash,
          reservation_key, reserved_at)
       VALUES ($1, $2, $3, $4::llm_isolation, $5, $6, $7, $7, 'reserved', $8, $9, now())
       ON CONFLICT (reservation_key) WHERE reservation_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        request.traceId,
        request.jobId,
        request.purpose,
        request.isolation,
        request.provider,
        request.model,
        estimatedUsd,
        request.requestHash,
        request.reservationKey,
      ],
    );

    const callId = inserted.rows[0]?.id;
    if (callId === undefined) {
      // Lost the race on the unique index inside the lock. Belt and braces:
      // the SELECT above should already have found it.
      const raced = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM llm_calls WHERE reservation_key = $1`,
        [request.reservationKey],
      );
      await client.query('COMMIT');
      return {
        kind: 'refused',
        reason: 'reservation_in_flight',
        detail: 'another worker reserved this work first',
        estimatedUsd,
        window,
        ...(raced.rows[0] === undefined
          ? {}
          : { existingCallId: raced.rows[0].id, existingStatus: raced.rows[0].status }),
      };
    }

    await client.query('COMMIT');

    // After the lock is released: the warning is an alert, not part of the
    // control, and it must not widen the window the lock is held for.
    const after: BudgetWindow = {
      ...window,
      monthToDateUsd: window.monthToDateUsd + estimatedUsd,
    };
    if (after.monthToDateUsd >= window.warnUsd) {
      await raiseWarningOnce(pool, after, request.traceId);
    }

    return {
      kind: 'reserved',
      callId,
      reservationKey: request.reservationKey,
      estimatedUsd,
      window: after,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface Finalisation {
  readonly callId: string;
  readonly usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  readonly latencyMs: number | null;
  readonly status: 'succeeded' | 'failed';
}

/**
 * Replaces the reservation's estimate with what actually happened.
 *
 * Takes a client, not a pool: the caller runs this in the same transaction as
 * the fact the call produced, so a charge never exists without its fact and a
 * fact never exists without its charge.
 *
 * Guarded on `status = 'reserved'`, so a second finalisation cannot overwrite a
 * recorded outcome — and the caller is told, because a reservation that was
 * already finalised means two code paths believe they own the same call.
 */
export async function finalizeCall(
  client: PoolClient,
  final: Finalisation,
): Promise<void> {
  const price = await priceFor(client, ...(await providerAndModel(client, final.callId)));
  const actual = price === undefined ? 0 : costUsd(final.usage, price);

  const { rowCount } = await client.query(
    `UPDATE llm_calls
        SET input_tokens  = $2,
            output_tokens = $3,
            cached_tokens = $4,
            cost_usd      = $5,
            latency_ms    = $6,
            status        = $7::llm_call_status,
            finalized_at  = now()
      WHERE id = $1 AND status = 'reserved'`,
    [
      final.callId,
      final.usage.inputTokens,
      final.usage.outputTokens,
      final.usage.cachedTokens,
      actual,
      final.latencyMs,
      final.status,
    ],
  );

  if (rowCount !== 1) {
    throw new Error(
      `llm_calls ${final.callId} was not in the reserved state at finalisation; ` +
        'refusing to overwrite a recorded outcome',
    );
  }
}

async function providerAndModel(
  client: PoolClient,
  callId: string,
): Promise<[string, string]> {
  const { rows } = await client.query<{ provider: string; model: string }>(
    'SELECT provider, model FROM llm_calls WHERE id = $1',
    [callId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`llm_calls ${callId} does not exist`);
  }
  return [row.provider, row.model];
}

/**
 * Records a refusal that never reached a reservation.
 *
 * Zero cost, no reservation key: the control fired before any provider was
 * contacted, so the row exists to make the refusal visible in the ledger rather
 * than leaving a gap where a call would have been — and it must not consume
 * budget or block the work from being retried once the cause is fixed.
 */
export async function recordRefusal(
  db: Queryable,
  refusal: {
    readonly traceId: string;
    readonly jobId: string | null;
    readonly purpose: string;
    readonly isolation: 'isolated_untrusted' | 'privileged';
    readonly provider: string;
    readonly model: string;
    readonly requestHash: string;
    readonly reason: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO llm_calls
       (trace_id, job_id, purpose, isolation, provider, model, cost_usd,
        estimated_cost_usd, status, request_hash, reconciliation_note)
     VALUES ($1, $2, $3, $4::llm_isolation, $5, $6, 0, 0, 'blocked', $7, $8)`,
    [
      refusal.traceId,
      refusal.jobId,
      refusal.purpose,
      refusal.isolation,
      refusal.provider,
      refusal.model,
      refusal.requestHash,
      refusal.reason,
    ],
  );
}

export interface StaleReservation {
  readonly id: string;
  readonly reservationKey: string | null;
  readonly provider: string;
  readonly model: string;
  readonly purpose: string;
  readonly traceId: string;
  readonly jobId: string | null;
  readonly estimatedUsd: number;
  readonly reservedAt: Date;
  readonly ageMinutes: number;
}

/**
 * Reservations that are still open.
 *
 * Read-only. What a human needs in order to go and look at the provider's own
 * billing for this request and decide, which is the only place the answer
 * exists: the request hash identifies the input, the trace id threads the whole
 * pipeline run, and the timestamp bounds the window to search.
 */
export async function openReservations(
  db: Queryable,
  olderThanMinutes = 0,
): Promise<StaleReservation[]> {
  const { rows } = await db.query<{
    id: string;
    reservation_key: string | null;
    provider: string;
    model: string;
    purpose: string;
    trace_id: string;
    job_id: string | null;
    estimated_cost_usd: string | null;
    reserved_at: Date;
    age_minutes: string;
  }>(
    `SELECT id, reservation_key, provider, model, purpose, trace_id, job_id,
            estimated_cost_usd, reserved_at,
            (extract(epoch FROM now() - reserved_at) / 60)::numeric(12, 2) AS age_minutes
       FROM llm_calls
      WHERE status = 'reserved'
        AND reserved_at <= now() - make_interval(mins => $1::int)
      ORDER BY reserved_at`,
    [olderThanMinutes],
  );

  return rows.map((row) => ({
    id: row.id,
    reservationKey: row.reservation_key,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    traceId: row.trace_id,
    jobId: row.job_id,
    estimatedUsd: Number(row.estimated_cost_usd ?? 0),
    reservedAt: row.reserved_at,
    ageMinutes: Number(row.age_minutes),
  }));
}

/**
 * Releases a reservation that a human has verified was never charged.
 *
 * Sets the cost to zero so the budget is given back, and clears the
 * reservation key so the work can be enqueued again. The row stays, with who
 * decided and why, because the reservation happening at all is a fact about the
 * month.
 *
 * Deliberately not automatic. Only the provider's billing can say whether an
 * ambiguous call was charged, and nothing in this process can see it.
 */
export async function abandonReservation(
  db: Queryable,
  callId: string,
  by: string,
  note: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE llm_calls
        SET status              = 'abandoned',
            cost_usd            = 0,
            reservation_key     = NULL,
            finalized_at        = now(),
            reconciled_by       = $2,
            reconciliation_note = $3
      WHERE id = $1 AND status = 'reserved'`,
    [callId, by, note],
  );
  return rowCount === 1;
}

/**
 * Records that an ambiguous reservation *was* charged, at the stated cost.
 *
 * The other half of reconciliation, and the one that keeps the month honest:
 * the budget keeps the money. The reservation key is kept, so the work is not
 * silently retried against a provider that already answered.
 */
export async function confirmReservation(
  db: Queryable,
  callId: string,
  actualCostUsd: number,
  by: string,
  note: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE llm_calls
        SET status              = 'failed',
            cost_usd            = $2,
            finalized_at        = now(),
            reconciled_by       = $3,
            reconciliation_note = $4
      WHERE id = $1 AND status = 'reserved'`,
    [callId, actualCostUsd, by, note],
  );
  return rowCount === 1;
}
