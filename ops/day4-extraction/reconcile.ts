/**
 * Reconciling an open reservation (SPEC.md §16, review item 1).
 *
 * A reservation is left standing whenever a call's outcome is unknown: the
 * process died between reserving and finalising, or the provider failed after
 * being invoked. Its pessimistic cost keeps counting against the month and its
 * identity stays taken, so the system fails closed — and nothing in this
 * process can tell whether the money was actually spent. Only the provider's
 * own billing can, which is why this step is a human's.
 *
 *   list                        read-only; every open reservation
 *   resolve --id=<uuid> --as=abandoned --yes
 *                               you checked the billing: no charge. The budget
 *                               is given back and the work can be re-enqueued.
 *   resolve --id=<uuid> --as=charged --cost-usd=<n> --yes
 *                               you checked the billing: it was charged. The
 *                               month keeps the cost and the work is not
 *                               retried against a provider that already
 *                               answered.
 *
 * Both writes require --yes and --by=<name>, because the row records who
 * decided: §16's ledger is only worth having if a correction is attributable.
 */
import type { Pool } from 'pg';

import {
  abandonReservation,
  budgetWindow,
  confirmReservation,
  openReservations,
} from '../../src/ai/budget';
import { createPool } from '../../src/db/client';

interface Options {
  readonly mode: 'list' | 'resolve';
  readonly id?: string;
  readonly as?: 'abandoned' | 'charged';
  readonly costUsd?: number;
  readonly by: string;
  readonly note: string;
  readonly olderThanMinutes: number;
  readonly confirmed: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  const flag = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

  const mode = positional[0] ?? 'list';
  if (mode !== 'list' && mode !== 'resolve') {
    throw new Error(`unknown mode "${mode}": expected list or resolve`);
  }

  const as = flag('as');
  if (as !== undefined && as !== 'abandoned' && as !== 'charged') {
    throw new Error('--as must be abandoned or charged');
  }

  const cost = flag('cost-usd');
  const olderThan = Number(flag('older-than-minutes') ?? '0');
  if (!Number.isInteger(olderThan) || olderThan < 0) {
    throw new Error('--older-than-minutes must be a non-negative integer');
  }

  return {
    mode,
    ...(flag('id') === undefined ? {} : { id: flag('id') as string }),
    ...(as === undefined ? {} : { as }),
    ...(cost === undefined ? {} : { costUsd: Number(cost) }),
    by: flag('by') ?? '',
    note: flag('note') ?? '',
    olderThanMinutes: olderThan,
    confirmed: argv.includes('--yes'),
  };
}

async function list(pool: Pool, options: Options): Promise<void> {
  const window = await budgetWindow(pool);
  const open = await openReservations(pool, options.olderThanMinutes);

  console.log('');
  console.log(
    `Month ${window.periodMonth}: committed + reserved $${window.monthToDateUsd.toFixed(6)} ` +
      `of a $${window.hardStopUsd.toFixed(2)} hard stop`,
  );
  console.log('');

  if (open.length === 0) {
    console.log('No open reservations. Nothing to reconcile.');
    return;
  }

  const held = open.reduce((sum, row) => sum + row.estimatedUsd, 0);
  console.log(
    `${open.length} open reservation(s) holding $${held.toFixed(6)} of that figure:`,
  );
  console.log('');
  for (const row of open) {
    console.log(`  id            ${row.id}`);
    console.log(`  provider      ${row.provider} / ${row.model}`);
    console.log(`  purpose       ${row.purpose}`);
    console.log(`  reserved      ${row.reservedAt.toISOString()} (${row.ageMinutes} min ago)`);
    console.log(`  holding       $${row.estimatedUsd.toFixed(6)}`);
    console.log(`  trace id      ${row.traceId}`);
    console.log(`  job id        ${row.jobId ?? '(none)'}`);
    console.log(`  work          ${row.reservationKey ?? '(released)'}`);
    console.log('');
  }
  console.log(
    'Check the provider\'s billing for a request at that timestamp, then resolve each one.',
  );
}

async function resolve(pool: Pool, options: Options): Promise<void> {
  if (options.id === undefined) {
    throw new Error('--id=<uuid> is required');
  }
  if (options.as === undefined) {
    throw new Error('--as=abandoned or --as=charged is required');
  }
  if (options.by === '') {
    throw new Error('--by=<name> is required: the row records who decided');
  }
  if (options.note === '') {
    throw new Error(
      '--note="what the provider\'s billing showed" is required: a correction ' +
        'with no reason is not auditable',
    );
  }
  if (!options.confirmed) {
    throw new Error('this writes to the ledger; pass --yes to confirm');
  }

  if (options.as === 'abandoned') {
    const done = await abandonReservation(pool, options.id, options.by, options.note);
    console.log(
      done
        ? `Released. The budget is given back and this work can be enqueued again.`
        : `Nothing to do: ${options.id} is not an open reservation.`,
    );
    return;
  }

  if (options.costUsd === undefined || !Number.isFinite(options.costUsd) || options.costUsd < 0) {
    throw new Error('--cost-usd=<n> is required when resolving as charged');
  }
  const done = await confirmReservation(
    pool,
    options.id,
    options.costUsd,
    options.by,
    options.note,
  );
  console.log(
    done
      ? `Recorded at $${options.costUsd.toFixed(6)}. The month keeps the cost and the ` +
          'work will not be retried against the provider.'
      : `Nothing to do: ${options.id} is not an open reservation.`,
  );
}

function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required. Run this inside the stack.');
  }

  const pool = createPool(databaseUrl);
  return (options.mode === 'list' ? list(pool, options) : resolve(pool, options)).finally(
    () => pool.end(),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
