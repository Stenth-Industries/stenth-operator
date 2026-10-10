/**
 * eval/label-cli.ts — the labelling command (§25 Day 5).
 *
 *   npm run eval:label -- --fixture-set=<set> --show=<domain>
 *   npm run eval:label -- --fixture-set=<set> --next
 *   npm run eval:label -- --fixture-set=<set> --domain=<d> --label=qualified \
 *     --by="Kushagra" --reasons=small_firm,no_aw_tag --disqualifier=""
 *
 * `--show` prints the frozen evidence for one fixture; `--next` prints the first
 * unlabelled one. Then the human decides and says so on the command line.
 *
 * Deliberately not interactive. A prompt that accepts a keypress is a prompt
 * that can be held down, and this writes ground truth: §25's Day 5 exit
 * criterion is sixty decisions a person actually made. Every label is one
 * command, in shell history, with a name attached.
 *
 * The verb is always explicit. Nothing here infers, suggests or pre-fills a
 * label, and there is no model call anywhere in this file.
 */
import { labellingBrief, labelStatus, recordLabel } from './label';
import { listFixtureDomains, readLabels } from './corpus';
import { evalLabel } from './schemas';

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function nextUnlabelled(fixtureSet: string): string | undefined {
  const { labels } = readLabels(fixtureSet);
  return listFixtureDomains(fixtureSet).find((domain) => labels[domain] === undefined);
}

function main(argv: readonly string[]): void {
  const fixtureSet = flag(argv, 'fixture-set');
  if (fixtureSet === undefined || fixtureSet === '') {
    throw new Error('--fixture-set=<name> is required');
  }

  const show = flag(argv, 'show');
  if (show !== undefined) {
    console.log(labellingBrief(fixtureSet, show));
    return;
  }

  if (argv.includes('--next')) {
    const domain = nextUnlabelled(fixtureSet);
    if (domain === undefined) {
      const status = labelStatus(fixtureSet);
      console.log(
        `Every fixture in ${fixtureSet} is labelled (${status.labelled}). ` +
          (status.exitCriterionMet
            ? '§25 Day 5’s label criterion is met.'
            : `That is still short of the ${status.required} §25 Day 5 requires — freeze more.`),
      );
      return;
    }
    console.log(labellingBrief(fixtureSet, domain));
    console.log('');
    console.log('To record a decision:');
    console.log(
      `  npm run eval:label -- --fixture-set=${fixtureSet} --domain=${domain} ` +
        '--label=<qualified|rejected> --by="<your name>" [--reasons=a,b] [--disqualifier="..."]',
    );
    return;
  }

  const domain = flag(argv, 'domain');
  const label = flag(argv, 'label');
  const by = flag(argv, 'by');

  if (domain === undefined || label === undefined || by === undefined) {
    throw new Error(
      'to label: --domain=<d> --label=<qualified|rejected> --by="<name>". ' +
        'To look first: --show=<d> or --next. Nothing here guesses a label.',
    );
  }

  const parsedLabel = evalLabel.safeParse(label);
  if (!parsedLabel.success) {
    throw new Error(
      `--label must be "qualified" or "rejected" (§4 eval_label), not "${label}". ` +
        'A predictor may answer "uncertain"; ground truth may not.',
    );
  }

  const reasons = flag(argv, 'reasons');
  const disqualifier = flag(argv, 'disqualifier');

  const result = recordLabel({
    fixtureSet,
    domain,
    label: parsedLabel.data,
    reasonCodes: reasons === undefined || reasons === '' ? [] : reasons.split(','),
    disqualifier: disqualifier === undefined || disqualifier === '' ? null : disqualifier,
    labelledBy: by,
    replace: argv.includes('--replace'),
  });

  console.log('');
  if (result.replaced !== undefined) {
    console.log(
      `REPLACED a human decision: ${domain} was "${result.replaced.label}" by ` +
        `${result.replaced.labelled_by} at ${result.replaced.labelled_at}.`,
    );
  }
  console.log(
    `${domain}: ${result.label.label} by ${result.label.labelled_by} at ${result.label.labelled_at}`,
  );
  if (result.label.reason_codes.length > 0) {
    console.log(`  reasons: ${result.label.reason_codes.join(', ')}`);
  }
  if (result.label.disqualifier !== null) {
    console.log(`  disqualifier: ${result.label.disqualifier}`);
  }
  console.log(`  written to ${result.path}`);

  const status = labelStatus(fixtureSet);
  console.log('');
  console.log(
    `${status.labelled} of ${status.required} labelled` +
      (status.exitCriterionMet ? '. §25 Day 5’s label criterion is met.' : '.'),
  );
}

if (process.env.VITEST === undefined && /eval[\\/]label-cli\.ts$/.test(process.argv[1] ?? '')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
