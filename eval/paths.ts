/**
 * Where the corpus lives on disk, and how it is written.
 *
 * ```text
 * eval/fixtures/<fixture-set>/
 *   companies/<domain>.json   one frozen fixture: immutable evidence
 *   labels.json               the human's decisions, with who and when
 *   split.json                dev or holdout per domain, checked in
 * ```
 *
 * Three files rather than one, because they have three different lifetimes. A
 * fixture must not change when someone labels it; a label must not change when
 * the split is rebuilt; and the split must be reviewable in a diff without a
 * page of text beside it.
 *
 * Every path this module returns is inside the fixture root, and every write is
 * atomic: a temporary file in the destination directory, then a rename. A
 * half-written fixture that still parses is worse than no fixture at all, and
 * an interrupted freeze must leave the corpus exactly as it was.
 */
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { SanitiserRejection } from './sanitise-snapshot';
import { fixtureSetName } from './schemas';

/** The repository root, from this file's own location. */
export function repoRoot(): string {
  return resolve(__dirname, '..');
}

export function fixtureRoot(): string {
  return join(repoRoot(), 'eval', 'fixtures');
}

export function reportRoot(): string {
  return join(repoRoot(), 'eval', 'reports');
}

/** Validated here so no caller can turn a set name into a directory traversal. */
export function setDir(fixtureSet: string): string {
  const parsed = fixtureSetName.safeParse(fixtureSet);
  if (!parsed.success) {
    throw new SanitiserRejection(
      'unsafe_fixture_set',
      `"${fixtureSet}" is not a fixture-set name (lower-case letters, digits, hyphens)`,
    );
  }
  return join(fixtureRoot(), parsed.data);
}

export function companiesDir(fixtureSet: string): string {
  return join(setDir(fixtureSet), 'companies');
}

export function labelsPath(fixtureSet: string): string {
  return join(setDir(fixtureSet), 'labels.json');
}

export function splitPath(fixtureSet: string): string {
  return join(setDir(fixtureSet), 'split.json');
}

/**
 * A repository-relative path, for `eval_fixtures.snapshot_path` and for printing.
 *
 * Relative because an absolute path is a property of one machine, and the DB row
 * has to mean the same thing on the next one.
 */
export function relativeToRepo(absolute: string): string {
  return relative(repoRoot(), absolute).split(sep).join('/');
}

/**
 * Refuses any path that is not genuinely inside the fixture root.
 *
 * The last line of defence rather than the first: filenames are already derived
 * through an allowlist. This catches the case the allowlist cannot see — a
 * symlink inside the corpus pointing out of it — by resolving the real path of
 * the nearest existing ancestor before comparing.
 */
export function assertInsideFixtureRoot(candidate: string): string {
  const root = realpathSync(fixtureRoot());
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);

  // Walk up to the nearest directory that exists, so a path being created is
  // judged by where it would land rather than refused for not existing yet.
  let probe = dirname(absolute);
  for (;;) {
    try {
      probe = realpathSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        throw new SanitiserRejection('unsafe_path', `${candidate} has no existing ancestor`);
      }
      probe = parent;
    }
  }

  if (probe !== root && !probe.startsWith(root + sep)) {
    throw new SanitiserRejection(
      'unsafe_path',
      `${candidate} resolves to ${probe}, which is outside ${root}`,
    );
  }
  return absolute;
}

/**
 * Writes one file atomically, inside the fixture root.
 *
 * `wx` on the temporary file, so two freezes running at once cannot interleave
 * into one output, and the rename is the only moment the corpus changes.
 */
export function writeAtomic(path: string, contents: string): void {
  const absolute = assertInsideFixtureRoot(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, absolute);
}
