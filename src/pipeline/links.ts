/**
 * The first-party URL filter (SPEC.md §8, §10 stage 1).
 *
 * §8, on the model's advisory `next_urls`: "code filters it to the same
 * registrable domain, an allowlist of path patterns, at most five URLs, depth
 * at most two. The model never causes a fetch directly."
 *
 * Those words describe a filter on *untrusted suggestions*, and there are now
 * two sources of those:
 *
 *   1. `next_urls` from an isolated extraction — a model reading a hostile page.
 *   2. The homepage link harvest — code reading the same hostile page.
 *
 * Both are advice from something that read attacker-controlled markup, so both
 * get the same filter, and it lives here rather than in either caller. One
 * implementation means a rule cannot be tightened in one path and forgotten in
 * the other, which is the failure a copy would eventually produce.
 *
 * Pure: no I/O, no database, no model, no network. The only dependency is the
 * Public Suffix List through ./domain, which is the one place in the codebase
 * allowed to answer "is this the same firm".
 */
import { isFirstPartyUrl, registrableDomainOfUrl } from './domain';

/**
 * The path allowlist (§8).
 *
 * The same vocabulary of legitimate page kinds that §10 stage 3 names, written
 * as a pattern. Anything outside it is dropped whatever its domain: a page on
 * the firm's own site is still not a page this pipeline has any business
 * fetching if it is `/wp-admin` or `/cart`.
 */
export const ALLOWED_PATH =
  /^\/(?:|about(?:-us)?|our-(?:team|people|firm|offices?)|team|people|services|practice(?:-areas?)?|areas?-of-(?:law|practice)|expertise|contact(?:-us)?|locations?|offices?)(?:\/[a-z0-9-]*)?\/?$/i;

/** §8: "at most five URLs". Also the five non-home pages of §10 stage 3. */
export const MAX_NEXT_URLS = 5;

/** §8: "depth at most two". */
export const MAX_NEXT_URL_DEPTH = 2;

/** Why one candidate was dropped. Machine tokens: logged and counted, never shown. */
export type UrlRejection =
  | 'unparseable'
  | 'scheme_not_http'
  | 'credentials_in_url'
  | 'port_not_allowed'
  | 'off_registrable_domain'
  | 'path_too_deep'
  | 'path_not_allowed';

export type UrlVerdict =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: UrlRejection };

/** The allowed ports, which are the two the frozen fetch policy would open. */
const ALLOWED_PORTS = new Set(['', '80', '443']);

/**
 * Whether one candidate is a first-party URL this pipeline may ask for.
 *
 * `expectedDomain` is the firm's registrable domain — `companies.canonical_domain`
 * — and is run through the list rather than compared as a string, because
 * comparing a host to a domain is the mistake ./domain exists to prevent.
 *
 * Returns the *normalised* URL: origin plus pathname, with the query string and
 * the fragment dropped. That is not cosmetic. `/about?x=1`, `/about#team` and
 * `/about` are one page, and a page that can be named a thousand ways is a page
 * that can exhaust a six-page budget on its own.
 */
export function safeFirstPartyUrl(
  candidate: string,
  base: URL,
  expectedDomain: string,
): UrlVerdict {
  let target: URL;
  try {
    target = new URL(candidate, base);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  // Scheme first: `javascript:`, `data:` and `file:` are not pages, and a URL
  // object will happily hold any of them.
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, reason: 'scheme_not_http' };
  }

  // §8's "the same registrable domain", asked of the Public Suffix List. An IP,
  // a bare public suffix, a homoglyph host and `firm.com.au.attacker.tld` all
  // fail here on principle rather than by the accident of two strings differing.
  if (!isFirstPartyUrl(target.href, expectedDomain).sameFirm) {
    return { ok: false, reason: 'off_registrable_domain' };
  }

  if (target.username !== '' || target.password !== '') {
    return { ok: false, reason: 'credentials_in_url' };
  }

  if (!ALLOWED_PORTS.has(target.port)) {
    return { ok: false, reason: 'port_not_allowed' };
  }

  const segments = target.pathname.split('/').filter((part) => part !== '');
  if (segments.length > MAX_NEXT_URL_DEPTH) {
    return { ok: false, reason: 'path_too_deep' };
  }

  if (!ALLOWED_PATH.test(target.pathname)) {
    return { ok: false, reason: 'path_not_allowed' };
  }

  return { ok: true, url: `${target.origin}${target.pathname}` };
}

/**
 * The list form: filter, deduplicate, cap.
 *
 * A candidate that fails any rule is dropped silently. Unlike a prose field, a
 * bad suggestion here is not evidence of anything — the whole point is that the
 * list is advice the code is free to ignore.
 */
export function filterFirstPartyUrls(
  candidates: readonly string[] | undefined,
  sourceUrl: string,
  max: number = MAX_NEXT_URLS,
): string[] {
  if (candidates === undefined) {
    return [];
  }

  let base: URL;
  try {
    base = new URL(sourceUrl);
  } catch {
    return [];
  }

  // Null means the source URL has no eTLD+1 at all, so there is no "same firm"
  // for anything to be first party to, and the whole list goes.
  const expectedDomain = registrableDomainOfUrl(base.href);
  if (expectedDomain === null) {
    return [];
  }

  const kept: string[] = [];
  for (const candidate of candidates) {
    if (kept.length >= max) {
      break;
    }
    const verdict = safeFirstPartyUrl(candidate, base, expectedDomain);
    if (verdict.ok && !kept.includes(verdict.url)) {
      kept.push(verdict.url);
    }
  }
  return kept;
}
