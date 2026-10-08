/**
 * company.resolve's normalisation and the §10 stage 3 page plan.
 *
 * Pure functions, no database, no network, no model. The point of these cases
 * is that the two decisions company.resolve makes before anything is fetched —
 * "what is this firm's domain" and "which six pages" — are deterministic and
 * answered by the Public Suffix List rather than by string surgery.
 */
import { describe, expect, it } from 'vitest';

import { ALLOWED_PATH } from '../../src/ai/sanitise';
import {
  MAX_PLANNED_PAGES,
  PAGE_KINDS,
  PAGE_PATHS,
  normaliseCandidateDomain,
  planPages,
} from '../../src/pipeline/resolve';
import { MAX_PAGES_PER_JOB } from '../../src/worker/handlers/web-fetch';

describe('§10 stage 1: the candidate domain', () => {
  it('returns the registrable domain, lowercased and without www', () => {
    for (const candidate of [
      'firm.com.au',
      'FIRM.COM.AU',
      'www.firm.com.au',
      '  www.firm.com.au  ',
      'https://www.firm.com.au/',
      'https://firm.com.au/about/our-team',
      'firm.com.au/contact',
      'firm.com.au.',
    ]) {
      expect(normaliseCandidateDomain(candidate)).toStrictEqual({
        ok: true,
        canonicalDomain: 'firm.com.au',
      });
    }
  });

  it('collapses every subdomain of one firm onto one company', () => {
    // §4's canonical_domain is unique, so this is what stops `nsw.firm.com.au`
    // and `firm.com.au` becoming two companies for one firm.
    const domains = ['firm.com.au', 'www.firm.com.au', 'nsw.firm.com.au', 'a.b.firm.com.au'].map(
      (host) => {
        const result = normaliseCandidateDomain(host);
        return result.ok ? result.canonicalDomain : result.reason;
      },
    );
    expect(new Set(domains)).toStrictEqual(new Set(['firm.com.au']));
  });

  it('is not fooled by a domain hidden in a path or a userinfo field', () => {
    // The whole reason the candidate is parsed as a URL rather than split on
    // dots: the registrable domain of each of these is the attacker's.
    expect(normaliseCandidateDomain('https://evil.example/firm.com.au')).toStrictEqual({
      ok: true,
      canonicalDomain: 'evil.example',
    });
    expect(normaliseCandidateDomain('https://firm.com.au@evil.example/')).toStrictEqual({
      ok: true,
      canonicalDomain: 'evil.example',
    });
    expect(normaliseCandidateDomain('firm.com.au.evil.example')).toStrictEqual({
      ok: true,
      canonicalDomain: 'evil.example',
    });
  });

  it('rejects what cannot be a firm identity', () => {
    for (const [candidate, reason] of [
      ['', 'no_registrable_domain'],
      ['   ', 'no_registrable_domain'],
      ['com.au', 'no_registrable_domain'],
      ['.com.au', 'no_registrable_domain'],
      ['au', 'no_registrable_domain'],
      ['localhost', 'no_registrable_domain'],
      ['not a domain', 'no_registrable_domain'],
      ['203.0.113.10', 'ip_address'],
      ['https://203.0.113.10/', 'ip_address'],
      ['[2001:db8::1]', 'ip_address'],
    ] as const) {
      const result = normaliseCandidateDomain(candidate);
      expect(result.ok, `${candidate} should be rejected`).toBe(false);
      expect(result.ok === false && result.reason, candidate).toBe(reason);
    }
  });

  it('does not reject a firm for being on a non-.au domain', () => {
    // §10's "no AU registration signal" is one half of a two-part test whose
    // other half is an address on the page. A TLD filter here would disqualify
    // real Australian firms before anything had looked at them.
    expect(normaliseCandidateDomain('firm.com')).toStrictEqual({
      ok: true,
      canonicalDomain: 'firm.com',
    });
    expect(normaliseCandidateDomain('firm.law')).toStrictEqual({
      ok: true,
      canonicalDomain: 'firm.law',
    });
  });
});

describe('§10 stage 3: the page plan', () => {
  it('names the six page kinds §10 lists, and no seventh', () => {
    expect(PAGE_KINDS).toStrictEqual([
      'home',
      'about',
      'practice_areas',
      'contact',
      'team',
      'location',
    ]);
    expect(PAGE_KINDS).toHaveLength(MAX_PLANNED_PAGES);
  });

  it('agrees with the limit the web.fetch payload enforces', () => {
    // Two statements of §10's "max 6 pages" — one is what the planner emits, the
    // other is what the handler accepts from any caller. They are the same
    // number and neither imports the other, so this is what keeps them equal.
    expect(MAX_PLANNED_PAGES).toBe(MAX_PAGES_PER_JOB);
  });

  it('plans at most six pages, home first, all on the firm’s own domain', () => {
    const pages = planPages('firm.com.au');
    expect(pages).toHaveLength(6);
    expect(pages[0]).toStrictEqual({ kind: 'home', url: 'https://firm.com.au/' });
    expect(pages.map((page) => page.kind)).toStrictEqual([...PAGE_KINDS]);
    for (const page of pages) {
      expect(new URL(page.url).hostname).toBe('firm.com.au');
      expect(new URL(page.url).protocol).toBe('https:');
    }
  });

  it('is deterministic: the same domain always plans the same list', () => {
    expect(planPages('firm.com.au')).toStrictEqual(planPages('firm.com.au'));
    // And a host normalises before planning, so www and apex plan identically.
    expect(planPages('www.firm.com.au')).toStrictEqual(planPages('firm.com.au'));
  });

  it('plans nothing for a candidate that is not a firm domain', () => {
    expect(planPages('203.0.113.10')).toStrictEqual([]);
    expect(planPages('com.au')).toStrictEqual([]);
    expect(planPages('')).toStrictEqual([]);
  });

  it('plans only paths the next_urls allowlist would also accept', () => {
    // The same vocabulary of legitimate page kinds, stated twice: once as what
    // we ask for, once as what we will accept from a model's suggestion. A path
    // the planner requests but the filter would reject means the two have
    // drifted.
    for (const kind of PAGE_KINDS) {
      expect(ALLOWED_PATH.test(PAGE_PATHS[kind]), `${kind} -> ${PAGE_PATHS[kind]}`).toBe(true);
    }
  });

  it('plans no path deeper than the depth the filter permits', () => {
    for (const kind of PAGE_KINDS) {
      const segments = PAGE_PATHS[kind].split('/').filter((part) => part !== '');
      expect(segments.length, `${kind}`).toBeLessThanOrEqual(2);
    }
  });
});
