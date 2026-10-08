/**
 * The worker (SPEC.md §6, §19).
 *
 * One Node process. Four handlers in-process, one claim loop each, plus a
 * single timer that runs the scheduler and the reaper — neither is a queued
 * job.
 *
 * Two database roles, because §17's least privilege is only real if the
 * connections differ: the claim loop and the reaper use operator_app, and the
 * scheduler uses operator_sched, which can touch schedules, insert jobs and
 * write the heartbeat and nothing else.
 */
import { hostname } from 'node:os';

import type { Pool } from 'pg';

import { getConfig } from '../config';
import { createPool } from '../db/client';
import {
  blockJob,
  claimJob,
  completeJob,
  failJob,
  ControlRefusal,
  UnregisteredKindError,
} from '../jobs/queue';
import { getLogger, withTrace } from '../obs/log';
import { getHandler, registerHandler } from './handlers';
import { resolveProvider, type ModelProvider } from '../ai/provider';
import { registerAvailableProviders } from '../ai/providers';
import { handleCompanyResolve } from './handlers/company-resolve';
import { ExtractBlocked, handleWebExtract } from './handlers/web-extract';
import { handleWebFetch } from './handlers/web-fetch';
import { reap, DEFAULT_STALE_AFTER_SECONDS } from './reaper';
import { tick } from './scheduler';

/** §6: "the worker runs four handlers in-process". */
export const CONCURRENCY = 4;

/** How long a loop waits after finding nothing, so an empty queue is cheap. */
export const IDLE_POLL_MS = 1_000;

/** §6: "every ~60 seconds". */
export const TIMER_INTERVAL_MS = 60_000;

export interface WorkerOptions {
  readonly appPool: Pool;
  readonly schedPool: Pool;
  readonly workerId: string;
  readonly concurrency?: number;
  readonly idlePollMs?: number;
  readonly timerIntervalMs?: number;
  readonly staleAfterSeconds?: number;
}

export interface RunningWorker {
  /** Resolves once every loop has stopped and all in-flight work has finished. */
  stop(): Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Runs one claimed job to its terminal state for this attempt.
 *
 * Exported because the reliability suite drives it directly: it is where the
 * handler's outcome becomes a lifecycle transition, and that is the part worth
 * testing without a timer in the way.
 */
export async function runOnce(
  appPool: Pool,
  workerId: string,
  signal: AbortSignal,
): Promise<'ran' | 'idle'> {
  const job = await claimJob(appPool, workerId);
  if (job === undefined) {
    return 'idle';
  }

  const log = withTrace(job.trace_id);
  const handler = getHandler(job.kind);

  if (handler === undefined) {
    const outcome = await failJob(appPool, job, new UnregisteredKindError(job.kind));
    log.error(
      { job_id: job.id, job_kind: job.kind, attempt: job.attempts, outcome: outcome.status },
      outcome.status === 'dead'
        ? 'ALERT: job dead, no handler is registered for its kind'
        : 'job failed, no handler is registered for its kind',
    );
    return 'ran';
  }

  const startedAt = Date.now();
  try {
    await handler(job, { traceId: job.trace_id, signal });
    await completeJob(appPool, job);
    log.info(
      {
        job_id: job.id,
        job_kind: job.kind,
        attempt: job.attempts,
        duration_ms: Date.now() - startedAt,
      },
      'job succeeded',
    );
  } catch (error) {
    if (error instanceof ControlRefusal) {
      // §6: blocked is terminal and raises an alert. No attempt is consumed
      // retrying something a control has already decided.
      await blockJob(appPool, job, error.reason, error.message);
      log.error(
        {
          job_id: job.id,
          job_kind: job.kind,
          attempt: job.attempts,
          reason: error.reason,
          duration_ms: Date.now() - startedAt,
          err: error,
        },
        'ALERT: job blocked by a control; it will not retry',
      );
      return 'ran';
    }

    const outcome = await failJob(appPool, job, error);
    const line = {
      job_id: job.id,
      job_kind: job.kind,
      attempt: job.attempts,
      max_attempts: job.max_attempts,
      duration_ms: Date.now() - startedAt,
      err: error,
    };
    if (outcome.status === 'dead') {
      // dead is terminal and raises an alert; nothing retries it silently (§6).
      log.error(line, 'ALERT: job dead, attempts exhausted');
    } else {
      log.warn({ ...line, retry_after: outcome.nextRunAfter }, 'job failed, will retry');
    }
  }

  return 'ran';
}

export function startWorker(options: WorkerOptions): RunningWorker {
  const log = getLogger();
  const controller = new AbortController();
  const { signal } = controller;

  const concurrency = options.concurrency ?? CONCURRENCY;
  const idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
  const timerIntervalMs = options.timerIntervalMs ?? TIMER_INTERVAL_MS;
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;

  async function loop(slot: number): Promise<void> {
    while (!signal.aborted) {
      try {
        const outcome = await runOnce(options.appPool, options.workerId, signal);
        if (outcome === 'idle') {
          await sleep(idlePollMs, signal);
        }
      } catch (error) {
        // A failure here is the queue itself misbehaving, not a handler: the
        // claim or the transition could not be written. Back off and retry
        // rather than exiting, so a brief database blip is survivable.
        log.error({ err: error, slot }, 'claim loop error, backing off');
        await sleep(idlePollMs, signal);
      }
    }
  }

  async function timer(): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await tick(options.schedPool, options.workerId);
        if (result.acquiredLock && (result.enqueued > 0 || result.failed > 0)) {
          log.info(
            { due: result.due, enqueued: result.enqueued, duplicates: result.duplicates },
            'scheduler tick enqueued work',
          );
        }
      } catch (error) {
        log.error({ err: error }, 'scheduler tick failed');
      }

