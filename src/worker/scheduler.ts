/**
 * The in-process scheduler (SPEC.md §6).
 *
 * v1.0 made this a self-enqueueing job with a permanent dedupe key, which would
 * have run exactly once and then stopped for ever. v1.1 replaces it with a loop
 * in the worker, under a Postgres advisory lock:
 *
 *   1. Every ~60 seconds, try pg_try_advisory_lock(<scheduler key>). If another
 *      worker holds it, do nothing this tick.
 *   2. Select schedules where enabled and next_run_at <= now().
 *   3. Enqueue each with an occurrence-specific dedupe key.
 *   4. Compute and store next_run_at from the cron expression, and last_run_at.
 *   5. Release the lock.
 *
 * A tick missed because the worker was down is late, not lost: next_run_at is
 * still in the past at the next tick, so the occurrence still fires.
 *
 * Connects as operator_sched (§17): read and update schedules, insert into
 * jobs, and the heartbeat of migration 003. It cannot read a contact or a
 * draft, and the tests assert that.
 */
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { enqueue } from '../jobs/enqueue';
import { dedupeKey, isJobKind, type JobKind } from '../jobs/kinds';
import { getLogger } from '../obs/log';
import { newTraceId } from '../obs/trace';
import { nextCronOccurrence, occurrenceToken, parseCron } from './cron';

/**
 * The advisory lock key. Arbitrary but fixed: any constant works so long as
 * every worker uses the same one and nothing else in the database picks it.
 * Changing it would let two schedulers run at once, so it is a constant here
 * and not configuration.
 */
export const SCHEDULER_LOCK_KEY = 7_315_204_118_664_001n;

/**
 * Payload schemas per schedulable kind.
 *
 * §7 gives each kind's dedupe key, and two of them need fields from the
 * payload. Parsing with Zod means a malformed schedule row fails loudly instead
 * of enqueueing `discover:undefined:undefined:2026-10-07` — a key that would
 * look fine and dedupe against nothing.
 *
 * A kind absent from this table cannot be scheduled. That is deliberate: §7's
 * permanent keys belong to handler-enqueued work, and giving one an occurrence
 * token here would silently change its identity.
 */
const SCHEDULABLE = {
  'maintenance.prune': {
    payload: z.object({}).passthrough(),
    key: (_payload: Record<string, unknown>, occurrence: string) =>
      dedupeKey.maintenancePrune(occurrence),
  },
  'discover.search': {
    payload: z.object({ campaign: z.string().min(1), query_hash: z.string().min(1) }).passthrough(),
    key: (payload: Record<string, unknown>, occurrence: string) =>
      dedupeKey.discoverSearch(
        payload.campaign as string,
        payload.query_hash as string,
        occurrence,
      ),
  },
} as const;

export function isSchedulableKind(kind: string): kind is keyof typeof SCHEDULABLE {
  return Object.prototype.hasOwnProperty.call(SCHEDULABLE, kind);
}

interface ScheduleRow {
  id: string;
  kind: JobKind;
  cron: string;
  payload: Record<string, unknown>;
  next_run_at: Date;
}

export interface TickResult {
  /** False when another worker held the lock, which is a normal outcome. */
  readonly acquiredLock: boolean;
  readonly due: number;
  readonly enqueued: number;
  /** Due schedules whose job already existed for this occurrence. */
  readonly duplicates: number;
  readonly failed: number;
}

const SKIPPED: TickResult = {
  acquiredLock: false,
  due: 0,
  enqueued: 0,
  duplicates: 0,
  failed: 0,
};

/**
 * One scheduler tick.
 *
 * `now` is a parameter so recurrence is testable across simulated days without
 * waiting for them.
 */
export async function tick(
  pool: Pool,
  workerId: string,
  now: Date = new Date(),
): Promise<TickResult> {
  const log = getLogger();

  // The lock is session-scoped, so it must be taken, used and released on one
  // connection. If this process dies holding it, the session ends and Postgres
  // releases it — no stuck lock to clean up.
  const client = await pool.connect();
  try {
    const locked = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [SCHEDULER_LOCK_KEY.toString()],
    );

    if (locked.rows[0]?.acquired !== true) {
      return SKIPPED;
    }

    try {
      const due = await client.query<ScheduleRow>(
        `SELECT id, kind, cron, payload, next_run_at
         FROM schedules
         WHERE enabled AND next_run_at <= $1
         ORDER BY next_run_at`,
        [now],
      );

      let enqueued = 0;
      let duplicates = 0;
      let failed = 0;

      for (const row of due.rows) {
        try {
          const { inserted } = await fire(client, row, now);
          if (inserted) {
            enqueued += 1;
          } else {
            duplicates += 1;
          }
        } catch (error) {
          // One broken schedule must not stop the others, and must not be
          // silent either.
          failed += 1;
          log.error(
            { schedule_id: row.id, job_kind: row.kind, err: error },
            'ALERT: a schedule could not be fired',
          );
        }
      }

      // Written on every tick, including one with nothing due — that is the
      // point of it (§20, migration 003).
      await client.query(
        `INSERT INTO scheduler_heartbeat (id, last_tick_at, last_tick_by)
         VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE
           SET last_tick_at = excluded.last_tick_at,
               last_tick_by = excluded.last_tick_by`,
        [now, workerId],
      );

      return { acquiredLock: true, due: due.rows.length, enqueued, duplicates, failed };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}

/** Enqueues one due schedule's occurrence and advances the schedule. */
async function fire(
  client: PoolClient,
  row: ScheduleRow,
  now: Date,
): Promise<{ inserted: boolean }> {
  if (!isJobKind(row.kind)) {
    throw new Error(`Schedule ${row.id} names an unknown job kind "${row.kind}"`);
  }
  if (!isSchedulableKind(row.kind)) {
    throw new Error(
      `Job kind "${row.kind}" is not schedulable: §7 gives it a permanent dedupe ` +
        'key, which recurring work must never use',
    );
  }

  const spec = SCHEDULABLE[row.kind];
  const payload = spec.payload.parse(row.payload) as Record<string, unknown>;
  const cron = parseCron(row.cron);

  // The occurrence is the time the schedule was DUE, not the time we noticed.
  // That is what makes a late tick late rather than lost, and keeps the key
  // stable across however many ticks it takes to catch up.
  const scheduledFor = row.next_run_at;
  const occurrence = occurrenceToken(cron, scheduledFor);
  const key = spec.key(payload, occurrence);

  const result = await enqueue(client, {
    kind: row.kind,
    dedupeKey: key,
    payload: { ...payload, scheduled_for: scheduledFor.toISOString() },
    traceId: newTraceId(),
  });

  // Advance from the occurrence just fired, so a schedule that was down for a
  // week catches up one occurrence per tick instead of skipping them.
  const nextRunAt = nextCronOccurrence(cron, scheduledFor);

  await client.query(
    `UPDATE schedules SET last_run_at = $2, next_run_at = $3, updated_at = now()
     WHERE id = $1`,
    [row.id, now, nextRunAt],
  );

  return result;
}
