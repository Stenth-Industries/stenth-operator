/**
 * Eval metrics (SPEC.md §21, §25 Day 5).
 *
 * Counting only. §25's Day 6 row holds the targets — "Precision@5 ≥ 0.80,
 * rejection precision ≥ 0.90" — and §10 says Day 6 derives its thresholds from
 * the holdout run, so there is no pass/fail here to test.
 *
 * What is tested is the arithmetic, and above all the zero cases: a rate whose
 * denominator is zero must be `null`, never 0, never 1, never NaN. A report that
 * printed "precision 0.0000" for a run that predicted nothing qualified would be
 * stating a result it does not have.
 */
import { describe, expect, it } from 'vitest';

import { computeMetrics, type ScoredFixture } from '../../eval/metrics';

function fixture(
  label: 'qualified' | 'rejected',
  predicted: 'qualified' | 'uncertain' | 'rejected',
  costUsd = 0,
): ScoredFixture {
  return {
    domain: `${label}-${predicted}-${Math.random().toString(36).slice(2)}.example`,
    label,
    predicted,
    score: null,
    reasons: [],
    costUsd,
  };
}

describe('perfect and hopeless predictions', () => {
  it('scores a perfect run at 1 across the board', () => {
    const metrics = computeMetrics([
      fixture('qualified', 'qualified'),
      fixture('qualified', 'qualified'),
      fixture('rejected', 'rejected'),
      fixture('rejected', 'rejected'),
    ]);
    expect(metrics).toMatchObject({ total: 4, correct: 4, incorrect: 0, accuracy: 1 });
    expect(metrics.qualifiedPrecision).toBe(1);
    expect(metrics.qualifiedRecall).toBe(1);
    expect(metrics.qualifiedF1).toBe(1);
    expect(metrics.rejectedPrecision).toBe(1);
    expect(metrics.rejectedRecall).toBe(1);
    expect(metrics.confusion).toStrictEqual({
      trueQualified: 2,
      falseQualified: 0,
      trueRejected: 2,
      falseRejected: 0,
      uncertainOnQualified: 0,
      uncertainOnRejected: 0,
    });
  });

  it('scores an entirely wrong run at 0, with no rate becoming null by accident', () => {
    const metrics = computeMetrics([
      fixture('qualified', 'rejected'),
      fixture('rejected', 'qualified'),
    ]);
    expect(metrics).toMatchObject({ total: 2, correct: 0, incorrect: 2, accuracy: 0 });
    // Each side predicted exactly one, and got it wrong: 0/1, not undefined.
    expect(metrics.qualifiedPrecision).toBe(0);
    expect(metrics.qualifiedRecall).toBe(0);
    expect(metrics.rejectedPrecision).toBe(0);
    expect(metrics.rejectedRecall).toBe(0);
    // Precision and recall are both zero, so the harmonic mean is 0/0.
    expect(metrics.qualifiedF1).toBeNull();
    expect(metrics.rejectedF1).toBeNull();
  });
});