      try {
        await reap(options.appPool, staleAfterSeconds);
      } catch (error) {
        log.error({ err: error }, 'reaper failed');
      }

      await sleep(timerIntervalMs, signal);
    }
  }

  const loops = Array.from({ length: concurrency }, (_unused, slot) => loop(slot));
  const timers = [timer()];

  log.info(
    { worker_id: options.workerId, concurrency },
    'worker started',
  );

  return {
    async stop() {
      controller.abort();
      await Promise.allSettled([...loops, ...timers]);
      log.info({ worker_id: options.workerId }, 'worker stopped');
    },
  };
}

async function main(): Promise<void> {
  const config = getConfig();
  const log = getLogger();

  if (config.SCHED_DATABASE_URL === undefined) {
    throw new Error(
      'SCHED_DATABASE_URL is required by the worker: the scheduler connects as ' +
        'operator_sched so that §17 least privilege is enforced by the ' +
        'connection and not by convention.',
    );
  }

  if (config.FETCHER_URL === undefined || config.FETCHER_SHARED_SECRET === undefined) {
    throw new Error(
      'FETCHER_URL and FETCHER_SHARED_SECRET are required by the worker: web.fetch ' +
        'is served by the fetcher over the internal network, and the fetcher ' +
        'rejects an unauthenticated request (SPEC.md §8).',
    );
  }

  // Day 3 registers web.fetch. The worker never fetches anything itself: it
  // asks the fetcher, which is the only process that touches hostile input.
  const fetcherUrl = config.FETCHER_URL;
  const sharedSecret = config.FETCHER_SHARED_SECRET;
  const appPool = createPool(config.DATABASE_URL);
  registerHandler('web.fetch', async (job) => {
    await handleWebFetch(job, { fetcherUrl, sharedSecret, pool: appPool });
  });

  // Day 5 registers company.resolve: §10 stages 1-3, code only. It calls no
  // provider, reserves no budget and reads no page — it normalises the domain,
  // applies the two hard filters a domain can answer, and fans out at most six
  // web.fetch jobs, one per page (§6, §7, §10 stage 3).
  registerHandler('company.resolve', async (job) => {
    await handleCompanyResolve(job, { pool: appPool });
  });

  // Day 4 registers web.extract. The provider is resolved once, at boot, and
  // resolveProvider throws when MODEL_PROVIDER is unset — §1 freezes the choice
  // of runtime provider to the Day 6 evaluation, so a deployment that has not
  // made that decision must not quietly inherit one. The handler is registered
  // only when a provider exists; without one, a web.extract job fails through
  // the ordinary unregistered-kind path, visibly.
  registerAvailableProviders();

  // Registered unconditionally, and the provider resolved per job.
  //
  // Not "register only if a provider exists": a web.extract job on a
  // deployment with no MODEL_PROVIDER would then fail as an unregistered kind,
  // which tells an operator nothing about why. Resolving here turns it into a
  // blocked job carrying `provider_unconfigured`, which names the decision that
  // has not been made (§1, §22).
  registerHandler('web.extract', async (job) => {
    let provider: ModelProvider;
    try {
      provider = resolveProvider(config.MODEL_PROVIDER);
    } catch (error) {
      throw new ExtractBlocked(
        'provider_unconfigured',
        error instanceof Error ? error.message : 'no model provider is configured',
      );
    }
    await handleWebExtract(job, {
      pool: appPool,
      provider,
      modelCallsEnabled: config.MODEL_CALLS_ENABLED,
    });
  });

  try {
    const resolved = resolveProvider(config.MODEL_PROVIDER);
    log.info(
      { provider: resolved.id, model: resolved.model, billable: resolved.billable },
      'web.extract registered',
    );
  } catch (error) {
    log.warn(
      { err: error },
      'web.extract is registered but no model provider is configured: its jobs ' +
        'will be blocked with provider_unconfigured until the Day 6 decision is set',
    );
  }
  const schedPool = createPool(config.SCHED_DATABASE_URL);
  const workerId = `${hostname()}:${process.pid}`;

  const worker = startWorker({ appPool, schedPool, workerId });

  let shuttingDown = false;
  const shutdown = (signalName: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal: signalName }, 'shutting down: finishing in-flight jobs');
    void worker
      .stop()
      .then(() => Promise.allSettled([appPool.end(), schedPool.end()]))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    getLogger().error({ err: error }, 'worker failed to start');
    process.exit(1);
  });
}
