/**
 * eval/split-cli.ts — assigning dev and holdout (§25 Day 5).
 *
 *   npm run eval:split -- --fixture-set=<set> --dev-count=40 --holdout-count=20
 *   npm run eval:split -- --fixture-set=<set> --dev-count=40 --holdout-count=20 --dry-run
 *   npm run eval:split -- --fixture-set=<set> --rebuild --yes
 *
 * The counts are required because the repository preserves no authoritative
 * dev/holdout ratio and this tool will not invent one. The assignment they
 * produce is deterministic and then permanent — see eval/split.ts for why
 * append-only matters more than it sounds.
 */
import { auditSplit, assignSplit, rebuildSplit } from './split';

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function main(argv: readonly string[]): void {
  const fixtureSet = flag(argv, 'fixture-set');
  if (fixtureSet === undefined || fixtureSet === '') {
    throw new Error('--fixture-set=<name> is required');
  }

  if (argv.includes('--rebuild')) {
    if (!argv.includes('--yes')) {
      throw new Error(
        'A rebuild discards the split. Every fixture becomes unassigned and may land ' +
          'in a different half, which means anything measured against the old holdout ' +
          'was measured against a holdout that no longer exists. Pass --yes.',
      );
    }
    const { path } = rebuildSplit(fixtureSet);
    console.log(`Split discarded. ${path} is now empty; assign again.`);
    return;
  }

  if (argv.includes('--audit')) {
    const audit = auditSplit(fixtureSet);
    console.log('');
    console.log(`  fixtures     ${audit.total}`);
    console.log(`  dev          ${audit.dev}`);
    console.log(`  holdout      ${audit.holdout}`);
    console.log(`  unassigned   ${audit.unassigned.length}`);
    console.log(`  orphaned     ${audit.orphaned.length}`);
    console.log(`  in both      ${audit.overlapping.length}`);
    console.log('');
    return;
  }

  const dev = Number(flag(argv, 'dev-count'));
  const holdout = Number(flag(argv, 'holdout-count'));
  if (!Number.isInteger(dev) || !Number.isInteger(holdout)) {
    throw new Error(
      '--dev-count and --holdout-count are both required, as integers. The repository ' +
        'preserves no authoritative dev/holdout ratio, so this tool will not pick one.',
    );
  }

  const dryRun = argv.includes('--dry-run');
  const result = assignSplit(fixtureSet, { dev, holdout }, { dryRun });

  console.log('');
  console.log(`  dev       ${result.plan.dev.length} newly assigned`);
  for (const domain of [...result.plan.dev].sort()) {
    console.log(`              ${domain}`);
  }
  console.log(`  holdout   ${result.plan.holdout.length} newly assigned`);
  for (const domain of [...result.plan.holdout].sort()) {
    console.log(`              ${domain}`);
  }
  console.log(`  unchanged ${result.plan.unchanged.length} already assigned, left alone`);
  console.log('');
  console.log(
    dryRun ? `Nothing written (--dry-run). Would write ${result.path}.` : `Written to ${result.path}.`,
  );
  console.log('Commit that file: the assignment is the corpus’s, not this machine’s.');
}

if (process.env.VITEST === undefined && /eval[\\/]split-cli\.ts$/.test(process.argv[1] ?? '')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
