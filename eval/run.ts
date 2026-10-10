/**
 * eval/run.ts — the offline evaluation run (SPEC.md §21, §25 Day 5).
 *
 * §25's Day 5 exit criterion is "Eval runs offline in under two minutes; no real
 * address in the committed corpus; baseline recorded". The first clause is
 * structural here: this file opens no socket to the internet and reads no page.
 * Every fixture is a file that was frozen once, and a run is a loop over files.
 *
 *   npm run eval:run -- --fixture-set=<set> --split=dev \
 *     --predictor=<id> --rubric-version=<v> --prompt-version=<v>
 *
 * Nothing is defaulted that a reader would want stated. There is no default
 * predictor, no default split, no default rubric version — §25 Day 6 owns the
 * rubric and inventing a version string here would be inventing a rubric.
 *
 * ## What it refuses
 *
 *   * an unlabelled fixture, because a fixture with no ground truth cannot be
 *     scored and scoring the rest silently would report a number for a corpus
 *     that is not the corpus;
 *   * `--split=holdout` without `--allow-holdout`;
 *   * a billable predictor without `--allow-billable`, because §16's ceiling
 *     protects the month and nothing protects an accidental sixty-call run
 *     except being asked;
 *   * a test-only predictor without `--allow-test-predictor`;
 *   * a fixture whose digest does not match its content.
 *
 * ## What it never does
 *
 * Fetch a page. Resolve a provider. Read `MODEL_PROVIDER`. Touch `companies`,
 * `prospects`, `web_snapshots`, `jobs` or `llm_calls`. With `--persist` it
 * writes three eval tables and nothing else.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool } from 'pg';

import { canonicalJson } from './canonical';
import { loadCorpus } from './corpus';
import { REQUIRED_LABEL_COUNT, labelStatus } from './label';
import { computeMetrics, type EvalMetrics, type ScoredFixture } from './metrics';
import { relativeToRepo, reportRoot } from './paths';
import {
  getPredictor,
  hasRealPredictor,
  registerAvailablePredictors,
  registeredPredictors,
} from './predictors';
import type { EvalPredictor } from './predictors/types';
import { renderReport, reportFilename } from './report';
import { SanitiserRejection } from './sanitise-snapshot';
import { evalSplit, type EvalSplit } from './schemas';

export interface RunOptions {
  readonly fixtureSet: string;
  readonly split: EvalSplit;
  readonly predictor: EvalPredictor;
  readonly rubricVersion: string;
  readonly promptVersion: string;
  readonly allowHoldout: boolean;
  readonly allowBillable: boolean;
  /** Injected so tests are deterministic. */
  readonly now?: Date;
  /** When set, the run writes eval_fixtures, eval_runs and eval_results. */
  readonly pool?: Pool;
  /** When false, the report is computed and returned but not written to disk. */
  readonly writeReport?: boolean;
}

export interface RunResult {
  readonly fixtureSet: string;
  readonly split: EvalSplit;
  readonly evaluated: number;
  readonly metrics: EvalMetrics;
  readonly scored: readonly ScoredFixture[];
  readonly report: string;
  readonly reportPath: string | undefined;
  readonly runId: string | undefined;
  readonly labelledInSet: number;
  readonly exitCriterionMet: boolean;
}

