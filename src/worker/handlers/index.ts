/**
 * The handler registry.
 *
 * Day 2 builds the engine and registers nothing: every business handler belongs
 * to the day that builds it — web.fetch to Day 3, web.extract to Day 4,
 * company.assess to Day 6, and so on (§25). An empty registry is the honest
 * state, not an oversight.
 *
 * A claimed job whose kind has no handler fails through the ordinary path:
 * retried with backoff, then dead with an alert. It is never silently dropped,
 * and it never blocks the loop. Production has no schedules enabled and nothing
 * enqueuing, so the queue stays empty until Day 3 puts work in it.
 */
import type { ClaimedJob } from '../../jobs/queue';
import type { JobKind } from '../../jobs/kinds';

export interface HandlerContext {
  readonly traceId: string;
  /** Signals shutdown, so a long handler can stop early and be retried. */
  readonly signal: AbortSignal;
}

export type JobHandler = (job: ClaimedJob, context: HandlerContext) => Promise<void>;

const handlers = new Map<JobKind, JobHandler>();

export function registerHandler(kind: JobKind, handler: JobHandler): void {
  if (handlers.has(kind)) {
    throw new Error(`A handler is already registered for "${kind}"`);
  }
  handlers.set(kind, handler);
}

export function getHandler(kind: JobKind): JobHandler | undefined {
  return handlers.get(kind);
}

export function registeredKinds(): JobKind[] {
  return [...handlers.keys()];
}

/** Tests register handlers per case and need a clean registry between them. */
export function clearHandlers(): void {
  handlers.clear();
}
