/**
 * eval/status.ts — labelling progress against §25's Day 5 exit criterion.
 *
 *   npm run eval:status -- --fixture-set=<set>
 *
 * Read-only, offline, no database. The corpus on disk is the source of truth and
 * this prints what it says: how many fixtures exist, how many a human has
 * labelled, the split, and whether sixty has been reached. It never rounds up
 * and it never calls 59 done.
 */
import { auditSplit } from './split';
import { labelStatus, REQUIRED_LABEL_COUNT } from './label';

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function renderStatus(fixtureSet: string): string {
  const status = labelStatus(fixtureSet);
  const split = auditSplit(fixtureSet);
  const lines: string[] = [
    '',
    `Fixture set: ${fixtureSet}`,
    '',
    `  fixtures        ${status.total}`,
    `  labelled        ${status.labelled}`,
    `  unlabelled      ${status.unlabelled}`,
    `    qualified     ${status.qualified}`,
    `    rejected      ${status.rejected}`,
    '',
    `  dev             ${status.dev}`,
    `  holdout         ${status.holdout}`,
    `  unassigned      ${status.unassigned}`,
    '',
    `  labelled by     ${status.labellers.length === 0 ? '(nobody yet)' : status.labellers.join(', ')}`,
    '',
  ];

  if (split.orphaned.length > 0) {
    lines.push(
      `  WARNING: ${split.orphaned.length} split assignment(s) name a fixture that is not ` +
        `on disk: ${split.orphaned.join(', ')}`,
    );
    lines.push('');
  }
  if (split.overlapping.length > 0) {
    lines.push(`  WARNING: ${split.overlapping.join(', ')} appear in both splits`);
    lines.push('');
  }

  lines.push(
    status.exitCriterionMet
      ? `  §25 Day 5 label criterion: MET (${status.labelled} of ${REQUIRED_LABEL_COUNT}).`
      : `  §25 Day 5 label criterion: NOT MET. ${status.labelled} of ${REQUIRED_LABEL_COUNT} ` +
        `human labels; ${REQUIRED_LABEL_COUNT - status.labelled} to go.`,
  );
  if (!status.exitCriterionMet && status.unlabelledDomains.length > 0) {
    lines.push('');
    lines.push('  Unlabelled:');
    for (const domain of status.unlabelledDomains) {
      lines.push(`    ${domain}`);
    }
  }
  lines.push('');
  lines.push(
    '  Day 5 is exited when a person has labelled 60 real fixtures AND a baseline has',
  );
  lines.push('  been measured over them with a real Day 6 predictor. Neither is automatic.');
  lines.push('');

  return lines.join('\n');
}

if (process.env.VITEST === undefined && /eval[\\/]status\.ts$/.test(process.argv[1] ?? '')) {
  try {
    const fixtureSet = flag(process.argv.slice(2), 'fixture-set');
    if (fixtureSet === undefined || fixtureSet === '') {
      throw new Error('--fixture-set=<name> is required');
    }
    console.log(renderStatus(fixtureSet));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
