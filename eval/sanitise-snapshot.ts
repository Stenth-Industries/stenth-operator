/**
 * The eval snapshot sanitiser (SPEC.md §21, §25 Day 5).
 *
 * **This is not src/ai/sanitise.ts.** That one cleans what a model returned,
 * after the fact, inside the production pipeline. This one turns a stored
 * snapshot row into a frozen fixture, and it has a different job and a
 * different threat model:
 *
 *   src/ai/sanitise.ts  "the model answered; is this answer safe to store?"
 *   this file            "this evidence is going to disk under a name derived
 *                         from untrusted data; is it stable, bounded and
 *                         exactly what it claims to be?"
 *
 * Deterministic and pure. Same row in, same fixture out, byte for byte — which
 * is what lets a re-freeze be a no-op and a diff mean something.
 *
 * ## What it does
 *
 *   * validates the source row's shape, and rejects rather than repairs;
 *   * drops every unstable operational field — row id, company id, trace id,
 *     fetched_at, created_at, text_pruned_at — because a fixture that changes
 *     when nothing about the evidence changed is not evidence;
 *   * normalises line endings and strips C0/C1 control characters, which are
 *     invisible and can make two identical pages hash differently;
 *   * caps page text, page count and total fixture size;
 *   * derives the fixture's filename from the canonical domain through a strict
 *     allowlist, so a hostile domain string cannot become a path;
 *   * preserves the Tier A scan exactly, including `unknown` as distinct from
 *     `absent` (§9: only the scanner may say absent, and §10 pays 35 points
 *     for absence).
 *
 * ## What it does not do
 *
 * It does not invent evidence. A page with no stored text keeps `text: null`
 * rather than an empty string, because "we have no text for this page" and "this
 * page is blank" are different facts and §10 scores them differently.
 *
 * It does not strip published names, phone numbers or business email addresses
 * out of page text. §9 freezes contact discovery to "names, roles and addresses
 * published on pages the fetcher stored", and §10's reachability dimension is
 * scored from exactly that. Removing it would make the corpus unable to measure
 * the thing it exists to measure. The text here is the same sanitised text
 * already in `web_snapshots`, under the same §15 retention rules — the fixture
 * is a copy of evidence the system already holds, not a new collection of it.
 *
 * It never stores raw HTML. §8 keeps markup out of the database deliberately,
 * and a fixture file is not a loophole around that.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { registrableHost } from '../src/pipeline/domain';
import { canonicalCompact } from './canonical';
import {
  FIXTURE_FORMAT_VERSION,
  MAX_FIXTURE_BYTES,
  MAX_PAGES_PER_FIXTURE,
  MAX_PAGE_TEXT_CHARS,
  fixtureFile,
  type FixtureFile,
  type FixturePage,
  type FixtureSignals,
} from './schemas';
import { EXTRACTION_SCHEMA_VERSION } from '../src/ai/schemas/extraction-v1';

/** Thrown rather than returned: a malformed fixture must stop the freeze. */
export class SanitiserRejection extends Error {
  override readonly name = 'SanitiserRejection';

  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/**
 * One row as the freeze command selects it.
 *
 * Deliberately narrow. The columns absent from this type are the ones a fixture
 * must not carry, and the only way to add one is to add it here on purpose.
 */
export const sourceSnapshot = z
  .object({
    url: z.string().min(1),
    http_status: z.number().int().nullable(),
    robots_allowed: z.boolean(),
    content_hash: z.string().min(1).max(64),
    bytes: z.number().int().nullable(),
    text: z.string().nullable(),
    /** The stored jsonb. Shape-checked below, not trusted. */
    signals: z.unknown().nullable(),
    page_kind: z.string().nullable(),
  })
  .strict();

export type SourceSnapshot = z.infer<typeof sourceSnapshot>;

/**
 * C0 and C1 control characters, except tab and newline.
 *
 * Built from escapes rather than written as literals: a literal control
 * character in a source file is invisible to review, which is the opposite of
 * what a security-relevant regex should be.
 */
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g');

/**
 * Normalises page text without changing what it says.
 *
 * CRLF and CR become LF, control characters go, trailing whitespace on each line
 * goes, and runs of blank lines collapse to one. Every one of those is a change
 * that cannot alter the evidence and can alter the hash, which is the definition
 * of noise in a corpus meant to be diffed.
 *
 * What is NOT touched: the words, the punctuation, the non-ASCII characters, the
 * case. A firm called "Müller & Co" stays that.
 */
export function normaliseFixtureText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARACTERS, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** sha256, lower-case hex. One helper so every digest in the corpus matches. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The fixture's stable identifier.
 *
 * Derived from the set and the domain, so it is the same on every machine and
 * in every run — and so that nothing in a fixture file is a runtime uuid. 128
 * bits of sha256 is an identifier, not a security claim.
 */
export function fixtureIdFor(fixtureSet: string, canonicalDomain: string): string {
  return sha256(`${fixtureSet}\n${canonicalDomain}`).slice(0, 32);
}

/**
 * The filename for a fixture, with the path question answered once.
 *
 * The domain arrives from the database, which got it from discovery, which got
 * it from the internet. So it is treated as hostile: the registrable domain is
 * re-derived through the Public Suffix List, and then the *result* must still
 * match a narrow allowlist before it is allowed to be a filename. `..`,
 * separators, absolute paths, NUL bytes, Windows drive letters and anything
 * with a character outside `[a-z0-9.-]` are rejected rather than escaped.
 *
 * Rejecting is right rather than cautious: a domain that cannot be a filename is
 * a domain that should not be in the corpus, and silently rewriting it would
 * give two different firms one fixture.
 */
const SAFE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function safeFixtureFilename(canonicalDomain: string): string {
  const trimmed = canonicalDomain.trim().toLowerCase();

  // Asked of the list, not of the string. `firm.com.au/../../etc` has no
  // registrable domain; `firm.com.au` does, and it is what comes back.
  const parsed = registrableHost(trimmed);
  if (parsed.isIp) {
    throw new SanitiserRejection('unsafe_domain', `${trimmed} is an IP address`);
  }
  if (parsed.registrableDomain === null) {
    throw new SanitiserRejection(
      'unsafe_domain',
      `${trimmed} has no registrable domain, so it cannot identify a firm`,
    );
  }
  if (parsed.registrableDomain !== trimmed) {
    throw new SanitiserRejection(
      'unsafe_domain',
      `${trimmed} is not its own registrable domain (${parsed.registrableDomain}); ` +
        'a fixture is keyed on §4 canonical_domain',
    );
  }
  if (!SAFE_DOMAIN.test(trimmed) || trimmed.length > 253) {
    throw new SanitiserRejection('unsafe_domain', `${trimmed} is not a safe filename`);
  }
  return `${trimmed}.json`;
}

/**
 * The Tier A block, shape-checked and carried through unchanged.
 *
 * `signals` is jsonb written by the fetcher, so its *shape* is checked before
 * its contents. A row whose scan is missing or unrecognisable becomes
 * `signals: null`, which the fixture schema permits and which every reader must
 * treat as "no scanner looked" — never as "nothing was found".
 *
 * The mapping from the scanner's booleans to present/absent/unknown is
 * production's own (`assembleSignals` in the web.extract handler), imported
 * rather than restated. A second implementation of "absent versus unknown"
 * would be a second chance to get §9 wrong.
 */
function freezeSignals(
  stored: unknown,
  assemble: (signals: never) => FixtureSignals,
): FixtureSignals | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return null;
  }
  const candidate = stored as Record<string, unknown>;
  // The scanner's own output always carries these. Anything else is not a scan.
  if (typeof candidate.signals_version !== 'string' || typeof candidate.paid_search_tag !== 'boolean') {
    return null;
  }
  return assemble(candidate as never);
}

