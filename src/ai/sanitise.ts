/**
 * The post-parse sanitiser (SPEC.md §8).
 *
 * §8: "After parsing, a sanitiser strips control characters, rejects URLs and
 * markup in fields that should not contain them, and caps every string again."
 *
 * Zod has already rejected unknown keys and over-long strings by the time this
 * runs. What it cannot do is notice that a *valid* string is carrying an
 * instruction, a link or a tag — a `firm_name` of
 * `"Smith Legal</p><script>..."` passes every length check. So this pass is
 * about what the strings contain, and it is the last thing to touch the data
 * before it reaches the privileged zone.
 *
 * It rejects rather than repairs wherever the content has no business being
 * there. A silently cleaned field is a field nobody looks at again.
 */
import { isFirstPartyUrl, registrableDomainOfUrl } from '../pipeline/domain';
import { isolatedExtractionSchema, type IsolatedExtraction } from './schemas/extraction-v1';

export class SanitiserRejection extends Error {
  override readonly name = 'SanitiserRejection';

  constructor(
    readonly field: string,
    readonly rule: string,
  ) {
    // No value in the message: the value is untrusted page content and this
    // message reaches the logs.
    super(`${field} rejected by the sanitiser: ${rule}`);
  }
}

/**
 * C0 and C1 control characters, plus the zero-width and bidi characters §8
 * strips from page text. Tab, newline and carriage return are normalised to a
 * space rather than removed, so two words do not become one.
 */
const CONTROL = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
    '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
  'g',
);
const WHITESPACE = new RegExp(
  '[\\t\\n\\r\\u00A0\\u2000-\\u200A\\u2028\\u2029\\u3000]+',
  'g',
);

/** Markup, an HTML entity that could become markup, or a URL scheme. */
const MARKUP = /<[^>]|<\/|&lt;|&#x?[0-9a-f]+;/i;
const URL_LIKE = /\b(?:https?|ftp|file|data|javascript|vbscript):|\bwww\.[a-z0-9-]+\./i;

function normalise(value: string): string {
  return value.replace(CONTROL, '').replace(WHITESPACE, ' ').trim();
}

/**
 * A field that must read as prose: no markup, no links.
 *
 * `allowUrl` exists for exactly one field — a published contact's value, which
 * legitimately holds an email address or a contact-form URL. Everything else is
 * a firm name, a practice area, a person, or a quote from the page, and none of
 * those has a reason to contain a link.
 */
function cleanProse(
  field: string,
  value: string,
  options: { readonly allowUrl?: boolean } = {},
): string {
  const cleaned = normalise(value);
  if (cleaned === '') {
    throw new SanitiserRejection(field, 'empty after normalisation');
  }
  if (MARKUP.test(cleaned)) {
    throw new SanitiserRejection(field, 'contains markup');
  }
  if (options.allowUrl !== true && URL_LIKE.test(cleaned)) {
    throw new SanitiserRejection(field, 'contains a URL');
  }
  return cleaned;
}

/**
 * next_urls, filtered in code (§8, §23 case 8).
 *
 * "The schema may contain a next_urls field, but it is advisory: code filters
 * it to the same registrable domain, an allowlist of path patterns, at most
 * five URLs, depth at most two. The model never causes a fetch directly."
 *
 * A URL that fails any rule is dropped silently — unlike a prose field, a bad
 * suggestion here is not evidence of anything, and the whole point is that the
 * list is advice the code is free to ignore.
 */
export const ALLOWED_PATH =
  /^\/(?:|about(?:-us)?|our-(?:team|people|firm|offices?)|team|people|services|practice(?:-areas?)?|areas?-of-(?:law|practice)|expertise|contact(?:-us)?|locations?|offices?)(?:\/[a-z0-9-]*)?\/?$/i;

export const MAX_NEXT_URLS = 5;
export const MAX_NEXT_URL_DEPTH = 2;

