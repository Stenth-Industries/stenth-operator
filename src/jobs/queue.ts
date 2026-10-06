/**
 * The queue's lifecycle transitions (SPEC.md §6).
 *
 *   queued -> running -> succeeded
 *   queued -> running -> failed -> queued with a later run_after
 *                              -> dead once attempts are exhausted
 *
 * dead is terminal and raises an alert; nothing retries it silently. blocked is
 * the budget ceiling of §16 and belongs to Day 4 — the state exists in the
 * schema and /api/health counts it, but nothing here sets it.
 *
 * Each transition is one transaction, so the jobs row, its job_runs row and its
 * event either all move or none do.
 */
import type { Pool, PoolClient } from 'pg';

import { scrubString } from '../obs/log';
import { backoffSeconds } from './backoff';
import type { JobKind } from './kinds';

/** A row of jobs, as the claim returns it. */
export interface ClaimedJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly dedupe_key: string;
  readonly payload: Record<string, unknown>;
  readonly status: string;
  readonly priority: number;
  readonly run_after: Date;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly locked_at: Date | null;
  readonly locked_by: string | null;
  readonly last_error: string | null;
  readonly parent_job_id: string | null;
  readonly trace_id: string;
}

/**
 * An error message is bounded and scrubbed before it reaches the database.
 *
 * A driver error can carry a connection string, and a connection string carries
 * a password (§17). last_error is not an audit record, so truncating it costs
 * nothing and storing a secret costs a great deal.
 */
export const MAX_ERROR_LENGTH = 4000;

export function describeError(error: unknown): { message: string; className: string } {
  const className = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const scrubbed = scrubString(raw);
  const message =
    scrubbed.length > MAX_ERROR_LENGTH
      ? `${scrubbed.slice(0, MAX_ERROR_LENGTH)}… [truncated]`
      : scrubbed;
  return { message, className };
}

/**
 * Claims one job, atomically, safe across any number of workers.
 *
 * The UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) is the
 * statement §6 specifies, verbatim apart from maintaining updated_at. Two
 * workers racing cannot claim the same row: the inner SELECT locks it and the
 * loser skips it rather than blocking.
 *
 * The job_runs row for this attempt is inserted in the same transaction, so an
 * attempt can never run without a record of it.
 */
export async function claimJob(
  pool: Pool,
  lockedBy: string,
): Promise<ClaimedJob | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claimed = await client.query<ClaimedJob>(
      `UPDATE jobs SET status = 'running', locked_at = now(),
                       locked_by = $1, attempts = attempts + 1,
                       updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY priority DESC, run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [lockedBy],
    );

    const job = claimed.rows[0];
    if (job === undefined) {
      await client.query('COMMIT');
      return undefined;
    }

    // No ON CONFLICT: attempts increments on every claim, so a collision here
    // would mean the attempt counter is wrong, and that must fail loudly.
    await client.query(
      `INSERT INTO job_runs (job_id, attempt, started_at, status)
       VALUES ($1, $2, now(), 'running')`,
      [job.id, job.attempts],
    );

    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Marks a claimed job succeeded and closes its attempt. */
export async function completeJob(pool: Pool, job: ClaimedJob): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE job_runs SET finished_at = now(), status = 'succeeded'
       WHERE job_id = $1 AND attempt = $2`,
      [job.id, job.attempts],
    );

    await client.query(
      `UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL,
                       last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [job.id],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface FailureOutcome {
  readonly status: 'queued' | 'dead';
  readonly attempt: number;
  readonly nextRunAfter: Date | null;
}

/**
 * Records a failed attempt and decides what happens next.
 *
 * Attempts remain, so the job returns to queued with a later run_after and does
 * not become claimable until then — that, not a sleep in the worker, is what
 * stops a failing job from busy-looping. Attempts exhausted, so the job is dead
 * and terminal.
 */
export async function failJob(
  pool: Pool,
  job: ClaimedJob,
  error: unknown,
  random: () => number = Math.random,
): Promise<FailureOutcome> {
  const { message, className } = describeError(error);
  const exhausted = job.attempts >= job.max_attempts;
  const delaySeconds = exhausted ? null : backoffSeconds(job.attempts, random);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE job_runs SET finished_at = now(), status = 'failed', error = $3
       WHERE job_id = $1 AND attempt = $2`,
      [job.id, job.attempts, message],
    );

    const updated = await client.query<{ run_after: Date }>(
      `UPDATE jobs
       SET status = $2,
           run_after = CASE WHEN $3::double precision IS NULL
                            THEN run_after
                            ELSE now() + make_interval(secs => $3::double precision)
                       END,
           last_error = $4,
           locked_at = NULL,
           locked_by = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING run_after`,
      [job.id, exhausted ? 'dead' : 'queued', delaySeconds, message],
    );

    // The event payload carries ids, counts and states — never the error text.
    // events is the audit spine and records no personal data (§16); the message
    // lives in jobs.last_error and job_runs.error, which redaction can reach.
    await client.query(
      `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload, trace_id)
       VALUES ('job', $1, $2, 'system', $3::jsonb, $4)`,
      [
        job.id,
        exhausted ? 'job.dead' : 'job.failed',
        JSON.stringify({
          job_kind: job.kind,
          attempt: job.attempts,
          max_attempts: job.max_attempts,
          error_class: className,
          retry_in_seconds: delaySeconds === null ? null : Math.round(delaySeconds),
        }),
        job.trace_id,
      ],
    );

    await client.query('COMMIT');

    return {
      status: exhausted ? 'dead' : 'queued',
      attempt: job.attempts,
      nextRunAfter: updated.rows[0]?.run_after ?? null,
    };
  } catch (failure) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw failure;
  } finally {
    client.release();
  }
}

/** Thrown when a claimed job has no registered handler. */
export class UnregisteredKindError extends Error {
  override readonly name = 'UnregisteredKindError';

  constructor(kind: string) {
    super(`No handler is registered for job kind "${kind}"`);
  }
}

export type { Pool, PoolClient };
