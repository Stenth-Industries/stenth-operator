/**
 * The Markdown run report (SPEC.md §21, §25 Day 5).
 *
 * Deterministic: the same run produces the same bytes, apart from the fields the
 * caller supplies (the run's timestamp and its database id). Everything else is
 * computed from the fixtures and the predictions, so two people reading the same
 * report are reading the same numbers.
 *
 * Carries no secret and no credential. The only identifiers in it are the
 * fixture set, the split, the predictor id, the model string the predictor
 * declared and the versions the operator passed — none of which is a key. There
 * is no code path here that reads an environment variable.
 */
import type { EvalMetrics, ScoredFixture } from './metrics';

export interface ReportInput {
  readonly fixtureSet: string;
  readonly split: 'dev' | 'holdout';
  readonly rubricVersion: string;
  readonly promptVersion: string;
  readonly predictorId: string;
  readonly model: string;
  readonly predictorTestOnly: boolean;
  /** ISO-8601. The one deliberately non-deterministic field. */
  readonly generatedAt: string;
  /** The eval_runs row, when the run was persisted. */
  readonly runId: string | undefined;
  readonly fixtureCount: number;
  readonly metrics: EvalMetrics;
  readonly scored: readonly ScoredFixture[];
  /** §25's exit criterion, carried so the report cannot overstate the milestone. */
  readonly labelledInSet: number;
  readonly requiredLabels: number;
}

/** Fixed-precision, or an em dash where there is genuinely no value. */
function rate(value: number | null): string {
  return value === null ? '—' : value.toFixed(4);
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function renderReport(input: ReportInput): string {
  const { metrics, metrics: { confusion } } = input;
  const lines: string[] = [];

  lines.push(`# Eval run — ${input.fixtureSet} / ${input.split}`);
  lines.push('');

  if (input.split === 'holdout') {
    lines.push('> **⚠️ HOLDOUT RUN.**');
    lines.push('>');
    lines.push(
      '> These fixtures are the measurement, not the material. Reading these ' +
        'numbers and then changing the rubric turns the holdout into a dev set, ' +
        'and §25 Day 6 derives its thresholds from this split — once.',
    );
    lines.push('');
  }

  if (input.predictorTestOnly) {
    lines.push('> **⚠️ TEST-ONLY PREDICTOR.**');
    lines.push('>');
    lines.push(
      `> This run used \`${input.predictorId}\`, which answers from a script and ` +
        'reads no evidence. It exercises the harness. It is not a baseline and ' +
        'these numbers say nothing about any firm or any rubric.',
    );
    lines.push('');
  }

  if (input.labelledInSet < input.requiredLabels) {
    lines.push('> **⚠️ DAY 5 NOT EXITED.**');
    lines.push('>');
    lines.push(
      `> ${input.labelledInSet} of ${input.requiredLabels} fixtures in this set carry a ` +
        'human label. §25 Day 5 is not complete until a person has labelled ' +
        `${input.requiredLabels}, and a baseline measured over fewer is not the baseline.`,
    );
    lines.push('');
  }

  lines.push('## Run');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| fixture set | \`${input.fixtureSet}\` |`);
  lines.push(`| split | \`${input.split}\` |`);
  lines.push(`| fixtures evaluated | ${input.fixtureCount} |`);
  lines.push(`| rubric version | \`${input.rubricVersion}\` |`);
  lines.push(`| prompt version | \`${input.promptVersion}\` |`);
  lines.push(`| predictor | \`${input.predictorId}\` |`);
  lines.push(`| model | \`${input.model}\` |`);
  lines.push(`| generated at | ${input.generatedAt} |`);
  lines.push(`| eval_runs id | ${input.runId ?? '(not persisted)'} |`);
  lines.push(`| labelled in set | ${input.labelledInSet} of ${input.requiredLabels} required |`);
  lines.push('');

  lines.push('## Metrics');
  lines.push('');
  lines.push('No target and no pass/fail. §25 Day 6 derives its thresholds from the');
  lines.push('holdout run; §10: "the run is what decides, not the argument".');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---|');
  lines.push(`| total evaluated | ${metrics.total} |`);
  lines.push(`| correct | ${metrics.correct} |`);
  lines.push(`| incorrect | ${metrics.incorrect} |`);
  lines.push(`| accuracy | ${rate(metrics.accuracy)} |`);
  lines.push(`| qualified precision | ${rate(metrics.qualifiedPrecision)} |`);
  lines.push(`| qualified recall | ${rate(metrics.qualifiedRecall)} |`);
  lines.push(`| qualified F1 | ${rate(metrics.qualifiedF1)} |`);
  lines.push(`| rejected precision | ${rate(metrics.rejectedPrecision)} |`);
  lines.push(`| rejected recall | ${rate(metrics.rejectedRecall)} |`);
  lines.push(`| rejected F1 | ${rate(metrics.rejectedF1)} |`);
  lines.push(`| predicted uncertain | ${metrics.predictedUncertain} |`);
  lines.push('');
  lines.push('An em dash is a rate whose denominator was zero. Not 0.0000: no answer.');
  lines.push('');

  lines.push('## Confusion');
  lines.push('');
  lines.push('`uncertain` is a legitimate §10 stage 7 verdict and matches no label, so it');
  lines.push('has its own row rather than being folded into either side.');
  lines.push('');
  lines.push('| | predicted qualified | predicted uncertain | predicted rejected |');
  lines.push('|---|---|---|---|');
  lines.push(
    `| **label qualified** | ${confusion.trueQualified} | ${confusion.uncertainOnQualified} | ` +
      `${confusion.falseRejected} |`,
  );
  lines.push(
    `| **label rejected** | ${confusion.falseQualified} | ${confusion.uncertainOnRejected} | ` +
      `${confusion.trueRejected} |`,
  );
  lines.push('');

  lines.push('## Cost');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| total | ${usd(metrics.totalCostUsd)} |`);
  lines.push(`| mean per fixture | ${metrics.meanCostUsd === null ? '—' : usd(metrics.meanCostUsd)} |`);
  lines.push(
    `| any cost reported | ${metrics.costReported ? 'yes' : 'no — every prediction cost $0'} |`,
  );
  lines.push('');

  const wrong = input.scored.filter((item) => item.predicted !== item.label);
  lines.push(`## Incorrect (${wrong.length})`);
  lines.push('');
  if (wrong.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| domain | expected | predicted | score | reasons |');
    lines.push('|---|---|---|---|---|');
    for (const item of wrong) {
      const reasons = item.reasons.length === 0 ? '—' : item.reasons.join('; ').replace(/\|/g, '\\|');
      lines.push(
        `| \`${item.domain}\` | ${item.label} | ${item.predicted} | ` +
          `${item.score === null ? '—' : item.score} | ${reasons} |`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * The report's filename.
 *
 * Sortable, and it says what it is without being opened. The split is in the
 * name so a holdout report cannot be mistaken for a dev one in a directory
 * listing.
 */
export function reportFilename(input: {
  readonly fixtureSet: string;
  readonly split: string;
  readonly predictorId: string;
  readonly generatedAt: string;
}): string {
  const stamp = input.generatedAt.replace(/[:.]/g, '-');
  return `${stamp}__${input.fixtureSet}__${input.split}__${input.predictorId}.md`;
}
