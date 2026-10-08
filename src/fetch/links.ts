/**
 * The deterministic homepage link harvester (SPEC.md §8, §9, §10 stage 3).
 *
 * §10 stage 3 names six page kinds — home, about, services or practice areas,
 * contact, team, one location page — and says nothing about what a firm calls
 * them. Guessing conventional paths works often enough to be bounded and badly
 * enough to lose pages: a firm whose about page is `/our-firm` loses it. The
 * firm's own homepage already says which URL is which. This reads that.
 *
 * ## Why it runs here, in the fetcher
 *
 * The same reason the Tier A scanner does, and §19 puts them side by side.
 * `htmlToText` is next and it drops every `<a>` element along with the rest of
 * the markup, so this is the only moment the links exist. Keeping the raw HTML
 * in the database instead would mean storing hostile markup and pruning it
 * under §15.
 *
 * So the markup is read where the markup already is — in the process whose
 * whole job is handling hostile input — and **nothing but the filtered,
 * classified, capped result leaves**. No raw markup crosses the worker
 * boundary, and neither does the unfiltered link set: the fetch response schema
 * is `.strict()` and carries no link field at all, and what is written to
 * `web_snapshots.signals` is at most five URLs that have already passed every
 * rule in src/pipeline/links.ts.
 *
 * ## No model, ever
 *
 * Mirroring §9's sentence about Tier A: this is read out of the HTML by code.
 * A DOM query, a URL filter and five anchored regular expressions. A page that
 * *says* "our about page is at evil.example" cannot move any of it, because the
 * text is never consulted — only `href` attributes are, and each one is then
 * re-derived against the Public Suffix List.
 *
 * ## What the worker does with it
 *
 * Re-validates it. The fetcher is the process that handles hostile input, so
 * its output is the least trustworthy thing in the privileged zone — the same
 * rule that makes the worker parse the fetch response with Zod. The handler
 * runs every candidate through `safeFirstPartyUrl` again, against
 * `companies.canonical_domain` this time rather than against the page's own
 * final URL, before a single one becomes a job.
 */
import { parseHTML } from 'linkedom';

import { safeFirstPartyUrl } from '../pipeline/links';
import { classifyPageKind, FOLLOW_UP_KINDS, type PageKind } from '../pipeline/resolve';

/** Stamped into the stored row so a harvester change is visible in the data. */
export const PAGE_LINKS_VERSION = 'links-v1';

/**
 * The most `href` attributes examined, whatever the page claims to contain.
 *
 * A directory page or a generated sitemap can carry tens of thousands of links,
 * and the body is already size-capped by §8 — but a cap on bytes is not a cap
 * on anchors. This bounds the work regardless, and the scan also stops early
 * once every page kind is filled, so an ordinary site costs a few dozen checks.
 */
export const MAX_LINKS_CONSIDERED = 2_000;

/**
 * Elements whose descendants are not page links.
 *
 * The same list `htmlToText` drops, for the same §8 reason: content a human
 * visitor never sees is where injected markup lives. A link inside a `<script>`
 * string or a `<template>` was never offered to a visitor, so it is not a link
 * the firm's homepage offers.
 */
const DROPPED_CONTAINERS = ['script', 'style', 'noscript', 'template', 'head'];

export interface HarvestedCandidate {
  readonly kind: PageKind;
  readonly url: string;
}

export interface PageLinkHarvest {
  readonly links_version: string;
  /** How many href attributes were examined. A count: never the URLs. */
  readonly considered: number;
  /** How many survived every rule and classified as one of §10's kinds. */
  readonly kept: number;
  /** At most one per follow-up page kind, so at most five. Document order. */
  readonly candidates: readonly HarvestedCandidate[];
}

export function emptyHarvest(): PageLinkHarvest {
  return { links_version: PAGE_LINKS_VERSION, considered: 0, kept: 0, candidates: [] };
}

/**
 * Harvests the homepage's own links.
 *
 * `finalUrl` is the snapshot's final URL — after redirects — and is the only
 * base relative links are resolved against. A document's own `<base href>` is
 * deliberately **not** honoured: it is attacker-controlled markup whose entire
 * effect would be to re-point every relative link on the page, and ignoring it
 * removes that lever completely. (A `<base>` pointing somewhere on the firm's
 * own domain would be harmless; one pointing off it would be dropped anyway.
 * There is no case where honouring it helps, so it is not honoured.)
 *
 * Returns an empty harvest rather than throwing. A page that breaks the parser
 * must fall back to the conventional paths, not fail the fetch — the same
 * reasoning as the Tier A scanner's "a page that breaks the parser must not
 * silently come back with every signal absent", applied to a parser that can.
 */
export function harvestPageLinks(html: string, finalUrl: string): PageLinkHarvest {
  let base: URL;
  try {
    base = new URL(finalUrl);
  } catch {
    return emptyHarvest();
  }

  // The firm's registrable domain, taken from the page's own final URL. The
  // handler re-checks against companies.canonical_domain, which is the
  // authority; this is the fetcher refusing to carry anything it can already
  // tell is off-domain.
  const expectedDomain = base.hostname;

  let document: Document;
  try {
    ({ document } = parseHTML(html) as unknown as { document: Document });
  } catch {
    return emptyHarvest();
  }

  try {
    for (const tag of DROPPED_CONTAINERS) {
      for (const element of [...document.querySelectorAll(tag)]) {
        element.remove();
      }
    }
  } catch {
    // A parser that cannot mutate is still a parser that can be read.
  }

  let anchors: readonly Element[];
  try {
    anchors = [...document.querySelectorAll('a[href]')];
  } catch {
    return emptyHarvest();
  }

  const byKind = new Map<PageKind, string>();
  const wanted = new Set<PageKind>(FOLLOW_UP_KINDS);
  let considered = 0;

  for (const anchor of anchors) {
    if (considered >= MAX_LINKS_CONSIDERED || byKind.size >= wanted.size) {
      break;
    }
    const href = anchor.getAttribute('href');
    if (href === null || href === '') {
      continue;
    }
    considered += 1;

    // Every rule §8 states, from the one implementation both callers share.
    const verdict = safeFirstPartyUrl(href, base, expectedDomain);
    if (!verdict.ok) {
      continue;
    }

    // Safe to ask for is not the same as being one of §10's six kinds.
    const kind = classifyPageKind(new URL(verdict.url).pathname);
    if (kind === null || !wanted.has(kind) || byKind.has(kind)) {
      continue;
    }
    byKind.set(kind, verdict.url);
  }

  // §10's order, not discovery order, so the stored list reads the same way the
  // plan does and two pages cannot swap places between runs.
  const candidates = FOLLOW_UP_KINDS.flatMap((kind) => {
    const url = byKind.get(kind);
    return url === undefined ? [] : [{ kind, url }];
  });

  return {
    links_version: PAGE_LINKS_VERSION,
    considered,
    kept: candidates.length,
    candidates,
  };
}
