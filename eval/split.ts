/**
 * The dev/holdout split (SPEC.md §21, §25 Day 5).
 *
 * §25's Day 5 row says "dev/holdout split" and §21 is the fixture section. What
 * neither preserves in the repository's evidence is a **ratio**: no number of
 * dev fixtures, no percentage, nothing. So none is invented here. The operator
 * states the counts, the assignment is computed deterministically from them, and
 * the result is written to a checked-in manifest that is append-only.
 *
 * Both safe designs from the brief, together: explicit counts decide *how many*,
 * and the committed manifest decides *which*, for ever.
 *
 * ## Why no labels are consulted
 *
 * Choosing a holdout by looking at labels is how a holdout stops being one. If
 * the split knew which fixtures were `qualified` it could balance them, and a
 * balanced holdout measures a different thing from the population it is drawn
 * from — and worse, the choice would encode the ground truth into the partition,
 * which is leakage by construction. So this file never reads labels.json. It
 * cannot: it does not import it.
 *
 * ## Why append-only
 *
 * A fixture that moves from holdout to dev has been tuned against. That is the
 * one failure a holdout exists to prevent, and it would happen by accident long
 * before anyone did it on purpose — a re-run with a different count, a fixture
 * added in the middle, a rebuild nobody noticed. So assignment only ever adds:
 * domains already in the manifest keep their split, and the only way to change
 * one is `rebuild`, which says what it does and requires `--yes`.
 *
 * ## The ordering
 *
 * Unassigned domains are ordered by sha256(fixture_set + '\\n' + domain) —
 * stable across machines, independent of filesystem order, and unrelated to
 * anything a tuner could observe or to the alphabet. The first `--dev-count`
 * go to dev, the rest to holdout.
 */
import { canonicalJson } from './canonical';
import { listFixtureDomains, readSplit } from './corpus';
import { relativeToRepo, splitPath, writeAtomic } from './paths';
import { SanitiserRejection, sha256 } from './sanitise-snapshot';
import { splitFile, type EvalSplit, type SplitFile } from './schemas';

export interface AssignmentPlan {
  readonly dev: readonly string[];
  readonly holdout: readonly string[];
  /** Domains that already had a split and were left exactly as they were. */
  readonly unchanged: readonly string[];
}

