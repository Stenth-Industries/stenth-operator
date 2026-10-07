import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { baseBackoffSeconds } from '../../src/jobs/backoff';
import { enqueue } from '../../src/jobs/enqueue';
import {
  blockJob,
  claimJob,
  completeJob,
  failJob,
  describeError,
  requeueBlockedJob,
} from '../../src/jobs/queue';
import { reap } from '../../src/worker/reaper';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const TRACE = '01JA2BCDEFGHJKMNPQRSTVWXYZ';
const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the job engine suite.');
}

describeWithDb('the job engine against real PostgreSQL (SPEC.md §6, §7)', () => {
  let db: TestDatabase;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.resetQueue();
  });

  async function seed(overrides: Partial<Parameters<typeof enqueue>[1]> = {}) {
    const result = await enqueue(app, {
      kind: 'maintenance.prune',
      dedupeKey: `prune:${Math.random().toString(36).slice(2)}`,
      traceId: TRACE,
      ...overrides,
    });
    return result;
  }

  // ---------------------------------------------------------------- GATE 1
  describe('GATE: duplicate enqueue', () => {
    it('creates exactly one row from 100 concurrent identical enqueues (§24)', async () => {
      const key = 'prune:2026-10-07';
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          enqueue(app, {
            kind: 'maintenance.prune',
            dedupeKey: key,
            traceId: TRACE,
          }),
        ),
      );

      const inserted = results.filter((r) => r.inserted).length;
      expect(inserted).toBe(1);

      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM jobs WHERE dedupe_key = $1',
        [key],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('reports a duplicate as not-inserted rather than throwing (§7)', async () => {
      const key = 'prune:2026-10-08';
      expect((await enqueue(app, { kind: 'maintenance.prune', dedupeKey: key, traceId: TRACE })).inserted).toBe(true);
      expect((await enqueue(app, { kind: 'maintenance.prune', dedupeKey: key, traceId: TRACE })).inserted).toBe(false);
    });

    it('does not let a duplicate enqueue create duplicate executable work', async () => {
      const key = 'prune:2026-10-09';
      await enqueue(app, { kind: 'maintenance.prune', dedupeKey: key, traceId: TRACE });
      await enqueue(app, { kind: 'maintenance.prune', dedupeKey: key, traceId: TRACE });

      const first = await claimJob(app, 'w1');
      const second = await claimJob(app, 'w1');
      expect(first).toBeDefined();
      expect(second).toBeUndefined();
    });

    it('defaults max_attempts to the kind’s §6 budget', async () => {
      await enqueue(app, { kind: 'web.extract', dedupeKey: 'extract:s1:v1', traceId: TRACE });
      const { rows } = await app.query<{ max_attempts: number }>(
        'SELECT max_attempts FROM jobs WHERE dedupe_key = $1',
        ['extract:s1:v1'],
      );
      expect(rows[0]?.max_attempts).toBe(2);
    });

    it('preserves the metadata that makes a job traceable (§16)', async () => {
      await enqueue(app, {
        kind: 'company.resolve',
        dedupeKey: 'resolve:example-legal.com.au',
        traceId: TRACE,
        payload: { canonical_domain: 'example-legal.com.au' },
        priority: 5,
      });
      const { rows } = await app.query<{
        trace_id: string; payload: Record<string, unknown>; priority: number; status: string;
      }>('SELECT trace_id, payload, priority, status FROM jobs WHERE dedupe_key = $1', [
        'resolve:example-legal.com.au',
      ]);
      expect(rows[0]?.trace_id).toBe(TRACE);
      expect(rows[0]?.payload).toStrictEqual({ canonical_domain: 'example-legal.com.au' });
      expect(rows[0]?.priority).toBe(5);
      expect(rows[0]?.status).toBe('queued');
    });
  });

  // ---------------------------------------------------------------- claiming
  describe('claiming', () => {
    it('never hands the same job to two workers, under real contention (§6)', async () => {
      const jobCount = 40;
      for (let i = 0; i < jobCount; i += 1) {
        await enqueue(app, {
          kind: 'maintenance.prune',
          dedupeKey: `prune:race:${i}`,
          traceId: TRACE,
        });
      }

      // Eight concurrent claimers, each draining until the queue is empty.
      const claimed = await Promise.all(
        Array.from({ length: 8 }, async (_unused, worker) => {
          const mine: string[] = [];
          for (;;) {
            const job = await claimJob(app, `w${worker}`);
            if (job === undefined) break;
            mine.push(job.id);
          }
          return mine;
        }),
      );

      const all = claimed.flat();
      expect(all).toHaveLength(jobCount);
      expect(new Set(all).size).toBe(jobCount);

      // And exactly one job_runs row per job, which is what proves no job was
      // executed twice rather than merely claimed once.
      const { rows } = await app.query<{ count: string }>(
        `SELECT count(*) AS count FROM (
           SELECT job_id FROM job_runs GROUP BY job_id HAVING count(*) > 1
         ) AS doubled`,
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('orders by priority then run_after, as §6 specifies', async () => {
      const now = Date.now();
      await enqueue(app, { kind: 'maintenance.prune', dedupeKey: 'p:low-old', traceId: TRACE, priority: 0, runAfter: new Date(now - 60_000) });
      await enqueue(app, { kind: 'maintenance.prune', dedupeKey: 'p:high-new', traceId: TRACE, priority: 9, runAfter: new Date(now - 1_000) });
      await enqueue(app, { kind: 'maintenance.prune', dedupeKey: 'p:high-old', traceId: TRACE, priority: 9, runAfter: new Date(now - 30_000) });

      const order: string[] = [];
      for (;;) {
        const job = await claimJob(app, 'w1');
        if (job === undefined) break;
        order.push(job.dedupe_key);
      }
      expect(order).toStrictEqual(['p:high-old', 'p:high-new', 'p:low-old']);
    });

    it('will not claim a job before run_after', async () => {
      await enqueue(app, {
        kind: 'maintenance.prune',
        dedupeKey: 'prune:future',
        traceId: TRACE,
        runAfter: new Date(Date.now() + 60_000),
      });
      expect(await claimJob(app, 'w1')).toBeUndefined();
    });

    it('counts the attempt at claim time and opens a job_runs row (§6)', async () => {
      await seed({ dedupeKey: 'prune:attempt' });
      const job = await claimJob(app, 'worker-a');
      expect(job?.attempts).toBe(1);
      expect(job?.status).toBe('running');
      expect(job?.locked_by).toBe('worker-a');
      expect(job?.locked_at).not.toBeNull();

      const { rows } = await app.query<{ attempt: number; status: string; finished_at: Date | null }>(
        'SELECT attempt, status, finished_at FROM job_runs WHERE job_id = $1',
        [job?.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attempt).toBe(1);
      expect(rows[0]?.status).toBe('running');
      expect(rows[0]?.finished_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------- lifecycle
  describe('lifecycle', () => {
    it('completes a job and closes its attempt', async () => {
      await seed({ dedupeKey: 'prune:ok' });
      const job = await claimJob(app, 'w1');
      await completeJob(app, job!);

      const { rows } = await app.query<{ status: string; locked_by: string | null; last_error: string | null }>(
        'SELECT status, locked_by, last_error FROM jobs WHERE id = $1',
        [job!.id],
      );
      expect(rows[0]?.status).toBe('succeeded');
      expect(rows[0]?.locked_by).toBeNull();
      expect(rows[0]?.last_error).toBeNull();

      const runs = await app.query<{ status: string; finished_at: Date | null }>(
        'SELECT status, finished_at FROM job_runs WHERE job_id = $1',
        [job!.id],
      );
      expect(runs.rows[0]?.status).toBe('succeeded');
      expect(runs.rows[0]?.finished_at).not.toBeNull();
    });

    it('preserves attempt history across retries', async () => {
      await seed({ dedupeKey: 'prune:history', maxAttempts: 3 });

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const job = await claimJob(app, 'w1');
        expect(job?.attempts).toBe(attempt);
        await failJob(app, job!, new Error(`attempt ${attempt} failed`), () => 0.5);
        if (attempt < 3) {
          // Make the retry eligible without waiting out the backoff.
          await app.query("UPDATE jobs SET run_after = now() WHERE id = $1", [job!.id]);
        }
      }

      const { rows } = await app.query<{ attempt: number; status: string; error: string }>(
        'SELECT attempt, status, error FROM job_runs WHERE job_id = (SELECT id FROM jobs WHERE dedupe_key = $1) ORDER BY attempt',
        ['prune:history'],
      );
      expect(rows.map((r) => r.attempt)).toStrictEqual([1, 2, 3]);
      expect(rows.every((r) => r.status === 'failed')).toBe(true);
      expect(rows[0]?.error).toContain('attempt 1 failed');
    });

    it('goes dead after the bounded retry count, with an event (§6)', async () => {
      await seed({ dedupeKey: 'prune:dead', maxAttempts: 2 });

      const first = await claimJob(app, 'w1');
      const firstOutcome = await failJob(app, first!, new Error('boom'), () => 0.5);
      expect(firstOutcome.status).toBe('queued');

      await app.query("UPDATE jobs SET run_after = now() WHERE id = $1", [first!.id]);
      const second = await claimJob(app, 'w1');
      const secondOutcome = await failJob(app, second!, new Error('boom'), () => 0.5);
      expect(secondOutcome.status).toBe('dead');

      const { rows } = await app.query<{ status: string }>(
        'SELECT status FROM jobs WHERE id = $1',
        [first!.id],
      );
      expect(rows[0]?.status).toBe('dead');

      // Terminal: a dead job is not claimable again.
      expect(await claimJob(app, 'w1')).toBeUndefined();

      const events = await app.query<{ kind: string; payload: Record<string, unknown> }>(
        'SELECT kind, payload FROM events WHERE entity_id = $1 ORDER BY created_at',
        [first!.id],
      );
      expect(events.rows.map((e) => e.kind)).toStrictEqual(['job.failed', 'job.dead']);
      expect(events.rows[1]?.payload).toMatchObject({
        job_kind: 'maintenance.prune',
        attempt: 2,
        max_attempts: 2,
        error_class: 'Error',
      });
    });

    it('keeps error text out of events and personal-text keys out of payloads (§16)', async () => {
      await seed({ dedupeKey: 'prune:privacy' });
      const job = await claimJob(app, 'w1');
      await failJob(app, job!, new Error('failed for partner@example-legal.com.au'), () => 0.5);

      const events = await app.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM events WHERE entity_id = $1',
        [job!.id],
      );
      const payload = events.rows[0]?.payload ?? {};
      expect(JSON.stringify(payload)).not.toContain('partner@example-legal.com.au');
      for (const forbidden of ['email', 'to_email', 'full_name', 'name', 'phone', 'address', 'subject', 'body']) {
        expect(Object.keys(payload)).not.toContain(forbidden);
      }
    });

    it('scrubs secrets out of an error before it is stored (§17)', async () => {
      await seed({ dedupeKey: 'prune:secret' });
      const job = await claimJob(app, 'w1');
      await failJob(
        app,
        job!,
        new Error('connect failed: postgresql://operator_app:sup3rs3cret@db/operator'),
        () => 0.5,
      );

      const { rows } = await app.query<{ last_error: string }>(
        'SELECT last_error FROM jobs WHERE id = $1',
        [job!.id],
      );
      expect(rows[0]?.last_error).not.toContain('sup3rs3cret');
      expect(rows[0]?.last_error).toContain('[redacted]');
    });

    it('bounds the stored error length', () => {
      const { message } = describeError(new Error('x'.repeat(50_000)));
      expect(message.length).toBeLessThan(4_200);
      expect(message).toContain('[truncated]');
    });
  });

  // ---------------------------------------------------------------- GATE 3
  // ----------------------------------------------- undoing a terminal state
  //
  // blocked is terminal (§6) and web.extract's dedupe key is permanent (§7),
  // so without a way back a job blocked by a control is a permanent hole: the
  // enqueue that would re-create it hits ON CONFLICT and reports success. This
  // is the only path back, and it is human-driven and attributable.
  describe('requeueing a blocked job', () => {
    async function blocked(dedupeKey: string, maxAttempts = 2) {
      await seed({ dedupeKey, maxAttempts });
      const job = await claimJob(app, 'w1');
      if (job === undefined) {
        throw new Error('expected to claim the seeded job');
      }
      await blockJob(app, job, 'reservation_in_flight', 'a provider call of unknown outcome');
      return job;
    }

    it('moves it back to queued, claimable, with its history intact', async () => {
      const job = await blocked('prune:requeue-me');

      const requeued = await requeueBlockedJob(app, job.id, 'reservation_abandoned', {
        llm_call_id: '00000000-0000-4000-8000-000000000001',
      });
      expect(requeued).toMatchObject({
        jobId: job.id,
        kind: 'maintenance.prune',
        attempts: 1,
        maxAttempts: 2,
      });

      const { rows } = await app.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        locked_by: string | null;
        dedupe_key: string;
      }>(
        'SELECT status, attempts, last_error, locked_by, dedupe_key FROM jobs WHERE id = $1',
        [job.id],
      );
      // Same row, same dedupe key: the §7 identity of the work is unchanged.
      expect(rows[0]).toMatchObject({
        status: 'queued',
        dedupe_key: 'prune:requeue-me',
        last_error: null,
        locked_by: null,
      });
      // The claim that ended in blocked really happened; it is not erased.
      expect(rows[0]?.attempts).toBe(1);

      // And a worker can now pick it up again.
      const again = await claimJob(app, 'w2');
      expect(again?.id).toBe(job.id);
      expect(again?.attempts).toBe(2);

      // The attempt history shows both the blocked attempt and the new one.
      const runs = await app.query<{ attempt: number; status: string }>(
        'SELECT attempt, status FROM job_runs WHERE job_id = $1 ORDER BY attempt',
        [job.id],
      );
      expect(runs.rows.map((row) => row.attempt)).toStrictEqual([1, 2]);
      expect(runs.rows[0]?.status).toBe('failed');
    });

    it('writes a job.requeued event naming the reason and the decision behind it', async () => {
      const job = await blocked('prune:requeue-event');
      await requeueBlockedJob(app, job.id, 'reservation_abandoned', {
        llm_call_id: '00000000-0000-4000-8000-000000000002',
      });

      const { rows } = await app.query<{
        kind: string;
        actor_type: string;
        payload: Record<string, unknown>;
        trace_id: string;
      }>(
        `SELECT kind, actor_type::text AS actor_type, payload, trace_id
           FROM events WHERE entity_id = $1 ORDER BY created_at`,
        [job.id],
      );
      const requeued = rows.find((row) => row.kind === 'job.requeued');
      expect(requeued).toBeDefined();
      // A human undid a terminal state; the spine says so, and says why.
      expect(requeued?.actor_type).toBe('human');
      expect(requeued?.trace_id).toBe(TRACE);
      expect(requeued?.payload).toMatchObject({
        job_kind: 'maintenance.prune',
        reason: 'reservation_abandoned',
        attempts: 1,
        max_attempts: 2,
        llm_call_id: '00000000-0000-4000-8000-000000000002',
      });
      // The job.blocked event it undoes is still there. Both are facts.
      expect(rows.some((row) => row.kind === 'job.blocked')).toBe(true);
    });

    it('refuses anything that is not blocked, and says so rather than guessing', async () => {
      await seed({ dedupeKey: 'prune:still-queued' });
      const { rows } = await app.query<{ id: string }>(
        'SELECT id FROM jobs WHERE dedupe_key = $1',
        ['prune:still-queued'],
      );
      const queuedId = rows[0]?.id as string;
      expect(await requeueBlockedJob(app, queuedId, 'reservation_abandoned')).toBeUndefined();

      const running = await claimJob(app, 'w1');
      expect(await requeueBlockedJob(app, running!.id, 'reservation_abandoned')).toBeUndefined();
      await completeJob(app, running!);
      expect(await requeueBlockedJob(app, running!.id, 'reservation_abandoned')).toBeUndefined();

      // A row that does not exist at all is the same answer, not a throw.
      expect(
        await requeueBlockedJob(app, '00000000-0000-4000-8000-00000000dead', 'x'),
      ).toBeUndefined();

      // Nothing moved, and no requeue event was written for any of them.
      const events = await app.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM events WHERE kind = 'job.requeued'`,
      );
      expect(events.rows[0]?.count).toBe('0');
    });

    it('lets exactly one of many concurrent requeues move the job', async () => {
      const job = await blocked('prune:requeue-race');
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          requeueBlockedJob(app, job.id, 'reservation_abandoned'),
        ),
      );
      expect(results.filter((result) => result !== undefined)).toHaveLength(1);

      // One move, one event: the terminal state was undone once.
      const events = await app.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM events WHERE kind = 'job.requeued'`,
      );
      expect(events.rows[0]?.count).toBe('1');
    });

    it('still reports a job whose attempt budget is spent, rather than hiding it', async () => {
      const job = await blocked('prune:last-attempt', 1);
      const requeued = await requeueBlockedJob(app, job.id, 'budget_hard_stop');
      // Requeued, but with nothing left: the caller has to decide, and the
      // numbers are in front of it rather than inferred.
      expect(requeued).toMatchObject({ attempts: 1, maxAttempts: 1 });
    });
  });

  describe('GATE: backoff', () => {
    it('schedules the retry on the §6 formula and not before', async () => {
      await seed({ dedupeKey: 'prune:backoff', maxAttempts: 5 });
      const job = await claimJob(app, 'w1');

      const before = Date.now();
      const outcome = await failJob(app, job!, new Error('boom'), () => 0.5); // no jitter
      expect(outcome.status).toBe('queued');

      const delayMs = (outcome.nextRunAfter as Date).getTime() - before;
      // attempts = 1 -> 60 * 2^1 = 120s, un-jittered.
      expect(delayMs / 1000).toBeGreaterThan(115);
      expect(delayMs / 1000).toBeLessThan(125);
    });

    it('makes a retry claimable only once it is eligible', async () => {
      await seed({ dedupeKey: 'prune:eligible', maxAttempts: 5 });
      const job = await claimJob(app, 'w1');
      await failJob(app, job!, new Error('boom'), () => 0.5);

      // Queued, but in the future: a failing job must not busy-loop.
      const { rows } = await app.query<{ status: string }>(
        'SELECT status FROM jobs WHERE id = $1',
        [job!.id],
      );
      expect(rows[0]?.status).toBe('queued');
      expect(await claimJob(app, 'w1')).toBeUndefined();

      await app.query("UPDATE jobs SET run_after = now() WHERE id = $1", [job!.id]);
      const retried = await claimJob(app, 'w1');
      expect(retried?.id).toBe(job!.id);
      expect(retried?.attempts).toBe(2);
    });

    it('grows the delay per attempt and caps it at an hour', async () => {
      await seed({ dedupeKey: 'prune:growth', maxAttempts: 10 });
      const seen: number[] = [];

      for (let attempt = 1; attempt <= 7; attempt += 1) {
        const job = await claimJob(app, 'w1');
        const before = Date.now();
        const outcome = await failJob(app, job!, new Error('boom'), () => 0.5);
        seen.push(Math.round(((outcome.nextRunAfter as Date).getTime() - before) / 1000));
        await app.query("UPDATE jobs SET run_after = now() WHERE id = $1", [job!.id]);
      }

      for (let i = 1; i < seen.length; i += 1) {
        expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
      }
      expect(seen[0]).toBeCloseTo(baseBackoffSeconds(1), -1);
      expect(seen[seen.length - 1]).toBeCloseTo(3600, -2);
    });
  });

  // ---------------------------------------------------------------- GATE 4
  describe('GATE: reaper', () => {
    it('requeues a job whose lock has expired, with the attempt already counted (§24)', async () => {
      await seed({ dedupeKey: 'prune:reap', maxAttempts: 3 });
      const job = await claimJob(app, 'crashed-worker');
      expect(job?.attempts).toBe(1);

      await app.query(
        "UPDATE jobs SET locked_at = now() - interval '20 minutes' WHERE id = $1",
        [job!.id],
      );

      const result = await reap(app);
      expect(result).toStrictEqual({ requeued: 1, dead: 0 });

      const { rows } = await app.query<{ status: string; attempts: number; locked_by: string | null }>(
        'SELECT status, attempts, locked_by FROM jobs WHERE id = $1',
        [job!.id],
      );
      expect(rows[0]?.status).toBe('queued');
      expect(rows[0]?.attempts).toBe(1); // not reset, and not incremented
      expect(rows[0]?.locked_by).toBeNull();

      // The dead attempt is closed, so history shows what happened to it.
      const runs = await app.query<{ status: string; finished_at: Date | null }>(
        'SELECT status, finished_at FROM job_runs WHERE job_id = $1 AND attempt = 1',
        [job!.id],
      );
      expect(runs.rows[0]?.status).toBe('failed');
      expect(runs.rows[0]?.finished_at).not.toBeNull();

      const events = await app.query<{ kind: string }>(
        'SELECT kind FROM events WHERE entity_id = $1',
        [job!.id],
      );
      expect(events.rows.map((e) => e.kind)).toContain('job.reaped');
    });

    it('leaves a job alone while its lock is fresh', async () => {
      await seed({ dedupeKey: 'prune:fresh' });
      const job = await claimJob(app, 'w1');
      expect(await reap(app)).toStrictEqual({ requeued: 0, dead: 0 });
      const { rows } = await app.query<{ status: string }>(
        'SELECT status FROM jobs WHERE id = $1',
        [job!.id],
      );
      expect(rows[0]?.status).toBe('running');
    });

    it('marks a reaped job dead when its attempts are already exhausted (§6)', async () => {
      // Without this, a handler that reliably kills its worker would be
      // requeued and re-claimed for ever, which is what §6 warns about.
      await seed({ dedupeKey: 'prune:reap-dead', maxAttempts: 1 });
      const job = await claimJob(app, 'crashed-worker');
      expect(job?.attempts).toBe(1);

      await app.query(
        "UPDATE jobs SET locked_at = now() - interval '20 minutes' WHERE id = $1",
        [job!.id],
      );

      expect(await reap(app)).toStrictEqual({ requeued: 0, dead: 1 });

      const { rows } = await app.query<{ status: string }>(
        'SELECT status FROM jobs WHERE id = $1',
        [job!.id],
      );
      expect(rows[0]?.status).toBe('dead');

      const events = await app.query<{ kind: string }>(
        'SELECT kind FROM events WHERE entity_id = $1 ORDER BY created_at',
        [job!.id],
      );
      expect(events.rows.map((e) => e.kind)).toStrictEqual(['job.reaped', 'job.dead']);
    });

    it('reaps a batch without double-activating anything', async () => {
      for (let i = 0; i < 5; i += 1) {
        await enqueue(app, { kind: 'maintenance.prune', dedupeKey: `prune:batch:${i}`, traceId: TRACE });
      }
      const claimed = [];
      for (let i = 0; i < 5; i += 1) {
        claimed.push(await claimJob(app, 'crashed-worker'));
      }
      await app.query("UPDATE jobs SET locked_at = now() - interval '20 minutes'");

      expect(await reap(app)).toStrictEqual({ requeued: 5, dead: 0 });

      const { rows } = await app.query<{ running: string; queued: string }>(
        `SELECT count(*) FILTER (WHERE status = 'running') AS running,
                count(*) FILTER (WHERE status = 'queued') AS queued
         FROM jobs`,
      );
      expect(rows[0]?.running).toBe('0');
      expect(rows[0]?.queued).toBe('5');
      expect(claimed).toHaveLength(5);
    });
  });
});