export interface SanitiseInput {
  readonly fixtureSet: string;
  readonly canonicalDomain: string;
  readonly snapshots: readonly unknown[];
  /** Production's own Tier A presence mapping, injected to keep one copy of it. */
  readonly assembleSignals: (signals: never) => FixtureSignals;
}

/**
 * Turns stored snapshots into one frozen fixture, or throws.
 *
 * Pages are ordered deterministically — by URL, ascending — rather than by
 * whatever order the query returned. A fixture's page order is data, and data
 * that depends on a query plan is not deterministic.
 */
export function sanitiseToFixture(input: SanitiseInput): FixtureFile {
  if (input.snapshots.length === 0) {
    throw new SanitiserRejection(
      'no_evidence',
      `${input.canonicalDomain} has no snapshots to freeze; a fixture with no evidence ` +
        'would be a fixture that evaluates nothing',
    );
  }
  if (input.snapshots.length > MAX_PAGES_PER_FIXTURE) {
    throw new SanitiserRejection(
      'too_many_pages',
      `${input.snapshots.length} pages for ${input.canonicalDomain}, cap ${MAX_PAGES_PER_FIXTURE} ` +
        '(§10 stage 3 fetches at most six)',
    );
  }

  // Validated before the filename is derived, so an unsafe domain cannot reach
  // the disk even if a later step is reordered.
  safeFixtureFilename(input.canonicalDomain);

  const pages: FixturePage[] = input.snapshots.map((raw, index) => {
    const parsed = sourceSnapshot.safeParse(raw);
    if (!parsed.success) {
      throw new SanitiserRejection(
        'malformed_snapshot',
        `page ${index} of ${input.canonicalDomain}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
          .join('; ')}`,
      );
    }
    const row = parsed.data;

    if (row.text !== null && row.text.length > MAX_PAGE_TEXT_CHARS) {
      throw new SanitiserRejection(
        'page_too_large',
        `${row.url} holds ${row.text.length} characters, cap ${MAX_PAGE_TEXT_CHARS}`,
      );
    }

    const normalised = row.text === null ? null : normaliseFixtureText(row.text);
    const kind = row.page_kind;

    return {
      page_kind:
        kind === 'home' ||
        kind === 'about' ||
        kind === 'practice_areas' ||
        kind === 'contact' ||
        kind === 'team' ||
        kind === 'location'
          ? kind
          : null,
      url: row.url,
      http_status: row.http_status,
      robots_allowed: row.robots_allowed,
      content_hash: row.content_hash,
      bytes: row.bytes,
      text: normalised,
      text_sha256: normalised === null ? null : sha256(normalised),
      signals: freezeSignals(row.signals, input.assembleSignals),
    };
  });

  // Deterministic page order, independent of the query plan.
  pages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const candidate = {
    fixture_format_version: FIXTURE_FORMAT_VERSION,
    fixture_id: fixtureIdFor(input.fixtureSet, input.canonicalDomain),
    fixture_set: input.fixtureSet,
    canonical_domain: input.canonicalDomain,
    extraction_schema_version: EXTRACTION_SCHEMA_VERSION,
    pages,
    content_digest: sha256(canonicalCompact(pages)),
  };

  // Its own schema, applied to its own output. The freeze cannot emit a file the
  // runner would later refuse to load.
  const validated = fixtureFile.safeParse(candidate);
  if (!validated.success) {
    throw new SanitiserRejection(
      'invalid_fixture',
      `${input.canonicalDomain}: ${validated.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }

  const size = Buffer.byteLength(canonicalCompact(validated.data), 'utf8');
  if (size > MAX_FIXTURE_BYTES) {
    throw new SanitiserRejection(
      'fixture_too_large',
      `${input.canonicalDomain} serialises to ${size} bytes, cap ${MAX_FIXTURE_BYTES}`,
    );
  }

  return validated.data;
}

/** Re-reads a fixture from disk content, rejecting anything that drifted. */
export function parseFixture(raw: string, where: string): FixtureFile {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FIXTURE_BYTES) {
    throw new SanitiserRejection('fixture_too_large', `${where} is over ${MAX_FIXTURE_BYTES} bytes`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new SanitiserRejection(
      'malformed_json',
      `${where}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = fixtureFile.safeParse(json);
  if (!parsed.success) {
    throw new SanitiserRejection(
      'invalid_fixture',
      `${where}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }

  // The integrity check. A fixture whose digest does not match its pages has
  // been edited by hand or corrupted, and either way it is not the evidence it
  // claims to be.
  const expected = sha256(canonicalCompact(parsed.data.pages));
  if (parsed.data.content_digest !== expected) {
    throw new SanitiserRejection(
      'digest_mismatch',
      `${where} declares ${parsed.data.content_digest} but its pages hash to ${expected}`,
    );
  }

  const expectedId = fixtureIdFor(parsed.data.fixture_set, parsed.data.canonical_domain);
  if (parsed.data.fixture_id !== expectedId) {
    throw new SanitiserRejection(
      'fixture_id_mismatch',
      `${where} declares ${parsed.data.fixture_id}, derived is ${expectedId}`,
    );
  }

  return parsed.data;
}
