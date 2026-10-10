/**
 * The eval snapshot sanitiser (SPEC.md §21, §25 Day 5).
 *
 * Not src/ai/sanitise.ts, which cleans model output. This one turns a stored
 * snapshot into a frozen fixture, and the properties that matter are stability
 * (the same row always produces the same bytes), boundedness, path safety, and
 * not quietly changing what the evidence says.
 */
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../eval/canonical';
import {
  SanitiserRejection,
  fixtureIdFor,
  normaliseFixtureText,
  safeFixtureFilename,
  sanitiseToFixture,
} from '../../eval/sanitise-snapshot';
import { scanTierASignals } from '../../src/fetch/signals';
import { assembleSignals } from '../../src/worker/handlers/web-extract';
import { SAMPLE_HTML, sampleSnapshot } from './helpers';

function freeze(snapshots: readonly unknown[], domain = 'harbourline.example') {
  return sanitiseToFixture({
    fixtureSet: 'zz-sanitise',
    canonicalDomain: domain,
    snapshots,
    assembleSignals,
  });
}

describe('control characters and line endings', () => {
  it('normalises line endings without changing the words', () => {
    expect(normaliseFixtureText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('strips C0 and C1 controls but keeps tabs and newlines', () => {
    const hostile = 'Smith\u0000 Legal\u0007\u001b[31m\u009bred\u007f';
    expect(normaliseFixtureText(hostile)).toBe('Smith Legal[31mred');
    expect(normaliseFixtureText('a\tb\nc')).toBe('a\tb\nc');
  });

  it('collapses blank-line runs and trailing whitespace, which only move hashes', () => {
    expect(normaliseFixtureText('a   \n\n\n\nb \t\n')).toBe('a\n\nb');
  });

  it('leaves legitimate non-ASCII text alone', () => {
    // A real firm's name is evidence. "Sanitise" is not "ASCII-ify".
    for (const text of ['Müller & Co Lawyers', 'Tāmaki Legal', 'Ñuñez Defence', '“quoted”']) {
      expect(normaliseFixtureText(text), text).toBe(text);
    }
  });

  it('makes two pages that differ only in invisible noise hash identically', () => {
    const clean = freeze([sampleSnapshot({ text: 'Harbourline Defence\nSydney' })]);
    const noisy = freeze([
      sampleSnapshot({ text: 'Harbourline Defence  \r\n\r\n\r\nSydney\u0000 \t' }),
    ]);
    expect(noisy.pages[0]?.text).toBe('Harbourline Defence\n\nSydney');
    expect(clean.pages[0]?.text_sha256).not.toBe(noisy.pages[0]?.text_sha256);
    // And the stability claim that matters: the same input twice is identical.
    expect(canonicalJson(freeze([sampleSnapshot()]))).toBe(
      canonicalJson(freeze([sampleSnapshot()])),
    );
  });
});

describe('fixture filenames cannot escape the corpus', () => {
  it('accepts a real registrable domain', () => {
    expect(safeFixtureFilename('harbourline.example')).toBe('harbourline.example.json');
    expect(safeFixtureFilename('  Firm.Com.Au  ')).toBe('firm.com.au.json');
  });

  it('refuses path traversal in every shape', () => {
    for (const hostile of [
      '../../etc/passwd',
      '..',
      '../firm.com.au',
      'firm.com.au/../../etc/passwd',
      '/etc/passwd',
      'C:\\windows\\system32',
      'firm.com.au/../..',
      './firm.com.au',
      'firm.com.au\\..\\..\\x',
    ]) {
      expect(() => safeFixtureFilename(hostile), hostile).toThrow(SanitiserRejection);
    }
  });

  it('refuses separators, null bytes and shell metacharacters', () => {
    for (const hostile of [
      'firm.com.au\u0000.json',
      'firm.com.au/x',
      'firm.com.au\\x',
      'firm com au',
      'firm.com.au;rm -rf /',
      'firm.com.au$(whoami)',
      '$HOME/firm.com.au',
      'firm.com.au\n../x',
    ]) {
      expect(() => safeFixtureFilename(hostile), hostile).toThrow(SanitiserRejection);
    }
  });

  it('refuses anything that is not its own registrable domain', () => {
    // A fixture is keyed on §4 canonical_domain, so a host is not a fixture key:
    // www.firm.com.au and firm.com.au are one firm and must not be two files.
    for (const host of ['www.firm.com.au', 'nsw.firm.com.au', 'com.au', 'localhost']) {
      expect(() => safeFixtureFilename(host), host).toThrow(/unsafe_domain/);
    }
  });

  it('refuses an IP address and a lookalike that is not the same domain', () => {
    expect(() => safeFixtureFilename('203.0.113.10')).toThrow(/is an IP address/);
    // A Cyrillic homoglyph has a different registrable domain and a non-ASCII
    // filename; both are refused, and the second is what keeps the disk safe.
    expect(() => safeFixtureFilename('h\u0430rbourline.example')).toThrow(/unsafe_domain/);
  });

  it('refuses a domain long enough to break a filesystem', () => {
    const long = `${'a'.repeat(250)}.example`;
    expect(() => safeFixtureFilename(long)).toThrow(/unsafe_domain/);
  });

  it('is checked before any snapshot is read', () => {
    // The guard runs on the way in, so an unsafe domain cannot reach the disk
    // even if a later step is reordered.
    expect(() => freeze([sampleSnapshot()], '../escape')).toThrow(/unsafe_domain/);
  });
});

describe('Tier A signals are preserved, including the unknown/absent distinction', () => {
  it('keeps what the scanner found, in production’s own presence mapping', () => {
    const fixture = freeze([sampleSnapshot({ signals: scanTierASignals(SAMPLE_HTML) })]);
    const signals = fixture.pages[0]?.signals;
    expect(signals?.paid_search_tag).toBe('present');
    expect(signals?.tel_link).toBe('present');
    expect(signals?.contact_form).toBe('present');
    expect(signals?.responsive_viewport).toBe('present');
    expect(signals?.copyright_year).toBe(2026);
    // §9: in Tier A this is always unknown, and it is not the model's to answer.
    expect(signals?.currently_advertising).toBe('unknown');
  });

  it('records absent only where the scanner actually looked', () => {
    const bare = freeze([
      sampleSnapshot({ signals: scanTierASignals('<html><body><p>Nothing</p></body></html>') }),
    ]);
    const signals = bare.pages[0]?.signals;
    expect(signals?.paid_search_tag).toBe('absent');
    expect(signals?.analytics_ga4).toBe('absent');
    expect(signals?.tel_link).toBe('absent');
  });

  it('keeps unknown distinct from absent when no scanner looked', () => {
    // §10 pays 35 points for absence, so collapsing these would hand those
    // points to a company nobody scanned. The whole reason this test exists.
    const unscanned = freeze([sampleSnapshot({ signals: null })]);
    expect(unscanned.pages[0]?.signals).toBeNull();

    const bare = freeze([sampleSnapshot({ signals: scanTierASignals('<html></html>') })]);
    expect(bare.pages[0]?.signals?.paid_search_tag).toBe('absent');
    expect(unscanned.pages[0]?.signals).not.toStrictEqual(bare.pages[0]?.signals);
  });

  it('treats an unrecognisable signals blob as no scan, never as nothing found', () => {
    for (const junk of [{}, { signals_version: 'x' }, [], 'nonsense', 42, { paid_search_tag: 1 }]) {
      const fixture = freeze([sampleSnapshot({ signals: junk })]);
      expect(fixture.pages[0]?.signals, JSON.stringify(junk)).toBeNull();
    }
  });
});

describe('legitimate evidence is preserved', () => {
  it('keeps published names, phone numbers and business addresses in page text', () => {
    // §9 freezes contact discovery to "names, roles and addresses published on
    // pages the fetcher stored", and §10's reachability dimension is scored from
    // exactly that. Stripping it would make the corpus unable to measure the
    // thing it exists to measure.
    const text =
      'Jane Smith, Managing Partner\nreception@harbourline.example\n' +
      '(02) 9000 1234\nLevel 4, 1 George Street, Sydney NSW 2000';
    const fixture = freeze([sampleSnapshot({ text })]);
    expect(fixture.pages[0]?.text).toBe(text);
  });

  it('keeps a text-free row as text null, and never invents a page', () => {
    // A robots refusal and a 4xx diagnostic row are real states of the corpus.
    const robots = freeze([
      sampleSnapshot({ text: null, http_status: null, robots_allowed: false, signals: null }),
    ]);
    expect(robots.pages[0]?.text).toBeNull();
    expect(robots.pages[0]?.text_sha256).toBeNull();
    expect(robots.pages[0]?.robots_allowed).toBe(false);

    const refused = freeze([sampleSnapshot({ text: null, http_status: 403, signals: null })]);
    expect(refused.pages[0]?.text).toBeNull();
    expect(refused.pages[0]?.http_status).toBe(403);
  });

  it('carries the snapshot’s own content hash through unchanged', () => {
    const fixture = freeze([sampleSnapshot({ content_hash: 'abc123' })]);
    expect(fixture.pages[0]?.content_hash).toBe('abc123');
  });

  it('stores no raw HTML, because §8 keeps markup out of the database', () => {
    const fixture = freeze([sampleSnapshot()]);
    const serialised = canonicalJson(fixture);
    expect(serialised).not.toContain('<script');
    expect(serialised).not.toContain('<html');
    expect(serialised).not.toContain('gtag(');
  });

  it('normalises an unrecognised page kind to null rather than guessing one', () => {
    const fixture = freeze([sampleSnapshot({ page_kind: 'blog' })]);
    expect(fixture.pages[0]?.page_kind).toBeNull();
  });
});

describe('the derived identifier', () => {
  it('is a pure function of the set and the domain', () => {
    expect(fixtureIdFor('a', 'firm.com.au')).toBe(fixtureIdFor('a', 'firm.com.au'));
    expect(fixtureIdFor('a', 'firm.com.au')).not.toBe(fixtureIdFor('b', 'firm.com.au'));
    expect(fixtureIdFor('a', 'firm.com.au')).not.toBe(fixtureIdFor('a', 'other.com.au'));
    expect(fixtureIdFor('a', 'firm.com.au')).toMatch(/^[0-9a-f]{32}$/);
  });
});
