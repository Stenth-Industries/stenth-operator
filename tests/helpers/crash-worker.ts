/**
 * A worker that claims one job and then dies without finishing it.
 *
 * Run as a real child process and killed with SIGKILL by the parent, so the
 * crash is genuine: no completion, no catch block, no pool teardown, no chance
 * to tidy up. That is the state the reaper exists to clean up, and the only
 * honest way to test it.
 */
import { writeSync } from 'node:fs';

import { createPool } from '../../src/db/client';
import { claimJob } from '../../src/jobs/queue';

async function main(): Promise<void> {
  const url = process.env.CRASH_DATABASE_URL;
  if (url === undefined) {
    throw new Error('CRASH_DATABASE_URL is required');
  }

  const pool = createPool(url);
  const job = await claimJob(pool, process.env.CRASH_WORKER_ID ?? 'crash-child');

  // Synchronous write: the parent reads this and then kills us, so it must not
  // sit in a buffer.
  writeSync(
    1,
    `${JSON.stringify({ claimed: job?.id ?? null, attempts: job?.attempts ?? null })}\n`,
  );

  // Hold the claim open and wait to be killed.
  setInterval(() => undefined, 1_000);
}

void main();
