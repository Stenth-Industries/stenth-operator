/**
 * The frozen fixture format (SPEC.md §21, §25 Day 5).
 *
 * §21 is the eval-fixture section and §25's Day 5 row names the pieces: "fixture
 * format, snapshot sanitiser, frozen snapshots, eval/run.ts, metrics, markdown
 * report, dev/holdout split". This file is the first of those, and everything
 * else in the harness reads fixtures only through it.
 *
 * ## What a fixture is
 *
 * One company. One registrable domain. The pages §10 stage 3 fetched for it,
 * with the sanitised page text and the deterministic Tier A scan that were
 * already stored against each snapshot — and nothing else. A fixture is enough
 * to evaluate a qualification decision without touching the network, which is
 * the whole point: §21's corpus has to be replayable in two minutes, offline,
 * for ever.
 *
 * ## What is deliberately absent
 *
 * No database row ids, no trace ids, no worker ids, no `created_at`, no
 * `fetched_at`, no job state — and **no freeze timestamp either**. A fixture's
 * identity is its content, so re-freezing unchanged source material produces
 * byte-identical output; a "frozen_at" field would break that for no gain, and
 * the facts that matter for provenance (which set, which domain, which URL,
 * which content hash) are all stable. When a stable identifier is needed it is
 * derived — `fixtureId` is a hash of the set and the domain, never a runtime
 * uuid.
 *
 * Human decisions and split assignment live in their own files beside the
 * fixture, not inside it: a fixture is evidence and must not change when
 * someone labels it.
 *
 * ## Strictness
 *
 * Every object is `.strict()`. A fixture with an unknown key is rejected rather
 * than tolerated, for the same reason §8 rejects unknown keys from a model: a
 * field nobody declared is a field nobody validates, and this corpus is the
 * ground truth Day 6's thresholds will be derived from.
 */
import { z } from 'zod';

import { EXTRACTION_SCHEMA_VERSION, tierAPresence } from '../src/ai/schemas/extraction-v1';

/** Stamped on every fixture file, so a format change is visible in the data. */
export const FIXTURE_FORMAT_VERSION = 'eval-fixture-v1';

/**
 * Caps. Generous for a real law firm's site, far too small to be a dumping
 * ground — §8's reasoning about length caps applies to anything this project
 * stores, not only to model output.
 */
export const MAX_PAGE_TEXT_CHARS = 200_000;
export const MAX_PAGES_PER_FIXTURE = 6;
export const MAX_FIXTURE_BYTES = 2_000_000;
export const MAX_URL_LENGTH = 2_048;

/**
 * The Tier A block, exactly as the production pipeline records it.
 *
 * Reusing `tierAPresence` from the extraction schema rather than restating it
 * is the point: §9 makes `unknown` a first-class answer distinct from `absent`,
 * because only the scanner may say absent and §10 pays 35 points for absence.
 * A fixture that collapsed the two would quietly hand those points to a company
 * nobody scanned.
 */
export const fixtureSignals = z
  .object({
    signals_version: z.string().min(1).max(64),
    paid_search_tag: tierAPresence,
    currently_advertising: z.literal('unknown'),
    analytics_ga4: tierAPresence,
    tag_manager: tierAPresence,
    call_tracking: tierAPresence,
    tel_link: tierAPresence,
    contact_form: tierAPresence,
    responsive_viewport: tierAPresence,
    location_page_links: z.number().int().min(0).max(500).nullable(),
    copyright_year: z.number().int().min(1980).max(2100).nullable(),
  })
  .strict();

export type FixtureSignals = z.infer<typeof fixtureSignals>;

