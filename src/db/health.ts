/**
 * Health report (SPEC.md §20).
 *
 * "/api/health reports database connectivity, queue depth, the age of the last
 * successful job, the age of the last scheduler tick, and month-to-date spend."
 *
 * Because the dashboard is private in v1.1, this endpoint is reached over
 * Tailscale and not from the public internet; external uptime monitoring
 * watches a minimal public probe on the opt-out host instead.
 */
import type { Pool } from 'pg';

import { getConfig } from '../config';

export interface HealthReport {
  readonly status: 'ok' | 'error';
  readonly checked_at: string;
  readonly database: {
    readonly connected: boolean;
    readonly latency_ms: number | null;
    readonly error?: string;
  };
  readonly queue: {
    readonly depth: number;
    readonly running: number;
    readonly dead: number;
    readonly blocked: number;
  } | null;
  readonly last_successful_job_age_seconds: number | null;
  readonly last_scheduler_tick_age_seconds: number | null;
  readonly spend: {
    readonly month_to_date_usd: number;
    readonly limit_usd: number;
    readonly warn_usd: number;
    readonly hard_stop_usd: number;
    /** ok below the warning, warn at or above it, stopped at the hard stop. */
    readonly state: 'ok' | 'warn' | 'stopped';
  } | null;
}

interface QueueRow {
  depth: string;
  running: string;
  dead: string;
  blocked: string;
}

interface AgeRow {
  age_seconds: string | null;
}

interface SpendRow {
  month_to_date_usd: string;
  limit_usd: string | null;
  warn_usd: string | null;
  hard_stop_usd: string | null;
}

function toNumber(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function spendState(
  monthToDate: number,
  warn: number,
  hardStop: number,
): 'ok' | 'warn' | 'stopped' {
  if (monthToDate >= hardStop) {
    return 'stopped';
  }
  if (monthToDate >= warn) {
    return 'warn';
  }
  return 'ok';
}

export async function collectHealth(pool: Pool): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const started = process.hrtime.bigint();

  function failed(error: unknown): HealthReport {
    return {
      status: 'error',
      checked_at: checkedAt,
      database: {
        connected: false,
        latency_ms: null,
        error: error instanceof Error ? error.message : 'unknown error',
      },
      queue: null,
      last_successful_job_age_seconds: null,
      last_scheduler_tick_age_seconds: null,
      spend: null,
    };
  }

  // Connectivity first, on its own connection, so an unreachable database is a
  // 503 with a reason rather than a stack trace.
  let latencyMs: number;
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  } catch (error) {
    return failed(error);
  }

  try {
    const config = getConfig();

    // Each of these goes through the pool and therefore gets its own client: a
    // single pg client cannot run queries concurrently.
    const [queue, lastJob, lastTick, spend] = await Promise.all([
      pool.query<QueueRow>(`
        SELECT
          count(*) FILTER (WHERE status = 'queued')  AS depth,
          count(*) FILTER (WHERE status = 'running') AS running,
          count(*) FILTER (WHERE status = 'dead')    AS dead,
          count(*) FILTER (WHERE status = 'blocked') AS blocked
        FROM jobs
      `),
      pool.query<AgeRow>(`
        SELECT extract(epoch FROM now() - max(finished_at)) AS age_seconds
        FROM job_runs
        WHERE status = 'succeeded'
      `),
      pool.query<AgeRow>(`
        SELECT extract(epoch FROM now() - max(last_run_at)) AS age_seconds
        FROM schedules
      `),
      pool.query<SpendRow>(`
        SELECT
          coalesce((
            SELECT sum(cost_usd) FROM llm_calls
            WHERE created_at >= date_trunc('month', now())
          ), 0) AS month_to_date_usd,
          b.limit_usd,
          b.warn_usd,
          b.hard_stop_usd
        FROM (SELECT 1) AS anchor
        LEFT JOIN budgets AS b
          ON b.period_month = date_trunc('month', now())::date
      `),
    ]);

    const queueRow = queue.rows[0];
    const spendRow = spend.rows[0];

    const monthToDate = toNumber(spendRow?.month_to_date_usd, 0);
    // The budgets row is the operational source of truth; the configured
    // defaults stand in until the month's row exists (§2, §16).
    const limit = toNumber(spendRow?.limit_usd, config.AI_BUDGET_MONTHLY_USD);
    const warn = toNumber(spendRow?.warn_usd, config.AI_BUDGET_WARN_USD);
    const hardStop = toNumber(spendRow?.hard_stop_usd, config.AI_BUDGET_HARD_STOP_USD);

    return {
      status: 'ok',
      checked_at: checkedAt,
      database: {
        connected: true,
        latency_ms: Math.round(latencyMs * 100) / 100,
      },
      queue: {
        depth: toNumber(queueRow?.depth, 0),
        running: toNumber(queueRow?.running, 0),
        dead: toNumber(queueRow?.dead, 0),
        blocked: toNumber(queueRow?.blocked, 0),
      },
      last_successful_job_age_seconds: toNullableNumber(lastJob.rows[0]?.age_seconds),
      last_scheduler_tick_age_seconds: toNullableNumber(lastTick.rows[0]?.age_seconds),
      spend: {
        month_to_date_usd: monthToDate,
        limit_usd: limit,
        warn_usd: warn,
        hard_stop_usd: hardStop,
        state: spendState(monthToDate, warn, hardStop),
      },
    };
  } catch (error) {
    return failed(error);
  }
}

export { spendState };
