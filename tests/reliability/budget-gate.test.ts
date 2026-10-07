/**
 * The budget gate (SPEC.md §16).
 *
 * "The budget check runs before the call, not after it... A budget that is only
 * discovered after the money is gone is a report, not a control."
 *
 * Against a real PostgreSQL, because the arithmetic is a SQL sum over llm_calls
 * and the warn-once rule is an existence check against events. Both are the
 * kind of thing a mock would agree with and the database would not.
 */
import type { Pool } from 'pg';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

import { budgetWindow, checkBudget, recordCall } from '../../src/ai/budget';
import { costUsd, estimateTokens, priceFor } from '../../src/ai/pricing';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the budget gate suite.');
}

const PROVIDER = 'testprov';
const MODEL = 'testmodel-1';

describeWithDb('the budget gate runs before the call (§16)', () => {
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
    // TRUNCATE, not DELETE: events is append-only and its trigger refuses a
    // DELETE (§4). TRUNCATE is a different statement and the owner's to run.
    await db.adminPool.query('TRUNCATE llm_calls, events, budgets CASCADE');
  });

  function request(overrides: Partial<Parameters<typeof checkBudget>[1]> = {}) {
    return {
      provider: PROVIDER,
      model: MODEL,
      estimatedInputTokens: 10_000,
      maxOutputTokens: 4_000,
      traceId: '01JA2BCDEFGHJKMNPQRSTVWXYZ',
      ...overrides,
    };
  }

  describe('the window', () => {
    it('creates this month\'s row from the frozen V1 defaults', async () => {
      const window = await budgetWindow(app);
      expect(window.limitUsd).toBe(50);
      expect(window.warnUsd).toBe(35);
      expect(window.hardStopUsd).toBe(50);
      expect(window.monthToDateUsd).toBe(0);
    });

    it('is idempotent: two racing workers produce one row', async () => {
      await Promise.all([budgetWindow(app), budgetWindow(app), budgetWindow(app)]);
      const { rows } = await app.query<{ count: string }>('SELECT count(*) AS count FROM budgets');
      expect(rows[0]?.count).toBe('1');
    });

    it('lets the ceiling be raised with an UPDATE, not a deploy (§16)', async () => {
      await budgetWindow(app);
      await db.adminPool.query('UPDATE budgets SET hard_stop_usd = 120, limit_usd = 120');
      const window = await budgetWindow(app);
      expect(window.hardStopUsd).toBe(120);
    });

    it('counts month-to-date from llm_calls, this month only', async () => {
      await budgetWindow(app);
      await db.adminPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, cost_usd, status, created_at)
         VALUES ('T', 'web.extract', 'isolated_untrusted', $1, $2, 4.000000, 'succeeded', now()),
                ('T', 'web.extract', 'isolated_untrusted', $1, $2, 9.000000, 'succeeded',
                 date_trunc('month', now()) - interval '2 days')`,
        [PROVIDER, MODEL],
      );
      const window = await budgetWindow(app);
      expect(window.monthToDateUsd).toBe(4);
    });
  });

  describe('the hard stop', () => {
    it('allows a call that fits', async () => {
      const decision = await checkBudget(app, request());
      expect(decision.allowed).toBe(true);
      // 10,000 input at $3/Mtok + 4,000 output at $15/Mtok = $0.09.
      expect(decision.allowed && decision.estimatedUsd).toBeCloseTo(0.09, 6);
    });

    it('refuses when month-to-date plus the estimate would cross the ceiling', async () => {
      await budgetWindow(app);
      await db.adminPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, cost_usd, status)
         VALUES ('T', 'web.extract', 'isolated_untrusted', $1, $2, 49.980000, 'succeeded')`,
        [PROVIDER, MODEL],
      );
      const decision = await checkBudget(app, request());
      expect(decision.allowed).toBe(false);
      expect(!decision.allowed && decision.reason).toBe('hard_stop');
      expect(!decision.allowed && decision.detail).toMatch(/hard stop/);
    });

    it('refuses on the estimate, not on the actual: the estimate is the control', async () => {
      // Exactly at the ceiling minus a hair. A gate that only looked at
      // month-to-date would allow this and cross the stop by $0.09.
      await budgetWindow(app);
      await db.adminPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, cost_usd, status)
         VALUES ('T', 'web.extract', 'isolated_untrusted', $1, $2, 49.950000, 'succeeded')`,
        [PROVIDER, MODEL],
      );
      const window = await budgetWindow(app);
      expect(window.monthToDateUsd).toBeLessThan(window.hardStopUsd);
      const decision = await checkBudget(app, request());
      expect(decision.allowed).toBe(false);
    });

    it('fails closed when the model has no price: an unpriceable call is unauthorised', async () => {
      const decision = await checkBudget(app, request({ model: 'model-with-no-price' }));
      expect(decision.allowed).toBe(false);
      expect(!decision.allowed && decision.reason).toBe('no_pricing');
    });

    it('ignores a price that is not yet in force', async () => {
      await db.adminPool.query(
        `INSERT INTO model_pricing (provider, model, input_per_mtok, output_per_mtok, effective_from)
         VALUES ($1, 'future-model', 1, 1, now() + interval '30 days')`,
        [PROVIDER],
      );
      const decision = await checkBudget(app, request({ model: 'future-model' }));
      expect(!decision.allowed && decision.reason).toBe('no_pricing');
    });

    it('takes the newest price in force when there are several', async () => {
      await db.adminPool.query(
        `INSERT INTO model_pricing (provider, model, input_per_mtok, output_per_mtok, effective_from)
         VALUES ($1, $2, 30.000000, 150.000000, now() - interval '1 hour')`,
        [PROVIDER, MODEL],
      );
      const price = await priceFor(app, PROVIDER, MODEL);
      expect(price?.inputPerMtok).toBe(30);
      await db.adminPool.query(
        `DELETE FROM model_pricing WHERE effective_from > now() - interval '2 hours'`,
      );
    });
  });

  describe('the warning, once per month (§16)', () => {
    it('raises one event when the threshold is first crossed', async () => {
      await budgetWindow(app);
      await db.adminPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, cost_usd, status)
         VALUES ('T', 'web.extract', 'isolated_untrusted', $1, $2, 36.000000, 'succeeded')`,
        [PROVIDER, MODEL],
      );

      for (let i = 0; i < 5; i += 1) {
        const decision = await checkBudget(app, request());
        // Calls continue after the warning: it is a warning, not a stop.
        expect(decision.allowed).toBe(true);
      }

      const { rows } = await app.query<{ count: string }>(
        `SELECT count(*) AS count FROM events
          WHERE entity_type = 'budget' AND kind = 'budget.warning'`,
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('raises nothing below the threshold', async () => {
      await checkBudget(app, request());
      const { rows } = await app.query<{ count: string }>(
        `SELECT count(*) AS count FROM events WHERE kind = 'budget.warning'`,
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('carries no personal text, so the audit spine stays clean (§16)', async () => {
      await budgetWindow(app);
      await db.adminPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, cost_usd, status)
         VALUES ('T', 'web.extract', 'isolated_untrusted', $1, $2, 40.000000, 'succeeded')`,
        [PROVIDER, MODEL],
      );
      await checkBudget(app, request());
      const { rows } = await app.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM events WHERE kind = 'budget.warning'`,
      );
      expect(Object.keys(rows[0]?.payload ?? {}).sort()).toStrictEqual([
        'month_to_date_usd',
        'period_month',
        'warn_usd',
      ]);
    });
  });

  describe('recording a call (§4, §16)', () => {
    it('computes the cost from model_pricing rather than from the caller', async () => {
      await recordCall(app, {
        traceId: 'T',
        jobId: null,
        purpose: 'web.extract',
        isolation: 'isolated_untrusted',
        provider: PROVIDER,
        model: MODEL,
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0 },
        latencyMs: 1_234,
        status: 'succeeded',
        requestHash: 'a'.repeat(64),
      });
      const { rows } = await app.query<{ cost_usd: string; latency_ms: number }>(
        'SELECT cost_usd, latency_ms FROM llm_calls',
      );
      expect(Number(rows[0]?.cost_usd)).toBe(18);
      expect(rows[0]?.latency_ms).toBe(1_234);
    });

    it('records a blocked call at zero cost, so the control is visible', async () => {
      await recordCall(app, {
        traceId: 'T',
        jobId: null,
        purpose: 'web.extract',
        isolation: 'isolated_untrusted',
        provider: PROVIDER,
        model: MODEL,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        latencyMs: null,
        status: 'blocked',
        requestHash: 'b'.repeat(64),
        costUsdOverride: 0,
      });
      const { rows } = await app.query<{ status: string; cost_usd: string }>(
        'SELECT status, cost_usd FROM llm_calls',
      );
      expect(rows[0]?.status).toBe('blocked');
      expect(Number(rows[0]?.cost_usd)).toBe(0);
    });

    it('stores a hash of the input, never the input (§16)', async () => {
      await recordCall(app, {
        traceId: 'T',
        jobId: null,
        purpose: 'web.extract',
        isolation: 'isolated_untrusted',
        provider: PROVIDER,
        model: MODEL,
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        latencyMs: 1,
        status: 'succeeded',
        requestHash: 'c'.repeat(64),
      });
      const { rows } = await app.query<{ request_hash: string }>(
        'SELECT request_hash FROM llm_calls',
      );
      expect(rows[0]?.request_hash).toMatch(/^c{64}$/);
    });
  });

  describe('the estimate is pessimistic on purpose', () => {
    it('charges cached tokens at the input rate, so the estimate is never low', () => {
      const price = { inputPerMtok: 3, outputPerMtok: 15, effectiveFrom: new Date() };
      const withCache = costUsd(
        { inputTokens: 500_000, outputTokens: 0, cachedTokens: 500_000 },
        price,
      );
      expect(withCache).toBe(3);
    });

    it('rounds token estimates up', () => {
      expect(estimateTokens('abc')).toBe(1);
      expect(estimateTokens('a'.repeat(4_001))).toBe(1_001);
    });
  });
});
