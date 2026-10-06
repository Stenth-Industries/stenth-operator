/**
 * Fetch politeness (SPEC.md §6).
 *
 * "Fetch politeness is enforced inside the fetcher service — a token bucket
 * keyed by host, minimum two seconds between requests to the same host,
 * Crawl-delay honoured where present."
 *
 * In the service, not in the worker: the worker can run four handlers at once
 * and a second worker could exist, so a limiter anywhere else is advice. Here
 * it is the only path to the network.
 */
export interface PolitenessOptions {
  readonly minIntervalMs: number;
  /** Injected in tests so the suite does not have to wait two seconds. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class HostPoliteness {
  private readonly lastRequestAt = new Map<string, number>();
  private readonly chain = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PolitenessOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Resolves when it is this host's turn.
   *
   * Waits are serialised per host, so ten concurrent requests to one site queue
   * behind each other rather than all observing the same stale timestamp and
   * going at once.
   */
  async waitForTurn(host: string, crawlDelaySeconds?: number): Promise<void> {
    const required = Math.max(
      this.options.minIntervalMs,
      crawlDelaySeconds === undefined ? 0 : crawlDelaySeconds * 1_000,
    );

    const previous = this.chain.get(host) ?? Promise.resolve();
    const turn = previous.then(async () => {
      const last = this.lastRequestAt.get(host);
      if (last !== undefined) {
        const waitFor = required - (this.now() - last);
        if (waitFor > 0) {
          await this.sleep(waitFor);
        }
      }
      this.lastRequestAt.set(host, this.now());
    });

    this.chain.set(
      host,
      turn.catch(() => undefined),
    );
    await turn;
  }

  /** Test visibility only. */
  lastSeen(host: string): number | undefined {
    return this.lastRequestAt.get(host);
  }
}
