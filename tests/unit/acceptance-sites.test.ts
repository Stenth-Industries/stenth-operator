/**
 * The Day 3 acceptance seed list.
 *
 * sites.json is data a person edits, and the two things most likely to go wrong
 * with it are the two things that matter: a domain that appears twice (which
 * would double-count toward §25's twenty) and an entry with no evidence behind
 * it. "Do not invent business names or domains" is only enforceable if every
 * row carries the URL its name and domain came from.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const seed = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'ops', 'day3-acceptance', 'sites.json'), 'utf8'),
) as {
  note: string[];
  sites: Entry[];
  reserve: Entry[];
};

interface Entry {
  canonical_domain: string;
  legal_name: string;
  state: string;
  focus: string;
  name_evidence: 'stated' | 'domain';
  evidence_url: string;
}

const all = [...seed.sites, ...seed.reserve];

describe('the acceptance seed list', () => {
  it('holds the sixteen primaries and at least eight reserves', () => {
    expect(seed.sites).toHaveLength(16);
    expect(seed.reserve.length).toBeGreaterThanOrEqual(8);
  });

  it('has no domain twice, across primaries and reserves together', () => {
    // A duplicate would be enqueued once (companies is unique on the domain)
    // but reported twice, which would overstate the acceptance count.
    const domains = all.map((entry) => entry.canonical_domain);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it('gives every entry a registrable domain, with no scheme and no path', () => {
    for (const entry of all) {
      expect(entry.canonical_domain, entry.legal_name).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(entry.canonical_domain).not.toContain('/');
      expect(entry.canonical_domain).not.toContain('www.');
      expect(entry.canonical_domain).toBe(entry.canonical_domain.toLowerCase());
    }
  });

  it('cites an evidence URL for every name and domain', () => {
    for (const entry of all) {
      expect(entry.evidence_url, entry.canonical_domain).toMatch(/^https?:\/\/\S+$/);
      expect(['stated', 'domain']).toContain(entry.name_evidence);
      expect(entry.legal_name.length).toBeGreaterThan(1);
    }
  });

  it('spreads the primaries across more than one state', () => {
    // A §8 politeness rule is per host, so a single-state list would still be
    // polite — this is about the test being a real sample of Australian firms
    // rather than one city's directory page.
    const states = new Set(seed.sites.map((entry) => entry.state));
    expect(states.size).toBeGreaterThanOrEqual(4);
  });

  it('describes every entry as criminal or traffic defence work', () => {
    for (const entry of all) {
      expect(entry.focus.toLowerCase(), entry.canonical_domain).toMatch(
        /criminal|traffic|driving/,
      );
    }
  });
});
