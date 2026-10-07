/**
 * Registrable domains, via the Public Suffix List (SPEC.md §9, §10 stage 1).
 *
 * §10 stage 1 is "Registrable domain via the public suffix list", and this is
 * the only place that question is answered. Suffix string matching cannot
 * answer it: `example.com.au` and `example.com.attacker.tld` both end in a
 * string that looks like a public suffix, and `nsw.gov.au` is a public suffix
 * while `gov.au` is too — so `foo.nsw.gov.au` is registrable at four labels,
 * not three. Only the list knows that, and the list changes.
 *
 * So `tldts` carries it. The alternative — a hand-written table of Australian
 * suffixes — is the bug this module exists to prevent, and it would go stale
 * silently.
 *
 * **The policy this implements** (approved for Day 5, review item 4):
 *
 *   * First-party evidence may sit anywhere on the firm's own registrable
 *     domain (eTLD+1), including a legitimate subdomain. `www.firm.com.au`,
 *     `firm.com.au` and `nsw.firm.com.au` are the same firm.
 *   * A final URL on a different registrable domain is **not** company
 *     evidence. It is reported, never promoted — until `company.resolve`
 *     separately verifies that the other domain belongs to the same firm, which
 *     is Day 5's work and does not exist yet.
 *   * Nothing is decided by string comparison of hosts, and nothing is
 *     silently accepted because it looks similar.
 */
import { parse } from 'tldts';

/** What the list says about one host. */
export interface RegistrableHost {
  readonly host: string;
  /** eTLD+1, or null when the host has none — an IP, a bare suffix, garbage. */
  readonly registrableDomain: string | null;
  readonly publicSuffix: string | null;
  /** True when the host is the registrable domain itself, with no subdomain. */
  readonly isApex: boolean;
  readonly subdomain: string | null;
  readonly isIp: boolean;
}

export function registrableHost(host: string): RegistrableHost {
  const lowered = host.trim().toLowerCase().replace(/\.$/, '');
  // allowPrivateDomains: false on purpose. The PSL's private section lists
  // things like github.io and blogspot.com, where each user gets a subdomain.
  // For "is this the firm's own site" the ICANN section is the right question —
  // a law firm on a shared hosting subdomain is a different conversation, and
  // treating it as its own registrable domain would make two unrelated firms on
  // one host look like separate domains.
  const parsed = parse(lowered, { allowPrivateDomains: false });

  return {
    host: lowered,
    registrableDomain: parsed.domain ?? null,
    publicSuffix: parsed.publicSuffix ?? null,
    isApex: parsed.domain !== null && parsed.subdomain === '',
    subdomain: parsed.subdomain === '' ? null : parsed.subdomain ?? null,
    isIp: parsed.isIp === true,
  };
}

/** The registrable domain of a URL, or null if it has none. */
export function registrableDomainOfUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return registrableHost(host).registrableDomain;
}

export type DomainVerdict =
  | { readonly sameFirm: true; readonly registrableDomain: string; readonly subdomain: string | null }
  | {
      readonly sameFirm: false;
      readonly reason: 'no_registrable_domain' | 'ip_address' | 'different_registrable_domain';
      readonly found: string | null;
      readonly expected: string | null;
    };

/**
 * Whether a URL is first-party evidence for a firm.
 *
 * `expectedDomain` is `companies.canonical_domain`, which §4 defines as the
 * registrable domain — but it is run through the list too rather than trusted,
 * because a row written before this module existed may hold a host with a `www.`
 * on it, and comparing a host to a domain is exactly the mistake this prevents.
 */
export function isFirstPartyUrl(url: string, expectedDomain: string): DomainVerdict {
  const expected = registrableHost(expectedDomain).registrableDomain;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { sameFirm: false, reason: 'no_registrable_domain', found: null, expected };
  }

  const found = registrableHost(host);

  if (found.isIp) {
    // A firm's site served from a bare IP is not identifiable as the firm's,
    // and §9's provenance rule needs the domain to mean something.
    return { sameFirm: false, reason: 'ip_address', found: found.host, expected };
  }
  if (found.registrableDomain === null || expected === null) {
    return {
      sameFirm: false,
      reason: 'no_registrable_domain',
      found: found.registrableDomain,
      expected,
    };
  }
  if (found.registrableDomain !== expected) {
    return {
      sameFirm: false,
      reason: 'different_registrable_domain',
      found: found.registrableDomain,
      expected,
    };
  }

  return {
    sameFirm: true,
    registrableDomain: found.registrableDomain,
    subdomain: found.subdomain,
  };
}
