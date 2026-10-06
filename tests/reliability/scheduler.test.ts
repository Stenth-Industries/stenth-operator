import type { ChildProcess } from 'node:child_process';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { tick, SCHEDULER_LOCK_KEY } from '../../src/worker/scheduler';
import { firstJsonLine, killTree, runScript, spawnScript } from '../helpers/childProcess';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the scheduler suite.');
}

interface TickOutput {
  acquiredLock: boolean;
  due: number;
  enqueued: number;
  duplicates: number;
  failed: number;
}

/** Runs one tick in its own process and resolves with what it reported. */
function tickInChildProcess(schedUrl: string, workerId: string, now?: Date): Promise<TickOutput> {
  return runScript<TickOutput>('tests/helpers/scheduler-tick.ts', {
    SCHED_DATABASE_URL_OVERRIDE: schedUrl,
    DATABASE_URL: schedUrl,
    TICK_WORKER_ID: workerId,
    ...(now === undefined ? {} : { TICK_NOW: now.toISOString() }),
  });
}

async function spawnLockHolder(schedUrl: string): Promise<ChildProcess> {
  const child = spawnScript('tests/helpers/hold-scheduler-lock.ts', {
    SCHED_DATABASE_URL_OVERRIDE: schedUrl,
    DATABASE_URL: schedUrl,
  });
  const reported = await firstJsonLine<{ held: boolean }>(child);
  if (!reported.held) {
    await killTree(child);
    throw new Error('lock holder failed to take the lock');
  }
  return child;
}

/**
 * Waits until the scheduler's advisory lock is genuinely free.
 *
 * Killing a process closes its socket, but the lock is released when PostgreSQL
 * notices the backend is gone — quick, and not instantaneous. A test that
 * assumed otherwise would be flaky, and would also leak a held lock into the
 * next test. Production needs no equivalent: the next tick simply stands down
 * and tries again 60 seconds later.
 */
