/**
 * Enqueue (SPEC.md §7).
 *
 * Every enqueue is INSERT ... ON CONFLICT (dedupe_key) DO NOTHING. The unique
 * constraint on jobs.dedupe_key is the guarantee; this function is just the one
 * statement that leans on it.
 *
 * Deliberately no RETURNING: the scheduler connects as operator_sched, whose
 * grant is INSERT on jobs and nothing else (§17), and RETURNING would require
 * SELECT. Callers learn whether they were first from `inserted`.
 */
import type { Pool, PoolClient } from 'pg';

import { MAX_ATTEMPTS, type JobKind } from './kinds';

export type Queryable = Pool | PoolClient;

export interface EnqueueInput {
  readonly kind: JobKind;
  readonly dedupeKey: string;
  readonly traceId: string;
  readonly payload?: Record<string, unknown>;
  readonly priority?: number;
  readonly runAfter?: Date;
  readonly parentJobId?: string;
  /** Defaults to the kind's §6 budget. Overridden only by tests. */
  readonly maxAttempts?: number;
}

export interface EnqueueResult {
  /** False when the dedupe key already existed, which is a success, not an error. */
  readonly inserted: boolean;
}

export async function enqueue(db: Queryable, input: EnqueueInput): Promise<EnqueueResult> {
  const result = await db.query(
    `INSERT INTO jobs (kind, dedupe_key, payload, priority, run_after,
                       max_attempts, parent_job_id, trace_id)
     VALUES ($1, $2, $3::jsonb, $4, coalesce($5, now()), $6, $7, $8)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.kind,
      input.dedupeKey,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      input.runAfter ?? null,
      input.maxAttempts ?? MAX_ATTEMPTS[input.kind],
      input.parentJobId ?? null,
      input.traceId,
    ],
  );

  return { inserted: result.rowCount === 1 };
}
