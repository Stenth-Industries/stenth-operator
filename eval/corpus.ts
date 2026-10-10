/**
 * Reading the corpus: fixtures, labels and the split, as three files.
 *
 * Every read goes through the schemas, every failure is loud, and nothing here
 * writes. The commands that write (freeze, label, split) each own their own
 * mutation; this is the shared view they and the runner read.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SanitiserRejection, parseFixture } from './sanitise-snapshot';
import {
  companiesDir,
  labelsPath,
  relativeToRepo,
  splitPath,
  assertInsideFixtureRoot,
} from './paths';
import {
  labelsFile,
  splitFile,
  type EvalSplit,
  type FixtureFile,
  type FixtureLabel,
  type LabelsFile,
  type SplitFile,
} from './schemas';

export interface LoadedFixture {
  readonly fixture: FixtureFile;
  /** Repository-relative, which is what eval_fixtures.snapshot_path holds. */
  readonly path: string;
  readonly label: FixtureLabel | undefined;
  readonly split: EvalSplit | undefined;
}

/** Every fixture file in a set, in domain order. Deterministic by construction. */
export function listFixtureDomains(fixtureSet: string): string[] {
  const dir = companiesDir(fixtureSet);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

export function readLabels(fixtureSet: string): LabelsFile {
  const path = labelsPath(fixtureSet);
  if (!existsSync(path)) {
    return { fixture_set: fixtureSet, labels: {} };
  }
  const parsed = labelsFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new SanitiserRejection(
      'invalid_labels',
      `${relativeToRepo(path)}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (parsed.data.fixture_set !== fixtureSet) {
    throw new SanitiserRejection(
      'invalid_labels',
      `${relativeToRepo(path)} belongs to fixture set ${parsed.data.fixture_set}`,
    );
  }
  return parsed.data;
}

export function readSplit(fixtureSet: string): SplitFile {
  const path = splitPath(fixtureSet);
  if (!existsSync(path)) {
    return { fixture_set: fixtureSet, assignments: {} };
  }
  const parsed = splitFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new SanitiserRejection(
      'invalid_split',
      `${relativeToRepo(path)}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (parsed.data.fixture_set !== fixtureSet) {
    throw new SanitiserRejection(
      'invalid_split',
      `${relativeToRepo(path)} belongs to fixture set ${parsed.data.fixture_set}`,
    );
  }
  return parsed.data;
}

/** One fixture, with whatever label and split assignment it has. */
export function loadFixture(fixtureSet: string, domain: string): LoadedFixture {
  const path = assertInsideFixtureRoot(join(companiesDir(fixtureSet), `${domain}.json`));
  if (!existsSync(path)) {
    throw new SanitiserRejection('missing_fixture', `${relativeToRepo(path)} does not exist`);
  }
  const fixture = parseFixture(readFileSync(path, 'utf8'), relativeToRepo(path));
  if (fixture.fixture_set !== fixtureSet || fixture.canonical_domain !== domain) {
    throw new SanitiserRejection(
      'fixture_misfiled',
      `${relativeToRepo(path)} declares ${fixture.fixture_set}/${fixture.canonical_domain}`,
    );
  }
  return {
    fixture,
    path: relativeToRepo(path),
    label: readLabels(fixtureSet).labels[domain],
    split: readSplit(fixtureSet).assignments[domain],
  };
}

/** The whole set, read once, in domain order. */
export function loadCorpus(fixtureSet: string): LoadedFixture[] {
  const labels = readLabels(fixtureSet);
  const split = readSplit(fixtureSet);
  return listFixtureDomains(fixtureSet).map((domain) => {
    const path = assertInsideFixtureRoot(join(companiesDir(fixtureSet), `${domain}.json`));
    const fixture = parseFixture(readFileSync(path, 'utf8'), relativeToRepo(path));
    if (fixture.canonical_domain !== domain) {
      throw new SanitiserRejection(
        'fixture_misfiled',
        `${relativeToRepo(path)} declares domain ${fixture.canonical_domain}`,
      );
    }
    return {
      fixture,
      path: relativeToRepo(path),
      label: labels.labels[domain],
      split: split.assignments[domain],
    };
  });
}
