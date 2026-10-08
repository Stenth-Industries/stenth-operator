/**
 * company.resolve: normalisation, the machine-checkable rejections, and the
 * six-page plan (SPEC.md §10 stages 1–3, §6, §7).
 *
 * §10's first two stages are deliberately code-only — "cheap deterministic ones
 * first, so no model is paid to reject an obvious miss" — and stage 3 is the
 * fetch of "max 6 pages: home, about, services or practice areas, contact,
 * team, one location page". This module is the whole of stages 1 and 2 that can
 * be decided from a candidate domain alone, plus the page plan stage 3 consumes.
 *
 * Everything here is pure. The handler owns the database and the queue; this
 * owns the rules, so they can be unit-tested without either.
 *
 * ## What stage 2 can and cannot decide here
 *
 * §10 lists eight hard disqualifiers. Only two of them are answerable from a
 * domain: suppression and "already a prospect in this campaign", and both are
 * database lookups the handler performs. The other six — not an Australian law
 * firm, barristers' chambers, more than 50 lawyers, legal aid only, a marketing
 * agency, a dead or parked site — are all properties of the *pages*, and the
 * pages have not been fetched yet. They belong to §10 stage 6 and Day 6.
 *
 * This module therefore rejects exactly three things, all structural:
 *
 *   * a candidate with no registrable domain (garbage, a bare public suffix);
 *   * a bare IP address, which cannot be a firm's identity under §9;
 *   * a host whose registrable domain is not what the candidate claimed.
 *
 * It does **not** reject a non-`.au` domain. An Australian firm on a `.com` is
 * ordinary, "no AU registration signal" in §10 is one half of a two-part test
 * whose other half is an AU address on the page, and inventing a TLD filter
 * here would silently disqualify real firms before anything looked at them.
 */
import { registrableHost } from './domain';

/** The six page kinds of §10 stage 3, in the order the section lists them. */
export const PAGE_KINDS = [
  'home',
  'about',
  'practice_areas',
  'contact',
  'team',
  'location',
] as const;

export type PageKind = (typeof PAGE_KINDS)[number];

/**
 * §10 stage 3's ceiling, restated where the plan is built.
 *
 * The same number lives on the web.fetch payload schema as MAX_PAGES_PER_JOB.
 * A test asserts the two agree rather than one importing the other: the handler
 * limit protects the fetcher from any caller, and this limit is what the
 * planner will emit — they are the same figure for the same reason, but they
 * are not the same guarantee.
 */
export const MAX_PLANNED_PAGES = 6;

/**
 * The candidate path per page kind.
 *
 * **This table is data, and it is a first pass.** §10 freezes the six page
 * *kinds*; it does not say what a firm calls them, and nothing in the repo
 * knows either — no page URL has ever been harvested from a stored snapshot
 * (src/fetch/signals.ts counts location links, it does not collect them). So
 * the plan asks for one conventional path per kind and accepts that some will
 * 404. That is bounded and cheap by Day 3's own correction: a 4xx is terminal,
 * writes a text-free diagnostic row, is never evidence, and is never retried.
 *
 * The first real run's 404 rate per kind is the evidence that should change
 * these strings, and changing them is a one-line data edit.
 *
 * `practice_areas` rather than `services` because §9 and §10 use "practice
 * areas" throughout as the thing to extract and to score — "practice areas that
 * carry real case value" in the rubric, `practice_area_priors` as a table. The
 * spec's own vocabulary for this vertical is the only evidence available, and
 * both spellings are permitted by src/ai/sanitise.ts's path allowlist anyway.
 */
export const PAGE_PATHS: Readonly<Record<PageKind, string>> = {
  home: '/',
  about: '/about',
  practice_areas: '/practice-areas',
  contact: '/contact',
  team: '/team',
  location: '/locations',
};

export interface PlannedPage {
  readonly kind: PageKind;
  readonly url: string;
}

/** Why a candidate was rejected before anything was fetched. */
export type ResolveRejection =
  | 'no_registrable_domain'
  | 'ip_address'
  | 'suppressed_domain'
  | 'already_a_prospect';

export type Normalisation =
  | { readonly ok: true; readonly canonicalDomain: string }
  | {
      readonly ok: false;
      readonly reason: Extract<ResolveRejection, 'no_registrable_domain' | 'ip_address'>;
      readonly detail: string;
    };

/**
 * §10 stage 1: "Registrable domain via the public suffix list."
 *
 * Takes either a bare domain or a URL, because discovery produces both, and
 * returns the one string §4 defines as `companies.canonical_domain`: the
 * registrable domain, lowercased, no www. The `www.` is not stripped by string
 * surgery — the list is asked for the eTLD+1 and that answer *is* the domain,
 * which is also why `nsw.firm.com.au` and `firm.com.au` resolve to one company
 * rather than two.
 */
export function normaliseCandidateDomain(candidate: string): Normalisation {
  const trimmed = candidate.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'no_registrable_domain', detail: 'empty candidate' };
  }

  // A URL, a scheme-less host, or a host with a path. Parsed rather than
  // split: `evil.example/firm.com.au` must not read as a domain.
  let host = trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.includes('/')) {
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
        .hostname;
    } catch {
      return { ok: false, reason: 'no_registrable_domain', detail: 'unparseable candidate' };
    }
  }

  const parsed = registrableHost(host);

  if (parsed.isIp) {
    // §9 grounds every fact in a domain that identifies the firm. An IP does
    // not, and a snapshot stored against one could never be matched back.
    return { ok: false, reason: 'ip_address', detail: parsed.host };
  }
  if (parsed.registrableDomain === null) {
    return {
      ok: false,
      reason: 'no_registrable_domain',
      detail: parsed.publicSuffix === null ? parsed.host : `bare public suffix ${parsed.host}`,
    };
  }

  return { ok: true, canonicalDomain: parsed.registrableDomain };
}

/**
 * The §10 stage 3 plan: at most six pages, home first, on the firm's own domain.
 *
 * https only. The fetcher's frozen policy decides what it will actually open,
 * and a plan that asked for http would be asking it to start unencrypted on a
 * site that almost certainly redirects anyway.
 *
 * Deterministic: the same canonical domain always produces the same list in the
 * same order, which is what makes the fan-out auditable and the per-URL dedupe
 * keys stable across a re-run.
 */
export function planPages(canonicalDomain: string): readonly PlannedPage[] {
  const normalised = normaliseCandidateDomain(canonicalDomain);
  if (!normalised.ok) {
    return [];
  }

  const pages = PAGE_KINDS.map((kind) => ({
    kind,
    url: `https://${normalised.canonicalDomain}${PAGE_PATHS[kind]}`,
  }));

  // The cap is applied here as well as asserted in a test, because the day
  // someone adds a seventh kind to PAGE_KINDS this is what stops the fetcher
  // being asked for seven pages.
  return pages.slice(0, MAX_PLANNED_PAGES);
}
