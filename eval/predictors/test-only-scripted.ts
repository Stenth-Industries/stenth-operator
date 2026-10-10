/**
 * A test-only predictor. NOT a baseline, NOT a heuristic, NOT Day 6.
 *
 * Its entire behaviour is "answer whatever the script says for this domain, and
 * `uncertain` for anything unscripted". It exists so the runner, the metrics and
 * the report can be tested end to end without a model, and it is deliberately
 * incapable of being mistaken for a measurement:
 *
 *   * `testOnly: true`, which the runner refuses to select without
 *     `--allow-test-predictor`;
 *   * every report that used it carries a warning line;
 *   * `model` says `test-only-scripted`, so an `eval_runs` row made with it is
 *     identifiable for ever;
 *   * it looks at no evidence at all, so no reader can mistake its output for a
 *     judgement about a firm.
 *
 * A predictor that inspected the fixture and guessed would be worse than this
 * one, because it would produce plausible numbers.
 */
import type { EvalPrediction, EvalPredictor, EvalVerdict } from './types';
import type { FixtureFile } from '../schemas';

export interface ScriptedAnswer {
  readonly verdict: EvalVerdict;
  readonly score?: number;
  readonly reasons?: readonly string[];
  readonly costUsd?: number;
}

const script = new Map<string, ScriptedAnswer>();

/** Sets the answer for one domain. Tests call this; nothing else does. */
export function scriptAnswer(domain: string, answer: ScriptedAnswer): void {
  script.set(domain, answer);
}

export function clearScript(): void {
  script.clear();
}

export const scriptedTestPredictor: EvalPredictor = {
  id: 'test-only-scripted',
  model: 'test-only-scripted',
  billable: false,
  testOnly: true,
  async predict(fixture: FixtureFile): Promise<EvalPrediction> {
    const answer = script.get(fixture.canonical_domain);
    if (answer === undefined) {
      // Unscripted means "this predictor has nothing to say", which is exactly
      // what `uncertain` means in §10 stage 7.
      return { verdict: 'uncertain', reasons: ['test_only_unscripted'], costUsd: 0 };
    }
    return {
      verdict: answer.verdict,
      ...(answer.score === undefined ? {} : { score: answer.score }),
      reasons: answer.reasons ?? [],
      costUsd: answer.costUsd ?? 0,
    };
  },
};