export function filterNextUrls(
  candidates: readonly string[] | undefined,
  sourceUrl: string,
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

  // The firm's own registrable domain, asked of the list rather than assumed.
  // Null means the source URL has no eTLD+1 at all — an IP, a bare suffix — in
  // which case there is no "same firm" to be on and the whole list is dropped.
  const expectedDomain = registrableDomainOfUrl(base.href);
  if (expectedDomain === null) {
    return [];
  }

  const kept: string[] = [];
  for (const candidate of candidates) {
    if (kept.length >= MAX_NEXT_URLS) {
      break;
    }
    let target: URL;
    try {
      target = new URL(candidate, base);
    } catch {
      continue;
    }

    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      continue;
    }

    // §8's words are "the same registrable domain", and since Day 5 that is
    // what this asks — the Public Suffix List, through src/pipeline/domain.ts,
    // the one place in the codebase allowed to answer it.
    //
    // This replaces host equality, which was the Day 4 placeholder. The
    // placeholder was stricter in one way only: it refused `nsw.firm.com.au`
    // from a page on `firm.com.au`, which §10's own policy says is the same
    // firm. It was not stricter where it mattered — it could not tell
    // `firm.com.au` from `firm.com.au.attacker.tld` on principle, only by the
    // accident of the strings differing, and a homoglyph host is a different
    // string too, so equality never knew *why* it was right.
    //
    // Nothing else relaxes. A different registrable domain is still dropped,
    // and an IP, a bare suffix or an unparseable host has no registrable
    // domain and so can never match.
    if (!isFirstPartyUrl(target.href, expectedDomain).sameFirm) {
      continue;
    }
    if (target.username !== '' || target.password !== '') {
      continue;
    }
    if (target.port !== '' && target.port !== '80' && target.port !== '443') {
      continue;
    }

    const segments = target.pathname.split('/').filter((part) => part !== '');
    if (segments.length > MAX_NEXT_URL_DEPTH) {
      continue;
    }
    if (!ALLOWED_PATH.test(target.pathname)) {
      continue;
    }

    const normalised = `${target.origin}${target.pathname}`;
    if (!kept.includes(normalised)) {
      kept.push(normalised);
    }
  }
  return kept;
}

/**
 * Cleans a parsed extraction, or throws.
 *
 * Re-parsed through the schema at the end: the caps have to hold *after*
 * normalisation too, and re-parsing is how that stays true without restating
 * every limit here.
 */
export function sanitiseExtraction(
  parsed: IsolatedExtraction,
  sourceUrl: string,
): IsolatedExtraction {
  const cleaned = {
    ...parsed,
    ...(parsed.firm_name === undefined
      ? {}
      : { firm_name: cleanProse('firm_name', parsed.firm_name) }),
    office_locations: parsed.office_locations.map((value, index) =>
      cleanProse(`office_locations[${index}]`, value),
    ),
    practice_areas: parsed.practice_areas.map((area, index) => ({
      name: cleanProse(`practice_areas[${index}].name`, area.name),
      evidence_quote: cleanProse(`practice_areas[${index}].evidence_quote`, area.evidence_quote),
    })),
    named_people: parsed.named_people.map((person, index) => ({
      ...person,
      full_name: cleanProse(`named_people[${index}].full_name`, person.full_name),
      ...(person.role_title === undefined
        ? {}
        : { role_title: cleanProse(`named_people[${index}].role_title`, person.role_title) }),
      evidence_quote: cleanProse(`named_people[${index}].evidence_quote`, person.evidence_quote),
    })),
    published_contacts: parsed.published_contacts.map((contact, index) => ({
      ...contact,
      // The one field allowed to hold a link: an address or a form URL.
      value: cleanProse(`published_contacts[${index}].value`, contact.value, { allowUrl: true }),
      evidence_quote: cleanProse(
        `published_contacts[${index}].evidence_quote`,
        contact.evidence_quote,
      ),
    })),
    ...(parsed.summary === undefined
      ? {}
      : { summary: cleanProse('summary', parsed.summary) }),
    next_urls: filterNextUrls(parsed.next_urls, sourceUrl),
  };

  const reparsed = isolatedExtractionSchema.safeParse(cleaned);
  if (!reparsed.success) {
    throw new SanitiserRejection(
      reparsed.error.issues[0]?.path.join('.') ?? 'payload',
      'failed the schema after normalisation',
    );
  }
  return reparsed.data;
}
