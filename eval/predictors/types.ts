/**
 * The predictor seam (SPEC.md §21, §25 Day 5 / Day 6).
 *
 * Day 5 builds the harness; Day 6 builds the thing being measured — "code
 * filters, practice_area_priors, rubric v1.1, privileged(), grounding filter,
 * thresholds derived from the holdout. Then the multi-metric provider bake-off".
 * None of that exists yet, and Day 5 must not pretend otherwise.
 *
 * So this is the whole of the contract between them. A Day 6 evaluator — the
 * real rubric, behind `privileged()`, against whichever provider the bake-off
 * chooses — implements `EvalPredictor` and plugs in without touching fixture
 * loading, metrics or reporting.
 *
 * ## What a predictor is handed, and what it is not
 *
 * One frozen fixture, and nothing else. No database handle, no pool, no
 * company id, no campaign. A predictor that could read the database could read
 * `eval_fixtures.label`, and a predictor that can read the answer is not being
 * measured. The fixture carries the evidence and nothing about the label.
 *
 * ## Verdicts
 *
 * `EvalVerdict` is §4's `verdict` enum, three-valued, because that is what
 * `eval_results.predicted_verdict` stores and what §10 stage 7's gate produces.
 * Labels are two-valued. eval/metrics.ts explains how the two meet.
 */
import type { FixtureFile } from '../schemas';
import type { EvalVerdict } from '../metrics';

export type { EvalVerdict };

export interface EvalPrediction {
  readonly verdict: EvalVerdict;
  /**
   * §10's 0–100 rubric score, when the predictor computes one.
   *
   * Optional because Day 5 cannot require it: the rubric that produces it is
   * Day 6's, and `eval_results.predicted_score` is nullable for the same reason.
   */
  readonly score?: number;
  /**
   * §10's grounding filter is about reasons, so they are first-class here.
   *
   * Strings rather than a structure, because the evidence-key format is Day 6's
   * to define and inventing one now would be a decision made in the wrong file.
   */
  readonly reasons: readonly string[];
  /**
   * What this prediction cost, in USD, as the predictor measured it.
   *
   * Required, and required to be real. §16's ledger is the authority on money
   * actually spent; this figure is what the run reports, and a predictor that
   * made no model call reports 0 because it spent nothing.
   */
  readonly costUsd: number;
}

export interface EvalPredictor {
  /** Stable identifier, printed in every report. */
  readonly id: string;
  /**
   * What goes into `eval_runs.model`.
   *
   * §4 makes that column NOT NULL, so a predictor has to name something. A
   * predictor that calls no model names what it is, not a model it is not.
   */
  readonly model: string;
  /**
   * True when running this predictor can spend money.
   *
   * The runner refuses a billable predictor unless the operator says so on the
   * command line, because §16's hard stop protects the month and nothing
   * protects an accidental sixty-call run except asking first.
   */
  readonly billable: boolean;
  /**
   * True for predictors that exist to make the tests deterministic.
   *
   * Reported in the header of every report that used one, so no baseline can be
   * mistaken for a real measurement.
   */
  readonly testOnly: boolean;
  predict(fixture: FixtureFile): Promise<EvalPrediction>;
}
