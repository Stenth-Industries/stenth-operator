/**
 * The isolated extraction schema, v1 (SPEC.md §8, §9, §10 stage 4).
 *
 * §8: "Output is parsed with a strict Zod schema — unknown keys rejected, every
 * string length-capped." Both halves matter. Unknown keys rejected means a
 * model that invents a field fails rather than smuggling one through; every
 * string capped means a page cannot make the model echo a megabyte of itself
 * into the database.
 *
 * What is NOT here is as deliberate as what is. The model is asked for firm
 * shape, people and published contact details — things that need language. It
 * is never asked for a Tier A tag, because §9 says those are read out of the
 * HTML by code and §23 case 13 says a page claiming "we run Google Ads" must
 * not move the signal. With `.strict()`, a model that returns
 * `paid_search_tag` fails validation: it is not that we ignore its answer, it
 * is that there is no field for it to answer in.
 */
import { z } from 'zod';

/** Stamped on every extraction row. Part of the §4 uniqueness key. */
export const EXTRACTION_SCHEMA_VERSION = 'extraction-v1';

/** Caps. Generous enough for a real firm, far too small to carry a page. */
const SHORT = 120;
const MEDIUM = 300;
const NOTE = 600;

const shortText = z.string().trim().min(1).max(SHORT);
const mediumText = z.string().trim().min(1).max(MEDIUM);

/** Australian states and territories, plus an explicit unknown. */
export const auState = z.enum(['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA', 'unknown']);

/**
 * A band rather than a number.
 *
 * §10 scores "3-25 lawyers, with 5-15 scoring highest", so a band is all the
 * rubric can use — and a model asked for an exact headcount from an About page
 * will produce one whether or not the page supports it. Bands make the honest
 * answer available.
 */
export const lawyerCountBand = z.enum(['1', '2-4', '5-15', '16-50', '50+', 'unknown']);

export const practiceArea = z.object({
  name: shortText,
  /** Where on the page it was found, so §16's provenance rule has something to resolve. */
  evidence_quote: mediumText,
}).strict();

export const namedPerson = z.object({
  full_name: shortText,
  role_title: shortText.optional(),
  /** §10's reachability dimension asks whether one person decides. */
  is_decision_maker: z.boolean(),
  evidence_quote: mediumText,
}).strict();

export const publishedContact = z.object({
  kind: z.enum(['email', 'phone', 'address', 'contact_form']),
  value: mediumText,
  /** §9: the context an address appears in is part of the consent evidence. */
  evidence_quote: mediumText,
  /** §10 and §23 case 12: a no-unsolicited-contact notice blocks approval. */
  carries_no_unsolicited_notice: z.boolean(),
}).strict();

/**
 * The model's output, and nothing else.
 *
 * `currently_advertising` is absent on purpose: §9 says Tier A can never
 * observe it, so it is not a question the model is allowed to answer. The
 * assembled payload records it as unknown, from code.
 */
export const isolatedExtractionSchema = z
  .object({
    is_australian_law_firm: z.boolean(),
    /** §10's hard disqualifiers, each as a flag the model can see on the page. */
    appears_to_be_barrister_chambers: z.boolean(),
    appears_to_be_marketing_agency: z.boolean(),
    appears_to_be_community_legal_centre: z.boolean(),
    appears_parked_or_under_construction: z.boolean(),

    firm_name: shortText.optional(),
    lawyer_count_band: lawyerCountBand,
    office_locations: z.array(shortText).max(12),
    primary_state: auState,
    practice_areas: z.array(practiceArea).max(12),
    named_people: z.array(namedPerson).max(12),
    published_contacts: z.array(publishedContact).max(12),

    /** One line, for a human reading the extraction. Never used for scoring. */
    summary: z.string().trim().max(NOTE).optional(),

    /**
     * Advisory only (§8). Code filters it to the same registrable domain, an
     * allowlist of path patterns, at most five, depth at most two. "The model
     * never causes a fetch directly."
     */
    next_urls: z.array(z.string().max(2_048)).max(5).optional(),
  })
  .strict();

export type IsolatedExtraction = z.infer<typeof isolatedExtractionSchema>;

/** Tier A, as recorded. `unknown` is a first-class answer — see §9. */
export const tierAPresence = z.enum(['present', 'absent', 'unknown']);

/**
 * The stored payload: the model's facts, plus the scanner's signals, plus the
 * provenance that §16 requires of every stored assertion.
 */
export const extractionPayloadSchema = z
  .object({
    schema_version: z.literal(EXTRACTION_SCHEMA_VERSION),
    prompt_version: z.string().max(64),
    /** §16: every assertion carries the snapshot it came from. */
    source_snapshot_id: z.string().uuid(),
    source_url: z.string().max(2_048),
    firm: isolatedExtractionSchema,
    signals: z
      .object({
        signals_version: z.string().max(64),
        /** §9: present, absent — and unknown when no scanner has looked. */
        paid_search_tag: tierAPresence,
        /** §9: "in Tier A [this] is always unknown". Not a model output. */
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
      .strict(),
  })
  .strict();

export type ExtractionPayload = z.infer<typeof extractionPayloadSchema>;
