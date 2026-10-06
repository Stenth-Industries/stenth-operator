/**
 * The reaper (SPEC.md §6).
 *
 * "A job running with locked_at < now() - interval '15 minutes' returns to
 * queued. Its attempt was already counted at claim time, so a handler that
 * reliably kills its worker still exhausts attempts and goes dead rather than
 * looping forever."
 *
 * That second sentence is the reason this decides dead and the claim query does
 * not: §6's claim statement has no attempts < max_attempts filter, so if the
 * reaper always requeued, a job whose handler kills the worker every time would
 * be claimed for ever. Attempts remaining means requeue; exhausted means dead.
 *
 * Runs on the worker's in-process timer alongside the scheduler, not as a
 * queued job.
 */
import type { Pool } from 'pg';

import { getLogger } from '../obs/log';
import type { JobKind } from '../jobs/kinds';

/** §6: fifteen minutes. A parameter so the suite does not have to wait. */
export const DEFAULT_STALE_AFTER_SECONDS = 15 * 60;

interface ReapedRow {
  id: string;
  kind: JobKind;
  attempts: number;
  max_attempts: number;
  status: 'queued' | 'dead';
  trace_id: string;
}

export interface ReapResult {
  readonly requeued: number;
  readonly dead: number;
}

export async function reap(
  pool: Pool,
  staleAfterSeconds: number = DEFAULT_STALE_AFTER_SECONDS,
): Promise<ReapResult> {
  const log = getLogger();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const reaped = await client.query<ReapedRow>(
      `UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status
                         ELSE 'queued'::job_status END,
           -- A crashed worker is not a reason to wait: the attempt is already
           -- spent, so the retry is claimable at once.
           run_after = CASE WHEN attempts >= max_attempts THEN run_after
                            ELSE now() END,
           locked_at = NULL,
           locked_by = NULL,
           last_error = 'reaped: the worker holding this job stopped without finishing it',
           updated_at = now()
       WHERE status = 'running'
         AND locked_at < now() - make_interval(secs => $1::double precision)
       RETURNING id, kind, attempts, max_attempts, status, trace_id`,
      [staleAfterSeconds],
    );

    for (const job of reaped.rows) {
      // Close the attempt that died with its worker. The job_runs trigger
      // permits exactly this: a row still 'running' may be completed once.
      await client.query(
        `UPDATE job_runs SET finished_at = now(), status = 'failed',
                             error = 'reaped: worker stopped without finishing this attempt'
         WHERE job_id = $1 AND attempt = $2 AND finished_at IS NULL`,
        [job.id, job.attempts],
      );

      await client.query(
        `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload, trace_id)
         VALUES ('job', $1, 'job.reaped', 'system', $2::jsonb, $3)`,
        [
          job.id,
          JSON.stringify({
            job_kind: job.kind,
            attempt: job.attempts,
            max_attempts: job.max_attempts,
            outcome: job.status,
            stale_after_seconds: staleAfterSeconds,
          }),
          job.trace_id,
        ],
      );

      if (job.status === 'dead') {
        await client.query(
          `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload, trace_id)
           VALUES ('job', $1, 'job.dead', 'system', $2::jsonb, $3)`,
          [
            job.id,
            JSON.stringify({
              job_kind: job.kind,
              attempt: job.attempts,
              max_attempts: job.max_attempts,
              error_class: 'ReapedWithAttemptsExhausted',
            }),
            job.trace_id,
          ],
        );
      }
    }

    await client.query('COMMIT');

    const requeued = reaped.rows.filter((row) => row.status === 'queued').length;
    const dead = reaped.rows.length - requeued;

    if (requeued > 0) {
      log.warn({ requeued }, 'reaper returned stale jobs to the queue');
    }
    // dead is terminal and raises an alert; nothing retries it silently (§6).
    // With no alerting transport in V1 — and no mail credential, ever — the
    // alert is an error-level line and the dead count on /api/health.
    if (dead > 0) {
      log.error({ dead }, 'ALERT: jobs reaped with attempts exhausted are dead');
    }

    return { requeued, dead };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