async function waitForLockFree(pool: Pool, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [SCHEDULER_LOCK_KEY.toString()],
      );
      if (rows[0]?.acquired === true) {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY.toString()]);
        return;
      }
    } finally {
      client.release();
    }

    if (Date.now() > deadline) {
      throw new Error('the scheduler advisory lock was never released');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeWithDb('the in-process scheduler (SPEC.md §6, §7, §24)', () => {
  let db: TestDatabase;
  let app: Pool;
  let sched: Pool;
  let schedUrl: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
    sched = db.poolAs('operator_sched');
    schedUrl = db.urlAs('operator_sched');
  }, 120_000);

  afterAll(async () => {
    await Promise.all(children.map(killTree));
    await db?.close();
  });

  afterEach(async () => {
    await waitForLockFree(db.adminPool);
    await db.resetQueue();
  });

  async function addSchedule(cron: string, nextRunAt: Date, kind = 'maintenance.prune', payload: unknown = {}) {
    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO schedules (kind, cron, payload, enabled, next_run_at)
       VALUES ($1, $2, $3::jsonb, true, $4) RETURNING id`,
      [kind, cron, JSON.stringify(payload), nextRunAt],
    );
    return rows[0]!.id;
  }

  async function jobKeys(): Promise<string[]> {
    const { rows } = await app.query<{ dedupe_key: string }>(
      'SELECT dedupe_key FROM jobs ORDER BY dedupe_key',
    );
    return rows.map((r) => r.dedupe_key);
  }

  // ---------------------------------------------------------------- GATE 5
  describe('GATE: recurrence', () => {
    it('fires on each occurrence across simulated days, not just the first (§24)', async () => {
      // The v1.0 bug this exists to catch produced no error, no dead job and no
      // alert — only a schedule that quietly stopped after one run.
      const id = await addSchedule('30 2 * * *', new Date('2026-10-07T02:30:00.000Z'));

      for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) {
        const result = await tick(sched, 'worker-1', new Date(`${day}T03:00:00.000Z`));
        expect(result.acquiredLock).toBe(true);
        expect(result.due).toBe(1);
        expect(result.enqueued).toBe(1);
      }

      expect(await jobKeys()).toStrictEqual([
        'prune:2026-10-07',
        'prune:2026-10-08',
        'prune:2026-10-09',
      ]);

      const { rows } = await db.adminPool.query<{ next_run_at: Date; last_run_at: Date }>(
        'SELECT next_run_at, last_run_at FROM schedules WHERE id = $1',
        [id],
      );
      expect(rows[0]?.next_run_at.toISOString()).toBe('2026-10-10T02:30:00.000Z');
      expect(rows[0]?.last_run_at).not.toBeNull();
    });

    it('is idempotent within one occurrence: ticking twice enqueues once (§7)', async () => {
      await addSchedule('30 2 * * *', new Date('2026-10-07T02:30:00.000Z'));

      const first = await tick(sched, 'worker-1', new Date('2026-10-07T02:31:00.000Z'));
      expect(first.enqueued).toBe(1);

      // Force the same occurrence to look due again, as a crash between the
      // enqueue and the schedule update would.
      await db.adminPool.query(
        "UPDATE schedules SET next_run_at = '2026-10-07T02:30:00.000Z'",
      );

      const second = await tick(sched, 'worker-1', new Date('2026-10-07T02:32:00.000Z'));
      expect(second.due).toBe(1);
      expect(second.enqueued).toBe(0);
      expect(second.duplicates).toBe(1);

      expect(await jobKeys()).toStrictEqual(['prune:2026-10-07']);
    });

    it('catches up a missed occurrence rather than losing it (§6)', async () => {
      // Down for three days: next_run_at is still in the past, so each
      // occurrence still fires, one per tick.
      await addSchedule('30 2 * * *', new Date('2026-10-05T02:30:00.000Z'));
      const now = new Date('2026-10-08T09:00:00.000Z');

      for (let i = 0; i < 3; i += 1) {
        expect((await tick(sched, 'worker-1', now)).enqueued).toBe(1);
      }

      expect(await jobKeys()).toStrictEqual([
        'prune:2026-10-05',
        'prune:2026-10-06',
        'prune:2026-10-07',
      ]);
    });

    it('keeps sub-daily occurrences distinct, which a date-only key would not (§7)', async () => {
      await addSchedule('0 * * * *', new Date('2026-10-07T01:00:00.000Z'));

      for (let i = 0; i < 3; i += 1) {
        expect((await tick(sched, 'worker-1', new Date('2026-10-07T04:00:00.000Z'))).enqueued).toBe(1);
      }

      expect(await jobKeys()).toStrictEqual([
        'prune:2026-10-07T01:00',
        'prune:2026-10-07T02:00',
        'prune:2026-10-07T03:00',
      ]);
    });

    it('ignores a disabled schedule and one that is not yet due', async () => {
      await db.adminPool.query(
        `INSERT INTO schedules (kind, cron, enabled, next_run_at)
         VALUES ('maintenance.prune', '30 2 * * *', false, '2026-01-01T00:00:00Z')`,
      );
      await addSchedule('30 2 * * *', new Date('2027-01-01T02:30:00.000Z'));

      const result = await tick(sched, 'worker-1', new Date('2026-10-07T03:00:00.000Z'));
      expect(result.due).toBe(0);
      expect(await jobKeys()).toStrictEqual([]);
    });

    it('builds the discover.search key from its payload, per §7', async () => {
      await addSchedule('0 6 * * *', new Date('2026-10-07T06:00:00.000Z'), 'discover.search', {
        campaign: 'au-law',
        query_hash: 'q9f2',
      });
      expect((await tick(sched, 'worker-1', new Date('2026-10-07T06:01:00.000Z'))).enqueued).toBe(1);
      expect(await jobKeys()).toStrictEqual(['discover:au-law:q9f2:2026-10-07']);
    });

    it('fails one broken schedule loudly without stopping the others', async () => {
      // discover.search without its payload fields cannot produce a valid §7
      // key; enqueueing `discover:undefined:undefined:...` would be worse.
      await addSchedule('0 6 * * *', new Date('2026-10-07T06:00:00.000Z'), 'discover.search', {});
      await addSchedule('30 2 * * *', new Date('2026-10-07T02:30:00.000Z'));

      const result = await tick(sched, 'worker-1', new Date('2026-10-07T07:00:00.000Z'));
      expect(result.due).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(await jobKeys()).toStrictEqual(['prune:2026-10-07']);
    });

    it('refuses to schedule a kind whose §7 key is permanent', async () => {
      // A permanent key on recurring work runs once and then never again,
      // silently — the exact failure §7 forbids.
      await addSchedule('30 2 * * *', new Date('2026-10-07T02:30:00.000Z'), 'company.assess', {});
      const result = await tick(sched, 'worker-1', new Date('2026-10-07T03:00:00.000Z'));
      expect(result.failed).toBe(1);
      expect(result.enqueued).toBe(0);
    });
  });

  // ---------------------------------------------------------------- heartbeat
  describe('heartbeat (§20, migration 003)', () => {
    it('records a tick even when nothing is due', async () => {
      const now = new Date('2026-10-07T03:00:00.000Z');
      const result = await tick(sched, 'worker-1', now);
      expect(result.due).toBe(0);

      const { rows } = await db.adminPool.query<{ last_tick_at: Date; last_tick_by: string }>(
        'SELECT last_tick_at, last_tick_by FROM scheduler_heartbeat',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.last_tick_at.toISOString()).toBe(now.toISOString());
      expect(rows[0]?.last_tick_by).toBe('worker-1');
    });

    it('stays one row however many ticks happen', async () => {
      for (const minute of [1, 2, 3]) {
        await tick(sched, `worker-${minute}`, new Date(`2026-10-07T03:0${minute}:00.000Z`));
      }
      const { rows } = await db.adminPool.query<{ count: string; last_tick_by: string }>(
        'SELECT count(*) AS count, max(last_tick_by) AS last_tick_by FROM scheduler_heartbeat',
      );
      expect(rows[0]?.count).toBe('1');
      expect(rows[0]?.last_tick_by).toBe('worker-3');
    });

    it('is readable by the app role, which is what /api/health uses', async () => {
      // The real clock here: the other cases pass a simulated instant, and an
      // age computed against a future one is negative.
      await tick(sched, 'worker-1', new Date());
      // 002's ALTER DEFAULT PRIVILEGES should have covered this table; asserted
      // rather than assumed, because it also covers every future migration.
      const { rows } = await app.query<{ age: string | null }>(
        'SELECT extract(epoch FROM now() - last_tick_at) AS age FROM scheduler_heartbeat',
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.age)).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------- GATE 6
  describe('GATE: mutual exclusion', () => {
    it('stands down while another process holds the lock, enqueueing nothing', async () => {
      await addSchedule('30 2 * * *', new Date('2026-10-07T02:30:00.000Z'));

      const holder = await spawnLockHolder(schedUrl);
      children.push(holder);

      try {
        const result = await tick(sched, 'worker-2', new Date('2026-10-07T03:00:00.000Z'));
        expect(result.acquiredLock).toBe(false);
        expect(result.enqueued).toBe(0);
        expect(await jobKeys()).toStrictEqual([]);

        // It did not even write a heartbeat: it genuinely did nothing.
        const beats = await db.adminPool.query('SELECT 1 FROM scheduler_heartbeat');
        expect(beats.rows).toHaveLength(0);
      } finally {
        await killTree(holder);
      }

      // Once the holder's session is gone, Postgres releases the lock on its
      // own — a crashed scheduler leaves nothing to clean up.
      await waitForLockFree(db.adminPool);
      const after = await tick(sched, 'worker-2', new Date('2026-10-07T03:01:00.000Z'));
      expect(after.acquiredLock).toBe(true);
      expect(after.enqueued).toBe(1);
    }, 120_000);

    it('two real processes ticking at once produce one occurrence, never two (§24)', async () => {
      await addSchedule('30 2 * * *', new Date('2026-10-07T02:30:00.000Z'));
      const now = new Date('2026-10-07T03:00:00.000Z');

      const [a, b] = await Promise.all([
        tickInChildProcess(schedUrl, 'proc-a', now),
        tickInChildProcess(schedUrl, 'proc-b', now),
      ]);

      // Exactly one of them did the work — whether the other was locked out or
      // simply found nothing left to do, the outcome is the same.
      expect(a.enqueued + b.enqueued).toBe(1);
      expect(await jobKeys()).toStrictEqual(['prune:2026-10-07']);

      const { rows } = await db.adminPool.query<{ count: string }>(
        'SELECT count(*) AS count FROM jobs',
      );
      expect(rows[0]?.count).toBe('1');
    }, 120_000);

    it('six concurrent processes still produce exactly one occurrence', async () => {
      await addSchedule('30 2 * * *', new Date('2026-10-07T02:30:00.000Z'));
      const now = new Date('2026-10-07T03:00:00.000Z');

      const results = await Promise.all(
        Array.from({ length: 6 }, (_u, i) => tickInChildProcess(schedUrl, `proc-${i}`, now)),
      );

      expect(results.reduce((sum, r) => sum + r.enqueued, 0)).toBe(1);
      expect(await jobKeys()).toStrictEqual(['prune:2026-10-07']);

      // The schedule advanced exactly one occurrence, not six.
      const { rows } = await db.adminPool.query<{ next_run_at: Date }>(
        'SELECT next_run_at FROM schedules',
      );
      expect(rows[0]?.next_run_at.toISOString()).toBe('2026-10-08T02:30:00.000Z');
    }, 180_000);
  });

  // ---------------------------------------------------------------- §17 roles
  describe('the scheduler role is boxed in (§17)', () => {
    it('cannot read a contact, a draft or an approved record', async () => {
      for (const table of ['contacts', 'outreach_drafts', 'approved_outreach']) {
        await expect(sched.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it('can insert a job but not claim one', async () => {
      await expect(
        sched.query("UPDATE jobs SET status = 'running' WHERE status = 'queued'"),
      ).rejects.toThrow(/permission denied/);
    });

    it('reads only the dedupe key of a job, never its payload (migration 003)', async () => {
      // The column grant that makes §7's ON CONFLICT (dedupe_key) work is one
      // column wide, and this is what keeps it that way.
      await expect(sched.query('SELECT * FROM jobs LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(sched.query('SELECT payload FROM jobs LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(sched.query('SELECT dedupe_key FROM jobs LIMIT 1')).resolves.toBeDefined();
    });

    it('uses the lock key the whole system agrees on', () => {
      expect(SCHEDULER_LOCK_KEY).toBe(7_315_204_118_664_001n);
    });
  });
});