export const fixturePage = z
  .object({
    /** §10 stage 3's page kind, when the job that fetched it recorded one. */
    page_kind: z
      .enum(['home', 'about', 'practice_areas', 'contact', 'team', 'location'])
      .nullable(),
    /** The snapshot's final URL, after redirects. */
    url: z.string().min(1).max(MAX_URL_LENGTH),
    http_status: z.number().int().min(100).max(599).nullable(),
    robots_allowed: z.boolean(),
    /** The stored snapshot's own integrity field, carried through unchanged. */
    content_hash: z.string().min(1).max(64),
    bytes: z.number().int().min(0).nullable(),
    /**
     * The sanitised page text, as the fetcher stored it — never raw HTML.
     *
     * §8 keeps markup out of the database on purpose, and a fixture is not a
     * loophole: the corpus holds the same sanitised text the pipeline holds.
     * Null where the snapshot carries none, which is a real state (a robots
     * refusal, a 4xx diagnostic row, or text pruned under §15) and never an
     * invitation to invent some.
     */
    text: z.string().max(MAX_PAGE_TEXT_CHARS).nullable(),
    /** sha256 of `text`, so a tampered fixture is detectable without the DB. */
    text_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    /** Null means no scanner looked, which is not the same as nothing found. */
    signals: fixtureSignals.nullable(),
  })
  .strict();

export type FixturePage = z.infer<typeof fixturePage>;

export const fixtureSetName = z
  .string()
  .min(1)
  .max(64)
  // A fixture-set name becomes a directory name. Narrow by construction rather
  // than sanitised after the fact.
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'a fixture set is lower-case letters, digits and hyphens');

export const fixtureFile = z
  .object({
    fixture_format_version: z.literal(FIXTURE_FORMAT_VERSION),
    /** Derived from the set and the domain. Never a runtime uuid. */
    fixture_id: z.string().regex(/^[0-9a-f]{32}$/),
    fixture_set: fixtureSetName,
    /** §4's canonical_domain: the registrable domain, lowercased, no www. */
    canonical_domain: z.string().min(3).max(253),
    /** Which extraction schema the frozen signals block belongs to. */
    extraction_schema_version: z.literal(EXTRACTION_SCHEMA_VERSION),
    pages: z.array(fixturePage).min(1).max(MAX_PAGES_PER_FIXTURE),
    /** sha256 over the canonical form of `pages`. The integrity field. */
    content_digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type FixtureFile = z.infer<typeof fixtureFile>;

// ---------------------------------------------------------------------------
// The human label, which lives beside the fixture and never inside it
// ---------------------------------------------------------------------------

/**
 * §4's `eval_label`: two values, and the software never supplies either.
 *
 * §25's Day 5 exit criterion is "Kushagra labels 60 fixtures". The ground truth
 * is a human's, so nothing in this harness infers, defaults or guesses a label —
 * there is no code path that writes one without `--label` and `--by` on a
 * command line.
 */
export const evalLabel = z.enum(['qualified', 'rejected']);
export type EvalLabel = z.infer<typeof evalLabel>;

export const fixtureLabel = z
  .object({
    label: evalLabel,
    /** §4's label_reason_codes. Free-form tokens: Day 6 owns the vocabulary. */
    reason_codes: z.array(z.string().min(1).max(64).regex(/^[a-z0-9_]+$/)).max(16),
    /** §10's hard disqualifier, when one applies. */
    disqualifier: z.string().min(1).max(120).nullable(),
    labelled_by: z.string().min(1).max(120),
    /** Generated by the tool, not typed by the human. */
    labelled_at: z.string().datetime(),
  })
  .strict();

export type FixtureLabel = z.infer<typeof fixtureLabel>;

/** `labels.json`: domain -> the human's decision. */
export const labelsFile = z
  .object({
    fixture_set: fixtureSetName,
    labels: z.record(z.string().min(3).max(253), fixtureLabel),
  })
  .strict();

export type LabelsFile = z.infer<typeof labelsFile>;

// ---------------------------------------------------------------------------
// The split manifest, which is checked in and append-only
// ---------------------------------------------------------------------------

export const evalSplit = z.enum(['dev', 'holdout']);
export type EvalSplit = z.infer<typeof evalSplit>;

/**
 * `split.json`: domain -> dev or holdout, and nothing else.
 *
 * Checked in, so the assignment is reviewable in a diff and identical on every
 * machine. Append-only, so a fixture cannot drift between splits — see
 * eval/split.ts for why that matters more than it sounds.
 */
export const splitFile = z
  .object({
    fixture_set: fixtureSetName,
    assignments: z.record(z.string().min(3).max(253), evalSplit),
  })
  .strict();

export type SplitFile = z.infer<typeof splitFile>;
