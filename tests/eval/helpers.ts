/**
 * A scratch corpus on disk, for the eval suites.
 *
 * Every suite that writes fixtures works inside a temporary fixture set whose
 * name starts with `zz-test-`, and removes it afterwards. The corpus root is the
 * real one — the path guards are part of what is under test, and a test that
 * redirected them would be testing a different program.
 */
import { mkdirSync, rmSync } from 'node:fs';

import { canonicalJson } from '../../eval/canonical';
import { companiesDir, setDir, labelsPath, splitPath } from '../../eval/paths';
import { sanitiseToFixture, sha256 } from '../../eval/sanitise-snapshot';
import { assembleSignals } from '../../src/worker/handlers/web-extract';
import { scanTierASignals } from '../../src/fetch/signals';
import type { FixtureFile } from '../../eval/schemas';
import { writeAtomic } from '../../eval/paths';

let counter = 0;

/** A unique, obviously disposable fixture-set name. */
export function scratchSet(label = 'corpus'): string {
  counter += 1;
  return `zz-test-${label}-${process.pid}-${counter}`;
}

export function removeSet(fixtureSet: string): void {
  rmSync(setDir(fixtureSet), { recursive: true, force: true });
}

export function ensureSet(fixtureSet: string): void {
  mkdirSync(companiesDir(fixtureSet), { recursive: true });
}

/** A realistic law-firm homepage, with real Tier A markers in the markup. */
export const SAMPLE_HTML =
  '<html><head><meta name="viewport" content="width=device-width">' +
  '<script>gtag("config","AW-123456789")</script></head><body>' +
  '<h1>Harbourline Criminal Defence</h1>' +
  '<p>Drink driving, assault and bail applications across Sydney.</p>' +
  '<a href="tel:+61290001234">(02) 9000 1234</a><form></form>' +
  '<footer>&copy; 2026 Harbourline</footer></body></html>';

export function sampleSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://harbourline.example/',
    http_status: 200,
    robots_allowed: true,
    content_hash: sha256('harbourline-home'),
    bytes: 2048,
    text:
      'Harbourline Criminal Defence\nDrink driving, assault and bail applications ' +
      'across Sydney.\n(02) 9000 1234\n© 2026 Harbourline',
    signals: scanTierASignals(SAMPLE_HTML),
    page_kind: 'home',
    ...overrides,
  };
}

/** Freezes a fixture from in-memory snapshots, without a database. */
export function writeFixture(
  fixtureSet: string,
  domain: string,
  snapshots: readonly unknown[] = [sampleSnapshot()],
): FixtureFile {
  ensureSet(fixtureSet);
  const fixture = sanitiseToFixture({
    fixtureSet,
    canonicalDomain: domain,
    snapshots,
    assembleSignals,
  });
  writeAtomic(`${companiesDir(fixtureSet)}/${domain}.json`, canonicalJson(fixture));
  return fixture;
}

export function writeLabels(fixtureSet: string, labels: Record<string, unknown>): void {
  ensureSet(fixtureSet);
  writeAtomic(labelsPath(fixtureSet), canonicalJson({ fixture_set: fixtureSet, labels }));
}

export function writeSplitManifest(
  fixtureSet: string,
  assignments: Record<string, 'dev' | 'holdout'>,
): void {
  ensureSet(fixtureSet);
  writeAtomic(splitPath(fixtureSet), canonicalJson({ fixture_set: fixtureSet, assignments }));
}

export function aLabel(overrides: Record<string, unknown> = {}) {
  return {
    label: 'qualified',
    reason_codes: ['small_firm'],
    disqualifier: null,
    labelled_by: 'Kushagra',
    labelled_at: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}
