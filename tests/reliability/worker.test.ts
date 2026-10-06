import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { enqueue } from '../../src/jobs/enqueue';
import { clearHandlers, registerHandler } from '../../src/worker/handlers';
import { startWorker, CONCURRENCY } from '../../src/worker/index';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const TRACE = '01JA2BCDEFGHJKMNPQRSTVWXYZ';
const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the worker suite.');
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the worker');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeWithDb('the worker loop end to end (SPEC.md §6)', () => {
  let db: TestDatabase;
  let app: Pool;
  let sched: Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
    sched = db.poolAs('operator_sched');
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(() => {
    clearHandlers();
  });

  afterEach(async () => {
    clearHandlers();
    await db.resetQueue();
  });

  async function statusOf(dedupeKey: string): Promise<string | undefined> {
    const { rows } = await app.query<{ status: string }>(
      'SELECT status FROM jobs WHERE dedupe_key = $1',
      [dedupeKey],
    );
    return rows[0]?.status;
  }

  it('runs four handlers in-process, as §6 specifies', () => {
    expect(CONCURRENCY).toBe(4);
  });

  it('claims, runs and completes a job without being told to', async () => {
    const ran: string[] = [];
    registerHandler('maintenance.prune', async (job) => {
      ran.push(job.dedupe_key);
    });

    const worker = startWorker({
      appPool: app,
      schedPool: sched,
      workerId: 'test-worker',
      idlePollMs: 25,
      timerIntervalMs: 3_600_000, // the timer is not what this test is about
    });

    try {
      await enqueue(app, {
        kind: 'maintenance.prune',
        dedupeKey: 'prune:worker-ok',
        traceId: TRACE,
      });

      await waitFor(async () =>
        (await statusOf('prune:worker-ok')) === 'succeeded' ? true : undefined,
      );
      expect(ran).toStrictEqual(['prune:worker-ok']);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it('retries a failing handler and then lets it die, with no busy-looping', async () => {
    let calls = 0;
    registerHandler('maintenance.prune', async () => {
      calls += 1;
      throw new Error('always fails');
    });

    const worker = startWorker({
      appPool: app,
      schedPool: sched,
      workerId: 'test-worker',
      idlePollMs: 25,
      timerIntervalMs: 3_600_000,
    });

    try {
      await enqueue(app, {
        kind: 'maintenance.prune',
        dedupeKey: 'prune:worker-fail',
        traceId: TRACE,
        maxAttempts: 2,
      });

      // First attempt fails, then the job waits out its backoff rather than
      // being re-claimed immediately.
      await waitFor(async () => (calls >= 1 ? true : undefined));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(calls).toBe(1);
      expect(await statusOf('prune:worker-fail')).toBe('queued');

      // Make the retry eligible; the loop picks it up and exhausts the budget.
      await app.query("UPDATE jobs SET run_after = now() WHERE dedupe_key = $1", [
        'prune:worker-fail',
      ]);
      await waitFor(async () =>
        (await statusOf('prune:worker-fail')) === 'dead' ? true : undefined,
      );
      expect(calls).toBe(2);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it('fails a job whose kind has no handler instead of dropping it', async () => {
    const worker = startWorker({
      appPool: app,
      schedPool: sched,
      workerId: 'test-worker',
      idlePollMs: 25,
      timerIntervalMs: 3_600_000,
    });

    try {
      await enqueue(app, {
        kind: 'eval.run',
        dedupeKey: 'eval:nohandler',
        traceId: TRACE,
      });

      // eval.run has a budget of 1 (§6), so one attempt is the whole story.
      await waitFor(async () =>
        (await statusOf('eval:nohandler')) === 'dead' ? true : undefined,
      );

      const { rows } = await app.query<{ last_error: string }>(
        'SELECT last_error FROM jobs WHERE dedupe_key = $1',
        ['eval:nohandler'],
      );
      expect(rows[0]?.last_error).toContain('No handler is registered');
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it('drains concurrently and still runs each job exactly once', async () => {
    const seen: string[] = [];
    registerHandler('maintenance.prune', async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push(job.dedupe_key);
    });

    const worker = startWorker({
      appPool: app,
      schedPool: sched,
      workerId: 'test-worker',
      idlePollMs: 10,
      timerIntervalMs: 3_600_000,
    });

    try {
      for (let i = 0; i < 24; i += 1) {
        await enqueue(app, {
          kind: 'maintenance.prune',
          dedupeKey: `prune:conc:${i}`,
          traceId: TRACE,
        });
      }

      await waitFor(async () => {
        const { rows } = await app.query<{ count: string }>(
          "SELECT count(*) AS count FROM jobs WHERE status = 'succeeded'",
        );
        return rows[0]?.count === '24' ? true : undefined;
      });

      expect(seen).toHaveLength(24);
      expect(new Set(seen).size).toBe(24);

      const runs = await app.query<{ count: string }>('SELECT count(*) AS count FROM job_runs');
      expect(runs.rows[0]?.count).toBe('24');
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it('ticks the scheduler and reaps on its timer (§6)', async () => {
    registerHandler('maintenance.prune', async () => undefined);

    await db.adminPool.query(
      `INSERT INTO schedules (kind, cron, payload, enabled, next_run_at)
       VALUES ('maintenance.prune', '*/5 * * * *', '{}'::jsonb, true, now() - interval '1 minute')`,
    );

    const worker = startWorker({
      appPool: app,
      schedPool: sched,
      workerId: 'timer-worker',
      idlePollMs: 25,
      timerIntervalMs: 100,
      staleAfterSeconds: 0,
    });

    try {
      // The scheduler enqueued the due occurrence, and the loop then ran it.
      await waitFor(async () => {
        const { rows } = await app.query<{ count: string }>(
          "SELECT count(*) AS count FROM jobs WHERE status = 'succeeded'",
        );
        return rows[0]?.count === '1' ? true : undefined;
      });

      // And the heartbeat proves the timer is alive, which is what /api/health
      // reports (§20).
      const beat = await app.query<{ age: string }>(
        'SELECT extract(epoch FROM now() - last_tick_at) AS age FROM scheduler_heartbeat',
      );
      expect(beat.rows).toHaveLength(1);
      expect(Number(beat.rows[0]?.age)).toBeLessThan(30);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it('stops cleanly, finishing the job in flight', async () => {
    let finished = false;
    registerHandler('maintenance.prune', async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      finished = true;
    });

    const worker = startWorker({
      appPool: app,
      schedPool: sched,
      workerId: 'test-worker',
      idlePollMs: 10,
      timerIntervalMs: 3_600_000,
    });

    await enqueue(app, {
      kind: 'maintenance.prune',
      dedupeKey: 'prune:graceful',
      traceId: TRACE,
    });

    // Wait until it has been claimed, then ask the worker to stop.
    await waitFor(async () =>
      (await statusOf('prune:graceful')) === 'running' ? true : undefined,
    );
    await worker.stop();

    expect(finished).toBe(true);
    expect(await statusOf('prune:graceful')).toBe('succeeded');
  }, 60_000);
});
