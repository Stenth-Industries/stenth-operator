import type { ChildProcess } from 'node:child_process';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { enqueue } from '../../src/jobs/enqueue';
import { claimJob } from '../../src/jobs/queue';
import { reap } from '../../src/worker/reaper';
import { firstJsonLine, killTree, spawnScript } from '../helpers/childProcess';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const TRACE = '01JA2BCDEFGHJKMNPQRSTVWXYZ';

const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the crash-requeue suite.');
}

/** Spawns the crash worker and resolves once it has claimed a job. */
async function spawnCrashWorker(
  databaseUrl: string,
  workerId: string,
): Promise<{ child: ChildProcess; claimed: string | null; attempts: number | null }> {
  const child = spawnScript('tests/helpers/crash-worker.ts', {
    CRASH_DATABASE_URL: databaseUrl,
    CRASH_WORKER_ID: workerId,
    DATABASE_URL: databaseUrl,
  });
  const claim = await firstJsonLine<{ claimed: string | null; attempts: number | null }>(child);
  return { child, ...claim };
}

describeWithDb('GATE: crash requeue (SPEC.md §6, §24)', () => {
  let db: TestDatabase;
  let app: Pool;
  let appUrl: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
    appUrl = db.urlAs('operator_app');
  }, 120_000);

  afterAll(async () => {
    await Promise.all(children.map(killTree));
    await db?.close();
  });

  afterEach(async () => {
    await db.resetQueue();
  });

  it('recovers a job whose worker was killed mid-flight, without double-executing it', async () => {
    await enqueue(app, {
      kind: 'maintenance.prune',
      dedupeKey: 'prune:crash',
      traceId: TRACE,
      maxAttempts: 3,
    });

    // A real process claims the job, then is SIGKILLed — no unwind, no cleanup.
    const worker = await spawnCrashWorker(appUrl, 'doomed-worker');
    children.push(worker.child);
    expect(worker.claimed).not.toBeNull();
    expect(worker.attempts).toBe(1);

    await killTree(worker.child);

    // The queue is now in the state only a crash produces: running, locked, and
    // nobody is coming back for it.
    const stranded = await app.query<{ status: string; locked_by: string; attempts: number }>(
      'SELECT status, locked_by, attempts FROM jobs WHERE id = $1',
      [worker.claimed],
    );
    expect(stranded.rows[0]?.status).toBe('running');
    expect(stranded.rows[0]?.locked_by).toBe('doomed-worker');
    expect(stranded.rows[0]?.attempts).toBe(1);

    const openRun = await app.query<{ status: string; finished_at: Date | null }>(
      'SELECT status, finished_at FROM job_runs WHERE job_id = $1 AND attempt = 1',
      [worker.claimed],
    );
    expect(openRun.rows[0]?.status).toBe('running');
    expect(openRun.rows[0]?.finished_at).toBeNull();

    // No other worker may pick it up while it still looks alive: that is what
    // stops two processes running the same job.
    expect(await claimJob(app, 'another-worker')).toBeUndefined();

    // The reaper, with a zero staleness window so the test does not wait 15
    // minutes for what it is actually asserting.
    expect(await reap(app, 0)).toStrictEqual({ requeued: 1, dead: 0 });

    const recovered = await app.query<{ status: string; attempts: number; locked_by: string | null }>(
      'SELECT status, attempts, locked_by FROM jobs WHERE id = $1',
      [worker.claimed],
    );
    expect(recovered.rows[0]?.status).toBe('queued');
    expect(recovered.rows[0]?.attempts).toBe(1); // counted at claim time, not refunded
    expect(recovered.rows[0]?.locked_by).toBeNull();

    // The crashed attempt is closed rather than left open for ever.
    const closedRun = await app.query<{ status: string; error: string }>(
      'SELECT status, error FROM job_runs WHERE job_id = $1 AND attempt = 1',
      [worker.claimed],
    );
    expect(closedRun.rows[0]?.status).toBe('failed');
    expect(closedRun.rows[0]?.error).toContain('reaped');

    // And it is claimable again, as attempt 2, by exactly one worker.
    const retried = await claimJob(app, 'fresh-worker');
    expect(retried?.id).toBe(worker.claimed);
    expect(retried?.attempts).toBe(2);
    expect(await claimJob(app, 'yet-another-worker')).toBeUndefined();

    const runs = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM job_runs WHERE job_id = $1',
      [worker.claimed],
    );
    expect(runs.rows[0]?.count).toBe('2');
  }, 120_000);

  it('does not refund attempts, so a handler that always kills its worker dies (§6)', async () => {
    // maxAttempts 1: the first crash is the last chance.
    await enqueue(app, {
      kind: 'maintenance.prune',
      dedupeKey: 'prune:crash-once',
      traceId: TRACE,
      maxAttempts: 1,
    });

    const worker = await spawnCrashWorker(appUrl, 'doomed-once');
    children.push(worker.child);
    await killTree(worker.child);

    expect(await reap(app, 0)).toStrictEqual({ requeued: 0, dead: 1 });

    const { rows } = await app.query<{ status: string }>(
      'SELECT status FROM jobs WHERE id = $1',
      [worker.claimed],
    );
    expect(rows[0]?.status).toBe('dead');
    expect(await claimJob(app, 'anyone')).toBeUndefined();
  }, 120_000);
});
