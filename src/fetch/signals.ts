/**
 * The Tier A signal scanner (SPEC.md §9, §19).
 *
 * §9's Tier A signals are "read out of stored HTML by code, not inferred by a
 * model". That sentence is the whole design: every value here comes from a
 * regular expression or a DOM query over the page's own markup, so a page that
 * *claims* "we run Google Ads" in prose cannot move the signal — §23 case 13.
 * No model ever sees this function's input or output.
 *
 * It runs in the fetcher, on the raw HTML, before html-to-text. It has to:
 * html-to-text drops <script> (correctly — §8, and that is where injected
 * instructions live), and the AW- identifier lives inside a script. Reading it
 * later from web_snapshots.text is therefore impossible, and keeping the raw
 * HTML in the database instead would mean storing hostile markup and pruning it
 * under §15. So the deterministic read happens where the HTML is, once, and
 * only the structured result is stored.
 *
 * Everything here is "present, absent or not looked at". Nothing is estimated:
 * §9 says anything outside Tier A is recorded as unknown, and the scanner is
 * the only thing allowed to say `absent`, because only it has looked.
 */

/** Stamped into the stored row so a scanner change is visible in the data. */
export const SIGNALS_VERSION = 'tier-a-v1';

export interface TierASignals {
  readonly signals_version: string;
  /** §9: "An AW- identifier in a gtag() config, or a googleadservices.com conversion script". */
  readonly paid_search_tag: boolean;
  /** The identifiers themselves, so a human can check the claim. */
  readonly aw_ids: readonly string[];
  readonly ga4: boolean;
  readonly ga4_ids: readonly string[];
  readonly gtm: boolean;
  readonly gtm_ids: readonly string[];
  /** A known call-tracking vendor script, or a dynamic-number-insertion pattern. */
  readonly call_tracking: boolean;
  readonly call_tracking_vendors: readonly string[];
  /** Conversion affordances (§9). */
  readonly tel_link: boolean;
  readonly mailto_link: boolean;
  readonly form_present: boolean;
  readonly location_page_links: number;
  /** Responsiveness (§9). */
  readonly viewport_meta: boolean;
  readonly breakpoints: boolean;
  /** Content recency (§9). The most recent four-digit year in a copyright line. */
  readonly copyright_year: number | null;
}

/**
 * Script and style content, which html-to-text deliberately throws away.
 *
 * Tag-level matching rather than a parse: the scanner must behave the same on
 * malformed markup, and a page that breaks the parser must not silently come
 * back with every signal absent. Case-insensitive and tolerant of attributes.
 */
function scriptAndStyleText(html: string): string {
  const parts: string[] = [];
  const pattern = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    parts.push(match[2] ?? '');
  }
  // Plus the attributes of script tags, where src= lives.
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    parts.push(match[1] ?? '');
  }
  return parts.join('\n');
}

/** Everything except script and style: the markup a visitor's browser renders. */
function renderedMarkup(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Known call-tracking vendors and the dynamic-number-insertion pattern.
 *
 * A short, explicit list. A vendor that is not on it reads as absent, which is
 * the honest answer — "we did not recognise a tracker" is not the same as "a
 * tracker is there", and §9 would rather under-claim than invent.
 */
const CALL_TRACKING_VENDORS: ReadonlyArray<readonly [string, RegExp]> = [
  ['callrail', /callrail\.com|callrail\b/i],
  ['calltrackingmetrics', /calltrackingmetrics\.com|__ctm\b/i],
  ['delacon', /delacon\.com\.au|vxt\.delacon/i],
  ['avanser', /avanser\.com\.au/i],
  ['whatconverts', /whatconverts\.com/i],
  ['infinity', /infinity-tracking\.net|ict-sdk/i],
  ['google_dni', /gtag\s*\(\s*['"]config['"][\s\S]{0,400}?phone_conversion_number|_googWcmGet\s*\(/i],
];

/** Matches a path that is a location or office page, for the §9 affordance count. */
const LOCATION_PATH =
  /href\s*=\s*["'][^"']*\/(?:locations?|offices?|our-offices|contact-us\/[a-z-]+|find-us)[^"']*["']/gi;

export function scanTierASignals(html: string): TierASignals {
  const scripts = scriptAndStyleText(html);
  const rendered = renderedMarkup(html);

  // §23 case 13: the identifiers are read from script content only, never from
  // the rendered text, so "AW-12345678" written in a paragraph is inert.
  const awIds = unique(
    [...scripts.matchAll(/\bAW-[0-9]{6,15}\b/g)].map((match) => match[0]),
  );
  const conversionScript = /googleadservices\.com|googleads\.g\.doubleclick\.net/i.test(scripts);

  const ga4Ids = unique([...scripts.matchAll(/\bG-[A-Z0-9]{6,12}\b/g)].map((match) => match[0]));
  const gtmIds = unique([...scripts.matchAll(/\bGTM-[A-Z0-9]{4,10}\b/g)].map((match) => match[0]));

  const vendors = CALL_TRACKING_VENDORS.filter(([, pattern]) => pattern.test(scripts)).map(
    ([name]) => name,
  );

  return {
    signals_version: SIGNALS_VERSION,
    paid_search_tag: awIds.length > 0 || conversionScript,
    aw_ids: awIds,
    ga4: ga4Ids.length > 0,
    ga4_ids: ga4Ids,
    gtm: gtmIds.length > 0,
    gtm_ids: gtmIds,
    call_tracking: vendors.length > 0,
    call_tracking_vendors: vendors,
    tel_link: /href\s*=\s*["']\s*tel:/i.test(rendered),
    mailto_link: /href\s*=\s*["']\s*mailto:/i.test(rendered),
    form_present: /<form\b/i.test(rendered),
    location_page_links: [...rendered.matchAll(LOCATION_PATH)].length,
    viewport_meta: /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(rendered),
    // A stylesheet is not fetched, so responsiveness is judged from what is in
    // the document: an inline media query, or a utility framework's breakpoint
    // class. Absent here means "no evidence in the HTML", not "not responsive".
    breakpoints:
      /@media[^{]*\((?:min|max)-width/i.test(html) ||
      /\b(?:sm|md|lg|xl):[a-z-]/.test(rendered),
    copyright_year: mostRecentCopyrightYear(rendered),
  };
}

/**
 * The most recent year that appears in a copyright line.
 *
 * Scoped to the neighbourhood of a copyright marker rather than any four digits
 * on the page: a law firm's content is full of years — legislation, case dates,
 * "practising since 1987" — and the §9 signal is specifically the footer's
 * claim about when the site was last touched.
 */
function mostRecentCopyrightYear(markup: string): number | null {
  const text = markup.replace(/<[^>]*>/g, ' ');
  let best: number | null = null;
  for (const match of text.matchAll(/(?:©|&copy;|copyright)([\s\S]{0,60})/gi)) {
    for (const year of (match[1] ?? '').matchAll(/\b(19[89][0-9]|20[0-9]{2})\b/g)) {
      const value = Number(year[1]);
      if (best === null || value > best) {
        best = value;
      }
    }
  }
  return best;
}
