/**
 * The predictor registry.
 *
 * Empty of real predictors, on purpose. §25 puts the rubric, the grounding
 * filter and the provider bake-off on Day 6; shipping a heuristic here and
 * calling it a baseline would put a number in front of Kushagra that measures
 * nothing, and §10's "the run is what decides, not the argument" is precisely
 * about not doing that.
 *
 * So `eval:run` with no predictor says there is no predictor. When Day 6 has
 * one, it is registered here and the rest of the harness does not change.
 */
import { scriptedTestPredictor } from './test-only-scripted';
import type { EvalPredictor } from './types';

const predictors = new Map<string, EvalPredictor>();

export function registerPredictor(predictor: EvalPredictor): void {
  if (predictors.has(predictor.id)) {
    throw new Error(`a predictor is already registered as "${predictor.id}"`);
  }
  predictors.set(predictor.id, predictor);
}

export function getPredictor(id: string): EvalPredictor | undefined {
  return predictors.get(id);
}

export function registeredPredictors(): EvalPredictor[] {
  return [...predictors.values()];
}

/** Tests register per case and need a clean registry between them. */
export function clearPredictors(): void {
  predictors.clear();
}

/**
 * Registers everything this build has.
 *
 * Today that is one test-only predictor and no real one. The runner will not
 * select the test-only predictor without an explicit flag, and says so in the
 * report when it does.
 */
export function registerAvailablePredictors(): void {
  if (getPredictor(scriptedTestPredictor.id) === undefined) {
    registerPredictor(scriptedTestPredictor);
  }
}

/** True when a predictor that could produce a real baseline exists. */
export function hasRealPredictor(): boolean {
  return registeredPredictors().some((predictor) => !predictor.testOnly);
}
