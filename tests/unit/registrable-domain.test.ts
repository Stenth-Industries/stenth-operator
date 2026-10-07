/**
 * Registrable domains and the first-party policy (SPEC.md §9, §10 stage 1).
 *
 * §10 stage 1 is "Registrable domain via the public suffix list". These cases
 * are the ones string matching gets wrong: a deceptive suffix, a multi-label
 * Australian suffix, and a legitimate subdomain that an equality check refuses.
 */
import { describe, expect, it } from 'vitest';

import {
  isFirstPartyUrl,
  registrableDomainOfUrl,
  registrableHost,
} from '../../src/pipeline/domain';

const FIRM = 'harbourline.com.au';

describe('the list decides what the registrable domain is', () => {
  it.each([
    ['harbourline.com.au', 'harbourline.com.au', null],
    ['www.harbourline.com.au', 'harbourline.com.au', 'www'],
    ['nsw.harbourline.com.au', 'harbourline.com.au', 'nsw'],
    ['a.b.c.harbourline.com.au', 'harbourline.com.au', 'a.b.c'],
    ['harbourline.com', 'harbourline.com', null],
    ['harbourline.net.au', 'harbourline.net.au', null],
    ['harbourline.org.au', 'harbourline.org.au', null],
    ['harbourline.lawyer', 'harbourline.lawyer', null],
  ])('reads %s as %s', (host, domain, subdomain) => {
    const parsed = registrableHost(host);
    expect(parsed.registrableDomain).toBe(domain);
    expect(parsed.subdomain).toBe(subdomain);
  });

  it('handles multi-label Australian suffixes consistently', () => {
    // Deliberately not asserting how many labels the list gives `gov.au`
    // hosts: that is the list's business and it changes. What must hold is the
    // property the pipeline relies on — a host and its subdomains resolve to
    // the same registrable domain, so "same firm" is stable however deep the
    // suffix goes. A hand-written suffix table is what gets this wrong.
    const apex = registrableHost('legislation.gov.au').registrableDomain;
    expect(apex).not.toBeNull();
    expect(registrableHost('www.legislation.gov.au').registrableDomain).toBe(apex);

    const nsw = registrableHost('courts.nsw.gov.au').registrableDomain;
    expect(nsw).not.toBeNull();
    expect(registrableHost('www.courts.nsw.gov.au').registrableDomain).toBe(nsw);
  });

  it('has no registrable domain for a bare public suffix', () => {
    for (const host of ['com.au', 'net.au', 'org.au', 'au', 'gov.au', 'com']) {
      expect(registrableHost(host).registrableDomain, host).toBeNull();
    }
  });

  it('never makes a government host first-party to a firm', () => {
    for (const url of [
      'https://www.legislation.gov.au/',
      'https://courts.nsw.gov.au/',
      'https://www.police.nsw.gov.au/',
    ]) {
      expect(isFirstPartyUrl(url, FIRM).sameFirm, url).toBe(false);
    }
  });

  it('recognises an IP address as not a domain at all', () => {
    expect(registrableHost('203.0.113.9').isIp).toBe(true);
    expect(registrableHost('203.0.113.9').registrableDomain).toBeNull();
  });

  it('normalises case and a trailing dot', () => {
    expect(registrableHost('WWW.Harbourline.COM.AU.').registrableDomain).toBe(FIRM);
  });

  it('reads the domain out of a URL', () => {
    expect(registrableDomainOfUrl('https://www.harbourline.com.au/about?x=1#y')).toBe(FIRM);
    expect(registrableDomainOfUrl('not a url')).toBeNull();
  });
});

describe('first-party evidence stays on the firm\'s own registrable domain', () => {
  it('accepts the apex', () => {
    expect(isFirstPartyUrl('https://harbourline.com.au/', FIRM)).toMatchObject({
      sameFirm: true,
      registrableDomain: FIRM,
      subdomain: null,
    });
  });

  it('accepts apex -> www', () => {
    expect(isFirstPartyUrl('https://www.harbourline.com.au/', FIRM)).toMatchObject({
      sameFirm: true,
      subdomain: 'www',
    });
  });

  it('accepts www -> apex, with canonical_domain written as a www host', () => {
    // A companies row written before this module existed may hold a host rather
    // than a domain, so the expected side goes through the list too.
    expect(isFirstPartyUrl('https://harbourline.com.au/', 'www.harbourline.com.au')).toMatchObject({
      sameFirm: true,
    });
  });

  it('accepts a legitimate subdomain, which host equality refused', () => {
    for (const url of [
      'https://nsw.harbourline.com.au/about',
      'https://criminal.harbourline.com.au/',
      'https://blog.harbourline.com.au/post/1',
    ]) {
      expect(isFirstPartyUrl(url, FIRM).sameFirm, url).toBe(true);
    }
  });

  it('refuses a deceptive suffix', () => {
    // The case that makes string matching unsafe: the firm's domain appears as
    // a *prefix* of the host, so endsWith/includes would both say yes.
    for (const url of [
      'https://harbourline.com.au.attacker.tld/',
      'https://harbourline.com.au.evil.example/',
      'https://www.harbourline.com.au.attacker.tld/about',
    ]) {
      const verdict = isFirstPartyUrl(url, FIRM);
      expect(verdict.sameFirm, url).toBe(false);
      expect(verdict.sameFirm === false && verdict.reason).toBe('different_registrable_domain');
    }
  });

  it('refuses a lookalike that merely contains the name', () => {
    for (const url of [
      'https://notharbourline.com.au/',
      'https://harbourline-legal.com.au/',
      'https://harbourline.com/',
      'https://harbourline.co.nz/',
    ]) {
      expect(isFirstPartyUrl(url, FIRM).sameFirm, url).toBe(false);
    }
  });

  it('refuses a different registrable domain and says which one it found', () => {
    const verdict = isFirstPartyUrl('https://parked-example.net/', FIRM);
    expect(verdict).toMatchObject({
      sameFirm: false,
      reason: 'different_registrable_domain',
      found: 'parked-example.net',
      expected: FIRM,
    });
  });

  it('refuses an IP address', () => {
    expect(isFirstPartyUrl('http://203.0.113.9/', FIRM)).toMatchObject({
      sameFirm: false,
      reason: 'ip_address',
    });
  });

  it('refuses something that is not a URL', () => {
    expect(isFirstPartyUrl('javascript:alert(1)', FIRM).sameFirm).toBe(false);
    expect(isFirstPartyUrl('', FIRM).sameFirm).toBe(false);
  });

  it('treats a com.au firm and a com.au public suffix correctly', () => {
    // Nothing is first-party to a bare suffix, and a suffix is not a firm.
    expect(isFirstPartyUrl('https://anything.com.au/', 'com.au')).toMatchObject({
      sameFirm: false,
      reason: 'no_registrable_domain',
    });
  });

  it('does not promote a shared-hosting subdomain to its own firm', () => {
    // allowPrivateDomains is off, so github.io is not treated as a suffix:
    // two unrelated sites on one host stay one registrable domain, which is the
    // honest answer to "is this the firm's own site".
    expect(registrableHost('somefirm.github.io').registrableDomain).toBe('github.io');
    expect(isFirstPartyUrl('https://somefirm.github.io/', 'otherfirm.github.io')).toMatchObject({
      sameFirm: true,
    });
  });
});
