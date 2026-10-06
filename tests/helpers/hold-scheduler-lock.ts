/**
 * Takes the scheduler's advisory lock in its own session and holds it until
 * killed, so the parent can prove a second scheduler stands down.
 */
import { writeSync } from 'node:fs';

import { createPool } from '../../src/db/client';
import { SCHEDULER_LOCK_KEY } from '../../src/worker/scheduler';

async function main(): Promise<void> {
  const url = process.env.SCHED_DATABASE_URL_OVERRIDE;
  if (url === undefined) {
    throw new Error('SCHED_DATABASE_URL_OVERRIDE is required');
  }

  const pool = createPool(url);
  const client = await pool.connect();
  const held = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [SCHEDULER_LOCK_KEY.toString()],
  );

  writeSync(1, `${JSON.stringify({ held: held.rows[0]?.acquired === true })}\n`);
  setInterval(() => undefined, 1_000);
}

void main();
