/**
 * One scheduler tick, in its own process.
 *
 * The advisory lock is session-scoped, so proving mutual exclusion across
 * processes needs actual processes rather than two pools in one.
 */
import { writeSync } from 'node:fs';

import { createPool } from '../../src/db/client';
import { tick } from '../../src/worker/scheduler';

async function main(): Promise<void> {
  const url = process.env.SCHED_DATABASE_URL_OVERRIDE;
  if (url === undefined) {
    throw new Error('SCHED_DATABASE_URL_OVERRIDE is required');
  }

  const pool = createPool(url);
  const now = process.env.TICK_NOW === undefined ? new Date() : new Date(process.env.TICK_NOW);

  try {
    const result = await tick(pool, process.env.TICK_WORKER_ID ?? 'child', now);
    writeSync(1, `${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    writeSync(2, `${String(error)}\n`);
    process.exit(1);
  },
);