describe('the zero cases are named, not defaulted', () => {
  it('returns null for every rate on an empty run', () => {
    const metrics = computeMetrics([]);
    expect(metrics.total).toBe(0);
    for (const value of [
      metrics.accuracy,
      metrics.qualifiedPrecision,
      metrics.qualifiedRecall,
      metrics.qualifiedF1,
      metrics.rejectedPrecision,
      metrics.rejectedRecall,
      metrics.rejectedF1,
      metrics.meanCostUsd,
    ]) {
      expect(value).toBeNull();
    }
    expect(metrics.totalCostUsd).toBe(0);
  });

  it('nulls qualified precision when nothing was predicted qualified', () => {
    const metrics = computeMetrics([
      fixture('qualified', 'rejected'),
      fixture('rejected', 'rejected'),
    ]);
    expect(metrics.qualifiedPrecision).toBeNull();
    expect(metrics.qualifiedRecall).toBe(0);
    expect(metrics.qualifiedF1).toBeNull();
    expect(metrics.rejectedPrecision).toBe(0.5);
  });

  it('nulls qualified recall when nothing was actually qualified', () => {
    const metrics = computeMetrics([
      fixture('rejected', 'qualified'),
      fixture('rejected', 'rejected'),
    ]);
    expect(metrics.qualifiedRecall).toBeNull();
    expect(metrics.qualifiedPrecision).toBe(0);
    expect(metrics.rejectedRecall).toBe(0.5);
  });

  it('nulls rejected precision and recall symmetrically', () => {
    const allQualified = computeMetrics([
      fixture('qualified', 'qualified'),
      fixture('qualified', 'qualified'),
    ]);
    expect(allQualified.rejectedPrecision).toBeNull();
    expect(allQualified.rejectedRecall).toBeNull();
  });

  it('never produces NaN or Infinity for any input shape', () => {
    const shapes: ScoredFixture[][] = [
      [],
      [fixture('qualified', 'uncertain')],
      [fixture('rejected', 'uncertain')],
      [fixture('qualified', 'uncertain'), fixture('rejected', 'uncertain')],
      [fixture('qualified', 'qualified'), fixture('rejected', 'uncertain')],
    ];
    for (const shape of shapes) {
      const metrics = computeMetrics(shape);
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${key} = ${value}`).toBe(true);
        }
      }
    }
  });
});

describe('uncertain is counted in its own right', () => {
  it('is never correct, and is neither a false qualification nor a false rejection', () => {
    const metrics = computeMetrics([
      fixture('qualified', 'uncertain'),
      fixture('rejected', 'uncertain'),
    ]);
    expect(metrics.correct).toBe(0);
    expect(metrics.accuracy).toBe(0);
    expect(metrics.predictedUncertain).toBe(2);
    expect(metrics.confusion.falseQualified).toBe(0);
    expect(metrics.confusion.falseRejected).toBe(0);
    expect(metrics.confusion.uncertainOnQualified).toBe(1);
    expect(metrics.confusion.uncertainOnRejected).toBe(1);
    // Nothing was called qualified or rejected, so neither precision exists.
    expect(metrics.qualifiedPrecision).toBeNull();
    expect(metrics.rejectedPrecision).toBeNull();
    // But both were actually something, so recall is 0 rather than null.
    expect(metrics.qualifiedRecall).toBe(0);
    expect(metrics.rejectedRecall).toBe(0);
  });

  it('stays out of precision denominators and inside recall denominators', () => {
    // One qualified found, one sent to a human. Precision 1/1; recall 1/2.
    const metrics = computeMetrics([
      fixture('qualified', 'qualified'),
      fixture('qualified', 'uncertain'),
    ]);
    expect(metrics.qualifiedPrecision).toBe(1);
    expect(metrics.qualifiedRecall).toBe(0.5);
    expect(metrics.qualifiedF1).toBeCloseTo(2 / 3, 10);
  });
});

describe('a mixed confusion matrix', () => {
  it('counts every cell independently', () => {
    const metrics = computeMetrics([
      fixture('qualified', 'qualified'),
      fixture('qualified', 'qualified'),
      fixture('qualified', 'qualified'),
      fixture('qualified', 'rejected'),
      fixture('qualified', 'uncertain'),
      fixture('rejected', 'rejected'),
      fixture('rejected', 'rejected'),
      fixture('rejected', 'qualified'),
      fixture('rejected', 'uncertain'),
    ]);
    expect(metrics.confusion).toStrictEqual({
      trueQualified: 3,
      falseQualified: 1,
      trueRejected: 2,
      falseRejected: 1,
      uncertainOnQualified: 1,
      uncertainOnRejected: 1,
    });
    expect(metrics.total).toBe(9);
    expect(metrics.correct).toBe(5);
    expect(metrics.accuracy).toBeCloseTo(5 / 9, 10);
    expect(metrics.qualifiedPrecision).toBe(0.75);
    expect(metrics.qualifiedRecall).toBe(0.6);
    expect(metrics.rejectedPrecision).toBeCloseTo(2 / 3, 10);
    expect(metrics.rejectedRecall).toBe(0.5);
  });
});

describe('cost', () => {
  it('sums and averages, and says when nothing was spent', () => {
    const free = computeMetrics([fixture('qualified', 'qualified')]);
    expect(free.totalCostUsd).toBe(0);
    expect(free.meanCostUsd).toBe(0);
    expect(free.costReported).toBe(false);

    const paid = computeMetrics([
      fixture('qualified', 'qualified', 0.02),
      fixture('rejected', 'rejected', 0.04),
    ]);
    expect(paid.totalCostUsd).toBeCloseTo(0.06, 10);
    expect(paid.meanCostUsd).toBeCloseTo(0.03, 10);
    expect(paid.costReported).toBe(true);
  });
});
