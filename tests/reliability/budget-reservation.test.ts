/**
 * The atomic budget reservation (SPEC.md §16, Day 4 review item 1).
 *
 * The thing under test is not "does the arithmetic add up" — it is "can two
 * workers both pass the same check", and "what happens if the process dies
 * holding a charge". Both are properties of PostgreSQL under concurrency, so
 * every case here runs against a real database with real concurrent
 * transactions. A mock would agree with whatever the code believes.
 *
 * The four states and what they mean for the month:
 *
 *   reserved   in flight or ambiguous; cost_usd holds the pessimistic estimate
 *              and counts against the ceiling.
 *   succeeded  finalised with real usage; counts.
 *   failed     the call happened and did not validate; counts, because we were
 *              billed for it.
 *   blocked    a control refused before any reservation; zero cost, no key.
 *   abandoned  a human verified no charge; zero cost, key released.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  abandonReservation,
  budgetWindow,
  confirmReservation,
  finalizeCall,
  openReservations,
  recordRefusal,
  reserveCall,
} from '../../src/ai/budget';
import { costUsd, estimateTokens } from '../../src/ai/pricing';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the reservation suite.');
}

const PROVIDER = 'testprov';
const MODEL = 'testmodel-1';
const TRACE = '01JA2BCDEFGHJKMNPQRSTVWXYZ';

describeWithDb('reserve before you call (§16)', () => {
  let db: TestDatabase;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
    await db.adminPool.query(
      `INSERT INTO model_pricing (provider, model, input_per_mtok, output_per_mtok, effective_from)
       VALUES ($1, $2, 3.000000, 15.000000, now() - interval '1 day')`,
      [PROVIDER, MODEL],
    );
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.adminPool.query('TRUNCATE llm_calls, events, budgets CASCADE');
  });

  function request(overrides: Record<string, unknown> = {}) {
    return {
      reservationKey: `web.extract:${Math.random().toString(36).slice(2)}`,
      traceId: TRACE,
      jobId: null,
      purpose: 'web.extract',
      isolation: 'isolated_untrusted' as const,
      provider: PROVIDER,
      model: MODEL,
      estimatedInputTokens: 10_000,
      maxOutputTokens: 4_000,
      requestHash: 'a'.repeat(64),
      ...overrides,
    };
  }

  async function monthToDate(): Promise<number> {
    const { rows } = await app.query<{ total: string }>(
      `SELECT coalesce(sum(cost_usd), 0)::text AS total FROM llm_calls
        WHERE created_at >= date_trunc('month', now())`,
    );
    return Number(rows[0]?.total);
  }

  async function setCeiling(hardStop: number): Promise<void> {
    await budgetWindow(app);
    await db.adminPool.query('UPDATE budgets SET limit_usd = $1, warn_usd = $1, hard_stop_usd = $1', [
      hardStop,
    ]);
  }

  // ------------------------------------------------------------ the basics
  describe('a reservation is taken before anything is called', () => {
    it('inserts a reserved row whose cost is the pessimistic estimate', async () => {
      const result = await reserveCall(app, request());
      expect(result.kind).toBe('reserved');

      const { rows } = await app.query<{
        status: string;
        cost_usd: string;
        estimated_cost_usd: string;
        reserved_at: Date | null;
        finalized_at: Date | null;
        input_tokens: number;
      }>('SELECT status, cost_usd, estimated_cost_usd, reserved_at, finalized_at, input_tokens FROM llm_calls');

      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('reserved');
      // 10,000 input at $3/Mtok + 4,000 output at $15/Mtok = $0.09.
      expect(Number(rows[0]?.cost_usd)).toBeCloseTo(0.09, 6);
      expect(Number(rows[0]?.estimated_cost_usd)).toBeCloseTo(0.09, 6);
      expect(rows[0]?.reserved_at).not.toBeNull();
      expect(rows[0]?.finalized_at).toBeNull();
      // No usage yet: nothing has been called.
      expect(rows[0]?.input_tokens).toBe(0);
    });

    it('counts the reservation against the month immediately', async () => {
      await reserveCall(app, request());
      expect(await monthToDate()).toBeCloseTo(0.09, 6);
      const window = await budgetWindow(app);
      expect(window.monthToDateUsd).toBeCloseTo(0.09, 6);
    });

    it('replaces the estimate with the real cost at finalisation', async () => {
      const reserved = await reserveCall(app, request());
      if (reserved.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }

      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await finalizeCall(client, {
          callId: reserved.callId,
          usage: { inputTokens: 2_000, outputTokens: 500, cachedTokens: 0 },
          latencyMs: 1_234,
          status: 'succeeded',
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const { rows } = await app.query<{
        status: string;
        cost_usd: string;
        estimated_cost_usd: string;
        latency_ms: number;
        finalized_at: Date | null;
      }>('SELECT status, cost_usd, estimated_cost_usd, latency_ms, finalized_at FROM llm_calls');
      expect(rows[0]?.status).toBe('succeeded');
      // 2,000 at $3 + 500 at $15 = $0.0135.
      expect(Number(rows[0]?.cost_usd)).toBeCloseTo(0.0135, 6);
      // The estimate is kept, so over-reservation is measurable.
      expect(Number(rows[0]?.estimated_cost_usd)).toBeCloseTo(0.09, 6);
      expect(rows[0]?.latency_ms).toBe(1_234);
      expect(rows[0]?.finalized_at).not.toBeNull();
    });

    it('refuses to finalise the same reservation twice', async () => {
      const reserved = await reserveCall(app, request());
      if (reserved.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }
      const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0 };

      for (const expectation of [true, false]) {
        const client = await app.connect();
        try {
          await client.query('BEGIN');
          const attempt = finalizeCall(client, {
            callId: reserved.callId,
            usage,
            latencyMs: 1,
            status: 'succeeded',
          });
          if (expectation) {
            await attempt;
            await client.query('COMMIT');
          } else {
            await expect(attempt).rejects.toThrow(/not in the reserved state/);
            await client.query('ROLLBACK');
          }
        } finally {
          client.release();
        }
      }
    });
  });

  // ------------------------------------------------- race A: same identity
  describe('RACE A: two workers on the same work', () => {
    it('lets exactly one reserve it, concurrently', async () => {
      const key = 'web.extract:same-identity';
      const results = await Promise.all(
        Array.from({ length: 8 }, () => reserveCall(app, request({ reservationKey: key }))),
      );

      const reserved = results.filter((result) => result.kind === 'reserved');
      const refused = results.filter((result) => result.kind === 'refused');
      expect(reserved).toHaveLength(1);
      expect(refused).toHaveLength(7);
      for (const result of refused) {
        expect(result.kind === 'refused' && result.reason).toBe('reservation_in_flight');
      }

      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM llm_calls',
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('still refuses after the first call has been finalised', async () => {
      const key = 'web.extract:already-done';
      const first = await reserveCall(app, request({ reservationKey: key }));
      if (first.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await finalizeCall(client, {
          callId: first.callId,
          usage: { inputTokens: 10, outputTokens: 10, cachedTokens: 0 },
          latencyMs: 5,
          status: 'succeeded',
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const second = await reserveCall(app, request({ reservationKey: key }));
      expect(second.kind).toBe('refused');
      expect(second.kind === 'refused' && second.reason).toBe('reservation_in_flight');
      expect(second.kind === 'refused' && second.existingStatus).toBe('succeeded');
    });

    it('names the existing call, so a human can find it', async () => {
      const key = 'web.extract:findable';
      const first = await reserveCall(app, request({ reservationKey: key }));
      const second = await reserveCall(app, request({ reservationKey: key }));
      expect(second.kind === 'refused' && second.existingCallId).toBe(
        first.kind === 'reserved' ? first.callId : undefined,
      );
    });
  });

  // ------------------------------------------- race B: the monthly ceiling
  describe('RACE B: many different calls racing at the ceiling', () => {
    it('cannot collectively reserve past the hard stop', async () => {
      // Room for exactly three calls at $0.09, with $0.02 left over.
      await setCeiling(0.29);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          reserveCall(app, request({ reservationKey: `web.extract:race-b-${index}` })),
        ),
      );

      const reserved = results.filter((result) => result.kind === 'reserved');
      const refused = results.filter(
        (result) => result.kind === 'refused' && result.reason === 'budget_hard_stop',
      );

      expect(reserved).toHaveLength(3);
      expect(refused).toHaveLength(5);

      const total = await monthToDate();
      expect(total).toBeCloseTo(0.27, 6);
      expect(total).toBeLessThanOrEqual(0.29);
    });

    it('holds the line exactly at the ceiling, not one call past it', async () => {
      // Room for exactly two.
      await setCeiling(0.18);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_unused, index) =>
          reserveCall(app, request({ reservationKey: `web.extract:exact-${index}` })),
        ),
      );
      expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(2);
      expect(await monthToDate()).toBeCloseTo(0.18, 6);
    });

    it('counts a finalised call at its real cost, freeing the difference', async () => {
      await setCeiling(0.29);
      const first = await reserveCall(app, request({ reservationKey: 'web.extract:cheap' }));
      if (first.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }

      // The call turned out to be cheap: the over-reservation comes back.
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await finalizeCall(client, {
          callId: first.callId,
          usage: { inputTokens: 1_000, outputTokens: 100, cachedTokens: 0 },
          latencyMs: 10,
          status: 'succeeded',
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await monthToDate()).toBeCloseTo(0.0045, 6);

      // Which means three more now fit where two would have.
      const more = await Promise.all(
        Array.from({ length: 3 }, (_unused, index) =>
          reserveCall(app, request({ reservationKey: `web.extract:after-${index}` })),
        ),
      );
      expect(more.filter((result) => result.kind === 'reserved')).toHaveLength(3);
    });

    it('refuses everything once the ceiling is already met', async () => {
      await setCeiling(0.05);
      const result = await reserveCall(app, request());
      expect(result.kind === 'refused' && result.reason).toBe('budget_hard_stop');
      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM llm_calls',
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('fails closed when the model has no price', async () => {
      const result = await reserveCall(app, request({ model: 'unpriced-model' }));
      expect(result.kind === 'refused' && result.reason).toBe('missing_pricing');
    });
  });

  // ----------------------------------------------------------- crash cases
  describe('CRASH after reservation, before the provider call', () => {
    it('leaves the reservation standing and the budget consumed', async () => {
      const key = 'web.extract:crashed-before';
      const reserved = await reserveCall(app, request({ reservationKey: key }));
      expect(reserved.kind).toBe('reserved');

      // The process dies here. Nothing else runs. The next worker:
      const retry = await reserveCall(app, request({ reservationKey: key }));
      expect(retry.kind === 'refused' && retry.reason).toBe('reservation_in_flight');

      // The budget is still committed to it — fail closed, not fail open.
      expect(await monthToDate()).toBeCloseTo(0.09, 6);

      const open = await openReservations(app);
      expect(open).toHaveLength(1);
      expect(open[0]?.reservationKey).toBe(key);
      expect(open[0]?.estimatedUsd).toBeCloseTo(0.09, 6);
    });
  });

  describe('CRASH after the provider answered, before finalisation', () => {
    it('does not bill again: the identity is taken and no retry can call', async () => {
      const key = 'web.extract:crashed-after';
      const reserved = await reserveCall(app, request({ reservationKey: key }));
      if (reserved.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }
      // The provider has answered and been paid. The commit never happens.

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const retry = await reserveCall(app, request({ reservationKey: key }));
        expect(retry.kind === 'refused' && retry.reason).toBe('reservation_in_flight');
      }

      // Exactly one row, still reserved, still counting.
      const { rows } = await app.query<{ count: string; status: string }>(
        'SELECT count(*)::text AS count, max(status::text) AS status FROM llm_calls',
      );
      expect(rows[0]?.count).toBe('1');
      expect(rows[0]?.status).toBe('reserved');
      expect(await monthToDate()).toBeCloseTo(0.09, 6);
    });
  });

  // -------------------------------------------------------- reconciliation
  describe('reconciliation is explicit and human-driven', () => {
    it('lists open reservations with what a human needs to look them up', async () => {
      await reserveCall(app, request({ reservationKey: 'web.extract:stale' }));
      const open = await openReservations(app);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        provider: PROVIDER,
        model: MODEL,
        purpose: 'web.extract',
        traceId: TRACE,
      });
      expect(open[0]?.ageMinutes).toBeGreaterThanOrEqual(0);
    });

    it('filters by age, so a call in flight is not mistaken for a stuck one', async () => {
      await reserveCall(app, request());
      expect(await openReservations(app, 0)).toHaveLength(1);
      expect(await openReservations(app, 30)).toHaveLength(0);
    });

    it('abandoning releases the budget and the identity, and records who decided', async () => {
      const key = 'web.extract:to-abandon';
      const reserved = await reserveCall(app, request({ reservationKey: key }));
      if (reserved.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }

      const released = await abandonReservation(
        app,
        reserved.callId,
        'kushagra',
        'checked the provider dashboard: no request recorded',
      );
      expect(released).toBe(true);
      expect(await monthToDate()).toBe(0);

      const { rows } = await app.query<{
        status: string;
        reservation_key: string | null;
        reconciled_by: string;
        estimated_cost_usd: string;
      }>('SELECT status, reservation_key, reconciled_by, estimated_cost_usd FROM llm_calls');
      expect(rows[0]?.status).toBe('abandoned');
      expect(rows[0]?.reservation_key).toBeNull();
      expect(rows[0]?.reconciled_by).toBe('kushagra');
      // The reservation still happened, and the row still says how much it held.
      expect(Number(rows[0]?.estimated_cost_usd)).toBeCloseTo(0.09, 6);

      // And the work can now be reserved again.
      const again = await reserveCall(app, request({ reservationKey: key }));
      expect(again.kind).toBe('reserved');
    });

    it('confirming keeps the money and keeps the identity taken', async () => {
      const key = 'web.extract:to-confirm';
      const reserved = await reserveCall(app, request({ reservationKey: key }));
      if (reserved.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }

      const confirmed = await confirmReservation(
        app,
        reserved.callId,
        0.0412,
        'kushagra',
        'the provider billed this request; usage taken from the dashboard',
      );
      expect(confirmed).toBe(true);
      expect(await monthToDate()).toBeCloseTo(0.0412, 6);

      // Not retried against a provider that already answered.
      const again = await reserveCall(app, request({ reservationKey: key }));
      expect(again.kind === 'refused' && again.reason).toBe('reservation_in_flight');
    });

    it('refuses to reconcile a call that is not reserved', async () => {
      const reserved = await reserveCall(app, request());
      if (reserved.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }
      expect(await abandonReservation(app, reserved.callId, 'a', 'b')).toBe(true);
      // Second time: nothing to do, and it must not resurrect the row.
      expect(await abandonReservation(app, reserved.callId, 'a', 'b')).toBe(false);
      expect(await confirmReservation(app, reserved.callId, 1, 'a', 'b')).toBe(false);
    });
  });

  // ------------------------------------------------------------ audit trail
  describe('every state is auditable', () => {
    it('keeps all five states distinguishable in one query', async () => {
      const a = await reserveCall(app, request({ reservationKey: 'k:a' }));
      const b = await reserveCall(app, request({ reservationKey: 'k:b' }));
      const c = await reserveCall(app, request({ reservationKey: 'k:c' }));
      await reserveCall(app, request({ reservationKey: 'k:d' }));
      await recordRefusal(app, {
        traceId: TRACE,
        jobId: null,
        purpose: 'web.extract',
        isolation: 'isolated_untrusted',
        provider: PROVIDER,
        model: MODEL,
        requestHash: 'b'.repeat(64),
        reason: 'budget_hard_stop',
      });

      for (const [reservation, status] of [
        [a, 'succeeded'],
        [b, 'failed'],
      ] as const) {
        if (reservation.kind !== 'reserved') {
          throw new Error('expected a reservation');
        }
        const client = await app.connect();
        try {
          await client.query('BEGIN');
          await finalizeCall(client, {
            callId: reservation.callId,
            usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
            latencyMs: 1,
            status,
          });
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      }
      if (c.kind !== 'reserved') {
        throw new Error('expected a reservation');
      }
      await abandonReservation(app, c.callId, 'kushagra', 'no charge');

      const { rows } = await app.query<{ status: string; count: string }>(
        'SELECT status::text AS status, count(*)::text AS count FROM llm_calls GROUP BY status ORDER BY status',
      );
      expect(rows).toStrictEqual([
        { status: 'abandoned', count: '1' },
        { status: 'blocked', count: '1' },
        { status: 'failed', count: '1' },
        { status: 'reserved', count: '1' },
        { status: 'succeeded', count: '1' },
      ]);
    });

    it('a blocked refusal costs nothing and blocks no future attempt', async () => {
      await recordRefusal(app, {
        traceId: TRACE,
        jobId: null,
        purpose: 'web.extract',
        isolation: 'isolated_untrusted',
        provider: PROVIDER,
        model: MODEL,
        requestHash: 'c'.repeat(64),
        reason: 'missing_pricing',
      });
      expect(await monthToDate()).toBe(0);
      const { rows } = await app.query<{ reservation_key: string | null; note: string }>(
        'SELECT reservation_key, reconciliation_note AS note FROM llm_calls',
      );
      expect(rows[0]?.reservation_key).toBeNull();
      expect(rows[0]?.note).toBe('missing_pricing');
    });

    it('raises the §16 warning once, and lets calls continue', async () => {
      await budgetWindow(app);
      await db.adminPool.query('UPDATE budgets SET warn_usd = 0.05, hard_stop_usd = 100');

      for (let index = 0; index < 4; index += 1) {
        const result = await reserveCall(app, request({ reservationKey: `warn-${index}` }));
        expect(result.kind).toBe('reserved');
      }

      const { rows } = await app.query<{ count: string }>(
        `SELECT count(*) AS count FROM events WHERE kind = 'budget.warning'`,
      );
      expect(rows[0]?.count).toBe('1');
    });
  });

  describe('the estimate is pessimistic on purpose', () => {
    it('charges cached tokens at the input rate', () => {
      const price = { inputPerMtok: 3, outputPerMtok: 15, effectiveFrom: new Date() };
      expect(
        costUsd({ inputTokens: 500_000, outputTokens: 0, cachedTokens: 500_000 }, price),
      ).toBe(3);
    });

    it('rounds token estimates up', () => {
      expect(estimateTokens('abc')).toBe(1);
      expect(estimateTokens('a'.repeat(4_001))).toBe(1_001);
    });
  });
});