/** The deterministic order unassigned domains are drawn in. */
export function assignmentOrder(fixtureSet: string, domains: readonly string[]): string[] {
  return [...domains].sort((a, b) => {
    const ha = sha256(`${fixtureSet}\n${a}`);
    const hb = sha256(`${fixtureSet}\n${b}`);
    // The hash decides; the domain breaks a tie, so the order is total.
    if (ha !== hb) {
      return ha < hb ? -1 : 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Plans an assignment without writing anything.
 *
 * Pure, so the plan can be printed, asserted and re-derived. The counts must
 * account for every unassigned domain exactly: a plan that left some fixture
 * unassigned would be a corpus where "every fixture belongs to exactly one
 * split" is false, and the runner would silently evaluate a subset.
 */
export function planAssignment(
  fixtureSet: string,
  allDomains: readonly string[],
  existing: Readonly<Record<string, EvalSplit>>,
  counts: { readonly dev: number; readonly holdout: number },
): AssignmentPlan {
  if (!Number.isInteger(counts.dev) || !Number.isInteger(counts.holdout)) {
    throw new SanitiserRejection('bad_counts', '--dev-count and --holdout-count must be integers');
  }
  if (counts.dev < 0 || counts.holdout < 0) {
    throw new SanitiserRejection('bad_counts', 'counts cannot be negative');
  }

  const unchanged = allDomains.filter((domain) => existing[domain] !== undefined).sort();
  const unassigned = allDomains.filter((domain) => existing[domain] === undefined);

  if (counts.dev + counts.holdout !== unassigned.length) {
    throw new SanitiserRejection(
      'bad_counts',
      `${unassigned.length} fixture(s) are unassigned but the counts add to ` +
        `${counts.dev + counts.holdout}. Every fixture must land in exactly one split, ` +
        'so state counts that account for all of them',
    );
  }

  const ordered = assignmentOrder(fixtureSet, unassigned);
  return {
    dev: ordered.slice(0, counts.dev),
    holdout: ordered.slice(counts.dev),
    unchanged,
  };
}

export interface AssignResult {
  readonly plan: AssignmentPlan;
  readonly manifest: SplitFile;
  readonly path: string;
  readonly written: boolean;
}

/**
 * Applies a plan to the manifest on disk.
 *
 * Refuses to move anything. The check is explicit rather than implied by the
 * merge order, because "the new value wins" is the default behaviour of every
 * object spread in the language and this is precisely the place it must not.
 */
export function assignSplit(
  fixtureSet: string,
  counts: { readonly dev: number; readonly holdout: number },
  options: { readonly dryRun?: boolean } = {},
): AssignResult {
  const domains = listFixtureDomains(fixtureSet);
  if (domains.length === 0) {
    throw new SanitiserRejection(
      'empty_set',
      `fixture set "${fixtureSet}" has no frozen fixtures; freeze some first`,
    );
  }

  const current = readSplit(fixtureSet);
  const plan = planAssignment(fixtureSet, domains, current.assignments, counts);

  const assignments: Record<string, EvalSplit> = { ...current.assignments };
  for (const domain of plan.dev) {
    assignments[domain] = 'dev';
  }
  for (const domain of plan.holdout) {
    assignments[domain] = 'holdout';
  }

  for (const [domain, split] of Object.entries(current.assignments)) {
    if (assignments[domain] !== split) {
      throw new SanitiserRejection(
        'split_would_move',
        `${domain} is already ${split}; a split is append-only. Use "rebuild --yes" ` +
          'if you genuinely mean to discard the assignment',
      );
    }
  }

  const manifest = splitFile.parse({ fixture_set: fixtureSet, assignments });
  const path = splitPath(fixtureSet);
  if (options.dryRun !== true) {
    writeManifest(fixtureSet, manifest);
  }
  return { plan, manifest, path: relativeToRepo(path), written: options.dryRun !== true };
}

/**
 * The manifest is replaced rather than appended to, so the file on disk is
 * always the whole truth. `writeAtomic` renames over the destination, which is
 * atomic within one directory on every filesystem this runs on — a reader
 * either sees the old manifest or the new one, never a partial merge.
 */
function writeManifest(fixtureSet: string, manifest: SplitFile): void {
  writeAtomic(splitPath(fixtureSet), canonicalJson(manifest));
}

/** Discards the manifest. Deliberately separate, deliberately loud. */
export function rebuildSplit(fixtureSet: string): { readonly path: string } {
  writeManifest(fixtureSet, splitFile.parse({ fixture_set: fixtureSet, assignments: {} }));
  return { path: relativeToRepo(splitPath(fixtureSet)) };
}

export interface SplitAudit {
  readonly total: number;
  readonly dev: number;
  readonly holdout: number;
  readonly unassigned: readonly string[];
  readonly orphaned: readonly string[];
  readonly overlapping: readonly string[];
}

/**
 * What the manifest says, checked against what is on disk.
 *
 * `overlapping` can only ever be empty — the manifest is a map, so one domain
 * has one value and the type system will not let it have two. It is reported
 * anyway because "no fixture is in both splits" is a property the corpus is
 * supposed to have, and a property nobody checks is a property nobody notices
 * losing when the representation changes.
 */
export function auditSplit(fixtureSet: string): SplitAudit {
  const domains = listFixtureDomains(fixtureSet);
  const { assignments } = readSplit(fixtureSet);
  const known = new Set(domains);

  const dev = Object.entries(assignments).filter(([, value]) => value === 'dev');
  const holdout = Object.entries(assignments).filter(([, value]) => value === 'holdout');
  const assignedDomains = new Set(Object.keys(assignments));

  return {
    total: domains.length,
    dev: dev.filter(([domain]) => known.has(domain)).length,
    holdout: holdout.filter(([domain]) => known.has(domain)).length,
    unassigned: domains.filter((domain) => !assignedDomains.has(domain)),
    orphaned: [...assignedDomains].filter((domain) => !known.has(domain)).sort(),
    overlapping: dev.map(([domain]) => domain).filter((domain) =>
      holdout.some(([other]) => other === domain),
    ),
  };
}