export async function runEval(options: RunOptions): Promise<RunResult> {
  if (options.split === 'holdout' && !options.allowHoldout) {
    throw new SanitiserRejection(
      'holdout_not_allowed',
      'refusing to run the holdout split without --allow-holdout. §25 Day 6 derives ' +
        'its thresholds from this split; every casual run spends a little of what ' +
        'makes it a holdout',
    );
  }
  if (options.predictor.billable && !options.allowBillable) {
    throw new SanitiserRejection(
      'billable_not_allowed',
      `predictor "${options.predictor.id}" can spend money; pass --allow-billable to ` +
        'authorise a run that may charge the §16 budget',
    );
  }

  const corpus = loadCorpus(options.fixtureSet);
  if (corpus.length === 0) {
    throw new SanitiserRejection(
      'empty_set',
      `fixture set "${options.fixtureSet}" has no frozen fixtures`,
    );
  }

  const selected = corpus.filter((entry) => entry.split === options.split);
  if (selected.length === 0) {
    throw new SanitiserRejection(
      'empty_split',
      `no fixture in "${options.fixtureSet}" is assigned to ${options.split}; ` +
        'assign the split first (eval:split)',
    );
  }

  // Loudly, and before any prediction. A run that scored the labelled subset and
  // mentioned the rest in a footnote would be reporting a number for a corpus
  // that is not the corpus.
  const unlabelled = selected.filter((entry) => entry.label === undefined);
  if (unlabelled.length > 0) {
    throw new SanitiserRejection(
      'unlabelled_fixtures',
      `${unlabelled.length} fixture(s) in ${options.split} carry no human label: ` +
        `${unlabelled.map((entry) => entry.fixture.canonical_domain).join(', ')}. ` +
        'Ground truth is a person’s input (§25 Day 5), so the run stops here',
    );
  }

  const scored: ScoredFixture[] = [];
  for (const entry of selected) {
    const label = entry.label;
    if (label === undefined) {
      throw new Error('unreachable: unlabelled fixtures were refused above');
    }
    const prediction = await options.predictor.predict(entry.fixture);
    if (!Number.isFinite(prediction.costUsd) || prediction.costUsd < 0) {
      throw new SanitiserRejection(
        'bad_cost',
        `predictor "${options.predictor.id}" reported cost ${prediction.costUsd} for ` +
          `${entry.fixture.canonical_domain}`,
      );
    }
    scored.push({
      domain: entry.fixture.canonical_domain,
      label: label.label,
      predicted: prediction.verdict,
      score: prediction.score ?? null,
      reasons: [...prediction.reasons],
      costUsd: prediction.costUsd,
    });
  }

  // Deterministic order, so two runs over one corpus produce comparable reports.
  scored.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

  const metrics = computeMetrics(scored);
  const status = labelStatus(options.fixtureSet);
  const generatedAt = (options.now ?? new Date()).toISOString();

  const runId =
    options.pool === undefined
      ? undefined
      : await persistRun(options.pool, options, corpus, scored, metrics, generatedAt);

  const report = renderReport({
    fixtureSet: options.fixtureSet,
    split: options.split,
    rubricVersion: options.rubricVersion,
    promptVersion: options.promptVersion,
    predictorId: options.predictor.id,
    model: options.predictor.model,
    predictorTestOnly: options.predictor.testOnly,
    generatedAt,
    runId,
    fixtureCount: scored.length,
    metrics,
    scored,
    labelledInSet: status.labelled,
    requiredLabels: REQUIRED_LABEL_COUNT,
  });

  let reportPath: string | undefined;
  if (options.writeReport !== false) {
    const filename = reportFilename({
      fixtureSet: options.fixtureSet,
      split: options.split,
      predictorId: options.predictor.id,
      generatedAt,
    });
    // Reports live outside the fixture root, so they are written directly
    // rather than through the fixture-root guard. The filename comes from
    // reportFilename, which composes it from validated parts.
    const absolute = join(reportRoot(), filename);
    mkdirSync(reportRoot(), { recursive: true });
    writeFileSync(absolute, report, 'utf8');
    reportPath = relativeToRepo(absolute);
  }

  return {
    fixtureSet: options.fixtureSet,
    split: options.split,
    evaluated: scored.length,
    metrics,
    scored,
    report,
    reportPath,
    runId,
    labelledInSet: status.labelled,
    exitCriterionMet: status.exitCriterionMet,
  };
}

/**
 * Writes the three eval tables, in one transaction.
 *
 * §4's contract, used as it stands — no migration. The one thing worth saying
 * out loud: `eval_fixtures.label` is NOT NULL, so a row can only exist for a
 * fixture a human has already labelled. That is why the **files** are the source
 * material and these rows are metadata: an unlabelled fixture is a real state of
 * the corpus that this schema cannot represent, and inventing a label to make it
 * representable would be the one thing Day 5 must never do.
 */
