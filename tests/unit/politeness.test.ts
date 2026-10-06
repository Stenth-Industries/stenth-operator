import { describe, expect, it } from 'vitest';

import { HostPoliteness } from '../../src/fetch/politeness';

/** SPEC.md §6: a token bucket keyed by host, minimum two seconds, Crawl-delay honoured. */
function controllable() {
  let clock = 0;
  const slept: number[] = [];
  const politeness = new HostPoliteness({
    minIntervalMs: 2_000,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  return { politeness, slept, advance: (ms: number) => { clock += ms; }, clockNow: () => clock };
}

describe('fetch politeness (SPEC.md §6)', () => {
  it('does not wait for the first request to a host', async () => {
    const { politeness, slept } = controllable();
    await politeness.waitForTurn('example.com.au');
    expect(slept).toStrictEqual([]);
  });

  it('waits out the remainder of the two-second minimum', async () => {
    const { politeness, slept, advance } = controllable();
    await politeness.waitForTurn('example.com.au');
    advance(500);
    await politeness.waitForTurn('example.com.au');
    expect(slept).toStrictEqual([1_500]);
  });

  it('does not wait when enough time has already passed', async () => {
    const { politeness, slept, advance } = controllable();
    await politeness.waitForTurn('example.com.au');
    advance(5_000);
    await politeness.waitForTurn('example.com.au');
    expect(slept).toStrictEqual([]);
  });

  it('keeps hosts independent', async () => {
    const { politeness, slept } = controllable();
    await politeness.waitForTurn('a.example');
    await politeness.waitForTurn('b.example');
    expect(slept).toStrictEqual([]);
  });

  it('honours a Crawl-delay longer than the minimum', async () => {
    const { politeness, slept } = controllable();
    await politeness.waitForTurn('slow.example', 10);
    await politeness.waitForTurn('slow.example', 10);
    expect(slept).toStrictEqual([10_000]);
  });

  it('never goes below the two-second floor, whatever Crawl-delay says', async () => {
    const { politeness, slept } = controllable();
    await politeness.waitForTurn('fast.example', 0);
    await politeness.waitForTurn('fast.example', 0);
    expect(slept).toStrictEqual([2_000]);
  });

  it('serialises concurrent requests to one host instead of letting them all go', async () => {
    // Four handlers run at once (§6). Without serialising, all four would read
    // the same stale timestamp and hit the site together.
    const { politeness, slept } = controllable();
    await Promise.all([
      politeness.waitForTurn('busy.example'),
      politeness.waitForTurn('busy.example'),
      politeness.waitForTurn('busy.example'),
      politeness.waitForTurn('busy.example'),
    ]);
    expect(slept).toStrictEqual([2_000, 2_000, 2_000]);
  });
});
