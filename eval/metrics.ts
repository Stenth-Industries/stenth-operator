/**
 * Deterministic eval metrics (SPEC.md §21, §25 Day 5).
 *
 * §25's Day 5 row says "metrics". Day 6's row is the one that says "Precision@5
 * ≥ 0.80, rejection precision ≥ 0.90, grounding 1.00, zero hard-disqualifier
 * failures" — so those targets exist in the spec, but they are **Day 6 exit
 * criteria measured over a holdout that does not exist yet**, and §10 is
 * explicit that "Day 6 sets [the thresholds] from the holdout run, and the run
 * is what decides, not the argument".
 *
 * This file therefore computes and nothing else. No target, no pass/fail, no
 * threshold. It counts what the labels can unambiguously support, and Day 6
 * compares those numbers to the figures §22 and §25 name.
 *
 * ## The three-versus-two problem, stated rather than smoothed over
 *
 * §4 gives `eval_fixtures.label` two values — `qualified`, `rejected` — and
 * `eval_results.predicted_verdict` three, because `verdict` is
 * `qualified | uncertain | rejected`. That is not an inconsistency: §10's stage
 * 7 gate is "Qualified, uncertain or rejected" and "55–69 is uncertain and goes
 * to a human", while ground truth is a decision a person actually made.
 *
 * So `uncertain` is a legitimate prediction that matches no label. It is counted
 * in its own right rather than folded into either side:
 *
 *   * `correct` is `predicted === label`, so an `uncertain` prediction is never
 *     correct. It is also not a false qualification — nobody was contacted —
 *     and not a false rejection, because the firm was not discarded.
 *   * It is excluded from precision denominators, because precision asks "of the
 *     ones we called qualified, how many were" and an `uncertain` was not called
 *     qualified. It stays in recall denominators, because recall asks "of the
 *     ones that were qualified, how many did we find", and an `uncertain` did
 *     not find one.
 *
 * Every rate is `null` when its denominator is zero. Not 0, not 1, not NaN: no
 * answer, said out loud, so a report cannot read "precision 0.00" for a run that
 * predicted nothing.
 */
import type { EvalLabel } from './schemas';

export type EvalVerdict = 'qualified' | 'uncertain' | 'rejected';

export interface ScoredFixture {
  readonly domain: string;
  readonly label: EvalLabel;
  readonly predicted: EvalVerdict;
  readonly score: number | null;
  readonly reasons: readonly string[];
  readonly costUsd: number;
}

export interface Confusion {
  /** Label qualified, predicted qualified. */
  readonly trueQualified: number;
  /** Label rejected, predicted qualified — the expensive mistake. */
  readonly falseQualified: number;
  /** Label rejected, predicted rejected. */
  readonly trueRejected: number;
  /** Label qualified, predicted rejected — the missed prospect. */
  readonly falseRejected: number;
  /** Label qualified, predicted uncertain: sent to a human (§10 stage 7). */
  readonly uncertainOnQualified: number;
  /** Label rejected, predicted uncertain. */
  readonly uncertainOnRejected: number;
}

export interface EvalMetrics {
  readonly total: number;
  readonly correct: number;
  readonly incorrect: number;
  /** null when nothing was evaluated. */
  readonly accuracy: number | null;
  readonly confusion: Confusion;
  readonly predictedUncertain: number;
  readonly qualifiedPrecision: number | null;
  readonly qualifiedRecall: number | null;
  readonly qualifiedF1: number | null;
  readonly rejectedPrecision: number | null;
  readonly rejectedRecall: number | null;
  readonly rejectedF1: number | null;
  readonly totalCostUsd: number;
  readonly meanCostUsd: number | null;
  /** True when every prediction reported a cost of exactly zero. */
  readonly costReported: boolean;
}

/** Division with the zero case named rather than guarded by a default. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function f1(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) {
    return null;
  }
  // Both zero means the harmonic mean is 0/0. There is no F1 here, so say so.
  if (precision + recall === 0) {
    return null;
  }
  return (2 * precision * recall) / (precision + recall);
}

export function computeMetrics(scored: readonly ScoredFixture[]): EvalMetrics {
  const confusion: Confusion = {
    trueQualified: count(scored, 'qualified', 'qualified'),
    falseQualified: count(scored, 'rejected', 'qualified'),
    trueRejected: count(scored, 'rejected', 'rejected'),
    falseRejected: count(scored, 'qualified', 'rejected'),
    uncertainOnQualified: count(scored, 'qualified', 'uncertain'),
    uncertainOnRejected: count(scored, 'rejected', 'uncertain'),
  };

  const correct = scored.filter((item) => item.predicted === item.label).length;
  const totalCostUsd = scored.reduce((sum, item) => sum + item.costUsd, 0);

  const predictedQualified = confusion.trueQualified + confusion.falseQualified;
  const predictedRejected = confusion.trueRejected + confusion.falseRejected;
  const actualQualified =
    confusion.trueQualified + confusion.falseRejected + confusion.uncertainOnQualified;
  const actualRejected =
    confusion.trueRejected + confusion.falseQualified + confusion.uncertainOnRejected;

  const qualifiedPrecision = ratio(confusion.trueQualified, predictedQualified);
  const qualifiedRecall = ratio(confusion.trueQualified, actualQualified);
  const rejectedPrecision = ratio(confusion.trueRejected, predictedRejected);
  const rejectedRecall = ratio(confusion.trueRejected, actualRejected);

  return {
    total: scored.length,
    correct,
    incorrect: scored.length - correct,
    accuracy: ratio(correct, scored.length),
    confusion,
    predictedUncertain: confusion.uncertainOnQualified + confusion.uncertainOnRejected,
    qualifiedPrecision,
    qualifiedRecall,
    qualifiedF1: f1(qualifiedPrecision, qualifiedRecall),
    rejectedPrecision,
    rejectedRecall,
    rejectedF1: f1(rejectedPrecision, rejectedRecall),
    totalCostUsd,
    meanCostUsd: ratio(totalCostUsd, scored.length),
    costReported: scored.some((item) => item.costUsd > 0),
  };
}

function count(
  scored: readonly ScoredFixture[],
  label: EvalLabel,
  predicted: EvalVerdict,
): number {
  return scored.filter((item) => item.label === label && item.predicted === predicted).length;
}
