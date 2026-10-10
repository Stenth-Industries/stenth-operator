/**
 * eval/run.ts, offline (SPEC.md §21, §25 Day 5).
 *
 * §25's Day 5 exit criterion starts "Eval runs offline in under two minutes".
 * Offline is the property under test here: these cases stub nothing, because
 * there is nothing to stub — the runner reads files. The one case that proves it
 * counts `globalThis.fetch` calls, which is the only honest way to assert a
 * negative about network access.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reportRoot } from '../../eval/paths';
import {
  clearPredictors,
  getPredictor,
  hasRealPredictor,
  registerAvailablePredictors,
  registerPredictor,
  registeredPredictors,
} from '../../eval/predictors';
import { clearScript, scriptAnswer, scriptedTestPredictor } from '../../eval/predictors/test-only-scripted';
import type { EvalPredictor } from '../../eval/predictors/types';
import { runEval } from '../../eval/run';
import { assignSplit } from '../../eval/split';
import { aLabel, removeSet, scratchSet, writeFixture, writeLabels } from './helpers';

const sets: string[] = [];
const writtenReports: string[] = [];

function freshSet(domains: readonly string[]): string {
  const fixtureSet = scratchSet('run');
  sets.push(fixtureSet);
  for (const domain of domains) {
    writeFixture(fixtureSet, domain);
  }
  return fixtureSet;
}

const NOW = new Date('2026-10-10T04:05:06.000Z');

beforeEach(() => {
  clearPredictors();
  clearScript();
  registerAvailablePredictors();
});

afterEach(() => {
  while (sets.length > 0) {
    removeSet(sets.pop() as string);
  }
  while (writtenReports.length > 0) {
    rmSync(writtenReports.pop() as string, { force: true });
  }
  clearScript();
});

function baseOptions(fixtureSet: string) {
  return {
    fixtureSet,
    predictor: scriptedTestPredictor,
    rubricVersion: 'none-day6-owns-this',
    promptVersion: 'extract-v1',
    allowHoldout: false,
    allowBillable: false,
    now: NOW,
    writeReport: false as const,
  };
}

describe('the predictor registry', () => {
  it('has no real predictor yet, and says so rather than shipping a heuristic', () => {
    // §25 puts the rubric, the grounding filter and the provider bake-off on
    // Day 6. A heuristic here would put a number in front of a human that
    // measures nothing.
    expect(hasRealPredictor()).toBe(false);
    expect(registeredPredictors().map((candidate) => candidate.id)).toStrictEqual([
      'test-only-scripted',
    ]);
    expect(getPredictor('test-only-scripted')?.testOnly).toBe(true);
    expect(getPredictor('test-only-scripted')?.billable).toBe(false);
  });

  it('refuses to register two predictors under one id', () => {
    expect(() => registerPredictor(scriptedTestPredictor)).toThrow(/already registered/);
  });
});

describe('dev runs without a flag; holdout does not', () => {
  it('runs the dev split and scores it', () => {
    const fixtureSet = freshSet(['a.example', 'b.example']);
    assignSplit(fixtureSet, { dev: 2, holdout: 0 });
    writeLabels(fixtureSet, {
      'a.example': aLabel({ label: 'qualified' }),
      'b.example': aLabel({ label: 'rejected' }),
    });
    scriptAnswer('a.example', { verdict: 'qualified', score: 81 });
    scriptAnswer('b.example', { verdict: 'rejected', score: 12 });

    return runEval({ ...baseOptions(fixtureSet), split: 'dev' }).then((result) => {
      expect(result.evaluated).toBe(2);
      expect(result.metrics.accuracy).toBe(1);
      expect(result.scored.map((item) => item.domain)).toStrictEqual(['a.example', 'b.example']);
      expect(result.report).toContain('# Eval run');
      expect(result.report).not.toContain('HOLDOUT RUN');
    });
  });

  it('refuses the holdout split without --allow-holdout', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 0, holdout: 1 });
    writeLabels(fixtureSet, { 'a.example': aLabel() });

    await expect(runEval({ ...baseOptions(fixtureSet), split: 'holdout' })).rejects.toThrow(
      /holdout_not_allowed/,
    );
  });

  it('runs the holdout when explicitly allowed, and the report shouts about it', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 0, holdout: 1 });
    writeLabels(fixtureSet, { 'a.example': aLabel({ label: 'qualified' }) });
    scriptAnswer('a.example', { verdict: 'qualified' });

    const result = await runEval({
      ...baseOptions(fixtureSet),
      split: 'holdout',
      allowHoldout: true,
    });
    expect(result.report).toContain('HOLDOUT RUN');
    expect(result.report).toContain('| split | `holdout` |');
  });

  it('never defaults to holdout: a dev run only sees dev fixtures', async () => {
    const fixtureSet = freshSet(['a.example', 'b.example', 'c.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 2 });
    writeLabels(fixtureSet, {
      'a.example': aLabel(),
      'b.example': aLabel(),
      'c.example': aLabel(),
    });

    const result = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    expect(result.evaluated).toBe(1);
  });
});

describe('what the runner refuses', () => {
  it('refuses to score a split containing an unlabelled fixture', async () => {
    const fixtureSet = freshSet(['a.example', 'b.example']);
    assignSplit(fixtureSet, { dev: 2, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel() });

    await expect(runEval({ ...baseOptions(fixtureSet), split: 'dev' })).rejects.toThrow(
      /unlabelled_fixtures/,
    );
    // Named, so the human knows what to label next.
    await expect(runEval({ ...baseOptions(fixtureSet), split: 'dev' })).rejects.toThrow(
      /b\.example/,
    );
  });

  it('refuses an empty set and an empty split', async () => {
    const empty = scratchSet('run-empty');
    sets.push(empty);
    writeFixture(empty, 'a.example');
    await expect(runEval({ ...baseOptions(empty), split: 'dev' })).rejects.toThrow(/empty_split/);
  });

  it('refuses a test-only predictor’s run to be mistaken for a baseline', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel({ label: 'qualified' }) });
    scriptAnswer('a.example', { verdict: 'qualified' });

    const result = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    expect(result.report).toContain('TEST-ONLY PREDICTOR');
    expect(result.report).toContain('is not a baseline');
  });

  it('refuses a billable predictor without explicit authorisation', async () => {
    const billable: EvalPredictor = {
      id: 'zz-billable',
      model: 'some-model',
      billable: true,
      testOnly: false,
      predict: async () => ({ verdict: 'qualified', reasons: [], costUsd: 0.02 }),
    };
    registerPredictor(billable);

    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel() });

    await expect(
      runEval({ ...baseOptions(fixtureSet), split: 'dev', predictor: billable }),
    ).rejects.toThrow(/billable_not_allowed/);
  });

  it('refuses a predictor that reports a nonsensical cost', async () => {
    const liar: EvalPredictor = {
      id: 'zz-bad-cost',
      model: 'm',
      billable: false,
      testOnly: false,
      predict: async () => ({ verdict: 'qualified', reasons: [], costUsd: -1 }),
    };
    registerPredictor(liar);

    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel() });

    await expect(
      runEval({ ...baseOptions(fixtureSet), split: 'dev', predictor: liar }),
    ).rejects.toThrow(/bad_cost/);
  });

  it('refuses a fixture whose digest no longer matches its content', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel() });

    // A hand-edited corpus is not the corpus that was labelled.
    const path = join(reportRoot(), '..', 'fixtures', fixtureSet, 'companies', 'a.example.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { pages: { text: string }[] };
    raw.pages[0]!.text = 'rewritten by hand';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify(raw), 'utf8');

    await expect(runEval({ ...baseOptions(fixtureSet), split: 'dev' })).rejects.toThrow(
      /digest_mismatch/,
    );
  });
});

describe('the run is offline', () => {
  it('opens no socket: global fetch is never called', async () => {
    const fixtureSet = freshSet(['a.example', 'b.example']);
    assignSplit(fixtureSet, { dev: 2, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel(), 'b.example': aLabel() });
    scriptAnswer('a.example', { verdict: 'qualified' });
    scriptAnswer('b.example', { verdict: 'rejected' });

    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('the eval harness must not reach the network');
    }) as typeof globalThis.fetch;
    try {
      const result = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
      expect(result.evaluated).toBe(2);
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(0);
  });

  it('resolves no provider and reads no MODEL_PROVIDER', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel() });
    scriptAnswer('a.example', { verdict: 'qualified' });

    // If the harness touched the provider seam this would be the failure: there
    // is no provider configured and resolveProvider throws by design (§1, §22).
    const previous = process.env.MODEL_PROVIDER;
    delete process.env.MODEL_PROVIDER;
    try {
      await expect(runEval({ ...baseOptions(fixtureSet), split: 'dev' })).resolves.toMatchObject({
        evaluated: 1,
      });
    } finally {
      if (previous !== undefined) {
        process.env.MODEL_PROVIDER = previous;
      }
    }
  });
});

describe('the report', () => {
  it('is written to eval/reports and names the run', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel({ label: 'qualified' }) });
    scriptAnswer('a.example', { verdict: 'rejected', reasons: ['scripted'] });

    const result = await runEval({
      ...baseOptions(fixtureSet),
      split: 'dev',
      writeReport: true,
    });
    expect(result.reportPath).toBeDefined();
    const absolute = join(reportRoot(), (result.reportPath as string).split('/').pop() as string);
    writtenReports.push(absolute);
    expect(existsSync(absolute)).toBe(true);

    const report = readFileSync(absolute, 'utf8');
    expect(report).toBe(result.report);
    expect(report).toContain(`| fixture set | \`${fixtureSet}\` |`);
    expect(report).toContain('| prompt version | `extract-v1` |');
    expect(report).toContain('| model | `test-only-scripted` |');
    expect(report).toContain('| eval_runs id | (not persisted) |');
  });

  it('lists every incorrect fixture with its expectation and reasons', async () => {
    const fixtureSet = freshSet(['wrong.example', 'right.example']);
    assignSplit(fixtureSet, { dev: 2, holdout: 0 });
    writeLabels(fixtureSet, {
      'wrong.example': aLabel({ label: 'qualified' }),
      'right.example': aLabel({ label: 'rejected' }),
    });
    scriptAnswer('wrong.example', { verdict: 'rejected', score: 20, reasons: ['too_large'] });
    scriptAnswer('right.example', { verdict: 'rejected', score: 10 });

    const result = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    expect(result.report).toContain('## Incorrect (1)');
    expect(result.report).toContain('| `wrong.example` | qualified | rejected | 20 | too_large |');
    expect(result.report).not.toContain('`right.example` |');
  });

  it('says Day 5 is not exited while the set holds fewer than sixty labels', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel() });
    scriptAnswer('a.example', { verdict: 'qualified' });

    const result = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    expect(result.exitCriterionMet).toBe(false);
    expect(result.report).toContain('DAY 5 NOT EXITED');
    expect(result.report).toContain('1 of 60');
  });

  it('shows an em dash rather than zero for a rate with no denominator', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel({ label: 'rejected' }) });
    scriptAnswer('a.example', { verdict: 'rejected' });

    const result = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    // Nothing was qualified and nothing was called qualified.
    expect(result.report).toContain('| qualified precision | — |');
    expect(result.report).toContain('| qualified recall | — |');
    expect(result.report).toContain('An em dash is a rate whose denominator was zero.');
  });

  it('is deterministic for a fixed run', async () => {
    const fixtureSet = freshSet(['a.example', 'b.example']);
    assignSplit(fixtureSet, { dev: 2, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel(), 'b.example': aLabel() });
    scriptAnswer('a.example', { verdict: 'qualified' });
    scriptAnswer('b.example', { verdict: 'qualified' });

    const first = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    const second = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    expect(first.report).toBe(second.report);
  });

  it('carries no secret and no credential', async () => {
    const fixtureSet = freshSet(['a.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'a.example': aLabel() });
    scriptAnswer('a.example', { verdict: 'qualified' });

    const result = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    for (const forbidden of [
      'MODEL_API_KEY',
      'FETCHER_SHARED_SECRET',
      'DATABASE_URL',
      'postgres://',
      'sk-',
      'Bearer ',
      'x-api-key',
    ]) {
      expect(result.report, forbidden).not.toContain(forbidden);
    }
  });
});

describe('an unscripted fixture', () => {
  it('comes back uncertain, which is never counted as correct', async () => {
    const fixtureSet = freshSet(['unscripted.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeLabels(fixtureSet, { 'unscripted.example': aLabel({ label: 'qualified' }) });

    const result = await runEval({ ...baseOptions(fixtureSet), split: 'dev' });
    expect(result.scored[0]?.predicted).toBe('uncertain');
    expect(result.metrics.correct).toBe(0);
    expect(result.metrics.predictedUncertain).toBe(1);
    expect(result.metrics.confusion.falseRejected).toBe(0);
  });
});
