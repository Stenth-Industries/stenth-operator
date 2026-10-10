/**
 * The frozen fixture format (SPEC.md §21, §25 Day 5).
 *
 * The corpus is the ground truth Day 6's thresholds will be derived from, so the
 * format is strict on purpose: a fixture that parses when it should not is a
 * silent change to the measurement.
 */
import { describe, expect, it } from 'vitest';

import { canonicalCompact, canonicalJson } from '../../eval/canonical';
import { SanitiserRejection, parseFixture, sha256 } from '../../eval/sanitise-snapshot';
import {
  FIXTURE_FORMAT_VERSION,
  MAX_FIXTURE_BYTES,
  MAX_PAGES_PER_FIXTURE,
  fixtureFile,
} from '../../eval/schemas';
import { sampleSnapshot } from './helpers';
import { sanitiseToFixture } from '../../eval/sanitise-snapshot';
import { assembleSignals } from '../../src/worker/handlers/web-extract';

function freeze(snapshots: readonly unknown[], domain = 'harbourline.example') {
  return sanitiseToFixture({
    fixtureSet: 'zz-format',
    canonicalDomain: domain,
    snapshots,
    assembleSignals,
  });
}

describe('a valid fixture', () => {
  it('carries the version, a derived id, the pages and a content digest', () => {
    const fixture = freeze([sampleSnapshot()]);

    expect(fixture.fixture_format_version).toBe(FIXTURE_FORMAT_VERSION);
    expect(fixture.fixture_set).toBe('zz-format');
    expect(fixture.canonical_domain).toBe('harbourline.example');
    expect(fixture.extraction_schema_version).toBe('extraction-v1');
    expect(fixture.pages).toHaveLength(1);
    expect(fixture.content_digest).toMatch(/^[0-9a-f]{64}$/);
    // Derived from the set and the domain, never a runtime uuid.
    expect(fixture.fixture_id).toBe(sha256('zz-format\nharbourline.example').slice(0, 32));
    expect(fixtureFile.safeParse(fixture).success).toBe(true);
  });

  it('round-trips through the parser, digest and all', () => {
    const fixture = freeze([sampleSnapshot()]);
    expect(parseFixture(canonicalJson(fixture), 'test')).toStrictEqual(fixture);
  });

  it('holds several pages for one domain, in deterministic URL order', () => {
    const fixture = freeze([
      sampleSnapshot({ url: 'https://harbourline.example/team', page_kind: 'team' }),
      sampleSnapshot({ url: 'https://harbourline.example/', page_kind: 'home' }),
      sampleSnapshot({ url: 'https://harbourline.example/contact', page_kind: 'contact' }),
    ]);
    expect(fixture.pages.map((page) => page.url)).toStrictEqual([
      'https://harbourline.example/',
      'https://harbourline.example/contact',
      'https://harbourline.example/team',
    ]);
  });

  it('carries no unstable operational metadata', () => {
    const fixture = freeze([sampleSnapshot()]);
    const keys = (value: unknown): string[] =>
      value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)])
        : [];
    const present = new Set(keys(fixture));
    // No row ids, no trace ids, no timestamps — including no freeze timestamp,
    // so re-freezing unchanged evidence is byte-identical.
    for (const forbidden of [
      'id',
      'company_id',
      'snapshot_id',
      'trace_id',
      'created_at',
      'updated_at',
      'fetched_at',
      'text_pruned_at',
      'locked_by',
      'frozen_at',
      'job_id',
    ]) {
      expect(present.has(forbidden), forbidden).toBe(false);
    }
  });
});

describe('a malformed fixture is rejected, not repaired', () => {
  const valid = freeze([sampleSnapshot()]);

  it('refuses an unknown key', () => {
    const tampered = { ...valid, extra_field: 'surprise' };
    expect(() => parseFixture(canonicalJson(tampered), 'test')).toThrow(SanitiserRejection);
  });

  it('refuses a missing required field', () => {
    for (const key of [
      'fixture_format_version',
      'fixture_id',
      'fixture_set',
      'canonical_domain',
      'pages',
      'content_digest',
    ] as const) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[key];
      expect(() => parseFixture(canonicalJson(partial), 'test'), key).toThrow(/invalid_fixture/);
    }
  });

  it('refuses a wrong format version', () => {
    expect(() =>
      parseFixture(canonicalJson({ ...valid, fixture_format_version: 'eval-fixture-v2' }), 'test'),
    ).toThrow(/invalid_fixture/);
  });

  it('refuses a digest that does not match the pages', () => {
    const tampered = {
      ...valid,
      pages: [{ ...valid.pages[0], text: 'rewritten by hand' }],
    };
    // The schema is satisfied; the integrity field is not. That is the point of
    // having both.
    expect(fixtureFile.safeParse(tampered).success).toBe(true);
    expect(() => parseFixture(canonicalJson(tampered), 'test')).toThrow(/digest_mismatch/);
  });

  it('refuses a fixture id that was not derived from the set and the domain', () => {
    expect(() =>
      parseFixture(canonicalJson({ ...valid, fixture_id: 'f'.repeat(32) }), 'test'),
    ).toThrow(/fixture_id_mismatch/);
  });

  it('refuses malformed JSON', () => {
    for (const raw of ['{', 'not json', '', '[1,2,3,', '{"a":']) {
      expect(() => parseFixture(raw, 'test'), JSON.stringify(raw)).toThrow(/malformed_json/);
    }
  });

  it('refuses an oversized file before parsing it', () => {
    const huge = `{"padding":"${'x'.repeat(MAX_FIXTURE_BYTES + 100)}"}`;
    expect(() => parseFixture(huge, 'test')).toThrow(/fixture_too_large/);
  });

  it('refuses more pages than §10 stage 3 can fetch', () => {
    const pages = Array.from({ length: MAX_PAGES_PER_FIXTURE + 1 }, (_u, index) =>
      sampleSnapshot({ url: `https://harbourline.example/p${index}` }),
    );
    expect(() => freeze(pages)).toThrow(/too_many_pages/);
  });

  it('refuses a fixture with no evidence at all', () => {
    expect(() => freeze([])).toThrow(/no_evidence/);
  });

  it('refuses a page whose text is over the cap', () => {
    expect(() => freeze([sampleSnapshot({ text: 'a'.repeat(200_001) })])).toThrow(
      /page_too_large/,
    );
  });

  it('refuses a source row with an unknown column', () => {
    expect(() => freeze([{ ...sampleSnapshot(), company_id: 'leaked' }])).toThrow(
      /malformed_snapshot/,
    );
  });
});

describe('canonical JSON', () => {
  it('sorts keys, so the same data is always the same bytes', () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });

  it('keeps array order, because in a fixture it is data', () => {
    expect(canonicalCompact({ pages: ['b', 'a'] })).toBe('{"pages":["b","a"]}');
  });

  it('drops undefined rather than letting it change the bytes', () => {
    expect(canonicalCompact({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