async function persistRun(
  pool: Pool,
  options: RunOptions,
  corpus: Awaited<ReturnType<typeof loadCorpus>>,
  scored: readonly ScoredFixture[],
  metrics: EvalMetrics,
  generatedAt: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fixtureIds = new Map<string, string>();
    for (const entry of corpus) {
      if (entry.label === undefined || entry.split === undefined) {
        continue;
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO eval_fixtures
           (fixture_set, split, domain, label, label_reason_codes, disqualifier,
            labelled_by, labelled_at, snapshot_path)
         VALUES ($1, $2::eval_split, $3, $4::eval_label, $5, $6, $7, $8, $9)
         ON CONFLICT (fixture_set, domain) DO UPDATE
            SET split              = excluded.split,
                label              = excluded.label,
                label_reason_codes = excluded.label_reason_codes,
                disqualifier       = excluded.disqualifier,
                labelled_by        = excluded.labelled_by,
                labelled_at        = excluded.labelled_at,
                snapshot_path      = excluded.snapshot_path
         RETURNING id`,
        [
          options.fixtureSet,
          entry.split,
          entry.fixture.canonical_domain,
          entry.label.label,
          entry.label.reason_codes,
          entry.label.disqualifier,
          entry.label.labelled_by,
          entry.label.labelled_at,
          entry.path,
        ],
      );
      const id = rows[0]?.id;
      if (id !== undefined) {
        fixtureIds.set(entry.fixture.canonical_domain, id);
      }
    }

    const run = await client.query<{ id: string }>(
      `INSERT INTO eval_runs
         (fixture_set, split, rubric_version, prompt_version, model, metrics, cost_usd, created_at)
       VALUES ($1, $2::eval_split, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        options.fixtureSet,
        options.split,
        options.rubricVersion,
        options.promptVersion,
        options.predictor.model,
        canonicalJson({ ...metrics, predictor_id: options.predictor.id }),
        metrics.totalCostUsd,
        generatedAt,
      ],
    );
    const runId = run.rows[0]?.id;
    if (runId === undefined) {
      throw new Error('the eval_runs insert returned no row');
    }

    for (const item of scored) {
      const fixtureId = fixtureIds.get(item.domain);
      if (fixtureId === undefined) {
        throw new Error(`no eval_fixtures row for ${item.domain}`);
      }
      await client.query(
        `INSERT INTO eval_results
           (eval_run_id, fixture_id, predicted_verdict, predicted_score, correct, reasons)
         VALUES ($1, $2, $3::verdict, $4, $5, $6::jsonb)`,
        [
          runId,
          fixtureId,
          item.predicted,
          item.score,
          item.predicted === item.label,
          JSON.stringify(item.reasons),
        ],
      );
    }

    await client.query('COMMIT');
    return runId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(argv: readonly string[]): Promise<void> {
  registerAvailablePredictors();

  const fixtureSet = flag(argv, 'fixture-set');
  if (fixtureSet === undefined || fixtureSet === '') {
    throw new Error('--fixture-set=<name> is required');
  }

  const splitRaw = flag(argv, 'split');
  if (splitRaw === undefined) {
    throw new Error('--split=dev or --split=holdout is required; there is no default');
  }
  const split = evalSplit.parse(splitRaw);

  const predictorId = flag(argv, 'predictor');
  if (predictorId === undefined || predictorId === '') {
    const real = registeredPredictors().filter((candidate) => !candidate.testOnly);
    console.error('--predictor=<id> is required. There is no default predictor.');
    console.error('');
    if (!hasRealPredictor()) {
      console.error(
        'NO REAL PREDICTOR EXISTS YET. §25 puts the rubric, the grounding filter and',
      );
      console.error(
        'the provider bake-off on Day 6; Day 5 builds the harness that will measure',
      );
      console.error(
        'them. Shipping a heuristic here and calling it a baseline would put a number',
      );
      console.error('in front of you that measures nothing.');
      console.error('');
    } else {
      console.error(`Real predictors: ${real.map((candidate) => candidate.id).join(', ')}`);
    }
    console.error(
      `Registered: ${registeredPredictors()
        .map((candidate) => `${candidate.id}${candidate.testOnly ? ' (test-only)' : ''}`)
        .join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const predictor = getPredictor(predictorId);
  if (predictor === undefined) {
    throw new Error(
      `no predictor "${predictorId}". Registered: ${registeredPredictors()
        .map((candidate) => candidate.id)
        .join(', ')}`,
    );
  }
  if (predictor.testOnly && !argv.includes('--allow-test-predictor')) {
    throw new Error(
      `"${predictorId}" is a test-only predictor: it answers from a script and reads no ` +
        'evidence. Pass --allow-test-predictor to exercise the harness with it. Its ' +
        'output is not a baseline and the report will say so.',
    );
  }

  const rubricVersion = flag(argv, 'rubric-version');
  const promptVersion = flag(argv, 'prompt-version');
  if (rubricVersion === undefined || promptVersion === undefined) {
    throw new Error(
      '--rubric-version and --prompt-version are required. §4 makes both NOT NULL on ' +
        'eval_runs, and Day 6 owns the rubric — this tool will not invent a version for it.',
    );
  }

  let pool: Pool | undefined;
  if (argv.includes('--persist')) {
    const databaseUrl = process.env.EVAL_DATABASE_URL ?? process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error('--persist needs EVAL_DATABASE_URL (or DATABASE_URL)');
    }
    const { createPool } = await import('../src/db/client');
    pool = createPool(databaseUrl);
  }

  try {
    const result = await runEval({
      fixtureSet,
      split,
      predictor,
      rubricVersion,
      promptVersion,
      allowHoldout: argv.includes('--allow-holdout'),
      allowBillable: argv.includes('--allow-billable'),
      ...(pool === undefined ? {} : { pool }),
    });

    console.log('');
    console.log(result.report);
    console.log('');
    console.log(`Report written to ${result.reportPath ?? '(not written)'}`);
    if (!result.exitCriterionMet) {
      console.log('');
      console.log(
        `DAY 5 IS NOT EXITED: ${result.labelledInSet} of ${REQUIRED_LABEL_COUNT} fixtures in ` +
          'this set carry a human label.',
      );
    }
  } finally {
    await pool?.end();
  }
}

/**
 * Only when invoked directly as a script.
 *
 * The tests import `runEval` from this file, so a bare `main()` at module scope
 * would run the CLI inside the suite. The VITEST check is explicit rather than
 * clever: it says what it is guarding against.
 */
if (process.env.VITEST === undefined && /eval[\\/]run\.ts$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
