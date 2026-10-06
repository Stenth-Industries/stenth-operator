/**
 * Drizzle schema (SPEC.md §3, §19).
 *
 * Migrations are hand-written SQL in migrations/ and are the single source of
 * truth for the database. This file mirrors them for queries and types; it
 * never generates them. tests/unit/schema-matches-migration.test.ts asserts the
 * two stay in step, because a schema that has quietly drifted from the SQL is
 * worse than no schema at all.
 */
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Postgres citext. Case-insensitive by collation, not by lower() at call sites. */
const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums (§4)
// ---------------------------------------------------------------------------

export const userRole = pgEnum('user_role', ['operator']);
export const campaignStatus = pgEnum('campaign_status', ['active', 'paused', 'archived']);
export const sourceKind = pgEnum('source_kind', ['search_query', 'manual']);
export const verdict = pgEnum('verdict', ['qualified', 'uncertain', 'rejected']);
export const discoverySource = pgEnum('discovery_source', ['own_site_published']);
export const consentBasis = pgEnum('consent_basis', ['express', 'inferred_published', 'none']);
export const prospectStage = pgEnum('prospect_stage', [
  'discovered',
  'assessed',
  'contact_resolved',
  'drafted',
  'approved',
  'rejected',
  'suppressed',
  'snoozed',
]);
export const outreachDraftStatus = pgEnum('outreach_draft_status', [
  'pending_review',
  'approved',
  'rejected',
  'superseded',
]);
export const reviewReasonCode = pgEnum('review_reason_code', [
  'bad_fit',
  'wrong_contact',
  'weak_angle',
  'factual_error',
  'tone',
  'compliance',
  'other',
]);
export const handoffState = pgEnum('handoff_state', [
  'ready',
  'opened',
  'marked_sent',
  'abandoned',
]);
export const suppressionMatchType = pgEnum('suppression_match_type', [
  'domain',
  'email',
  'company_id',
]);
export const suppressionReason = pgEnum('suppression_reason', [
  'existing_client',
  'existing_prospect',
  'unsubscribed',
  'complaint',
  'do_not_contact',
  'competitor',
  'manual',
]);
export const jobKind = pgEnum('job_kind', [
  'discover.search',
  'company.resolve',
  'web.fetch',
  'web.extract',
  'company.assess',
  'contact.resolve',
  'outreach.draft',
  'maintenance.prune',
  'eval.run',
]);
export const jobStatus = pgEnum('job_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'dead',
]);
export const jobRunStatus = pgEnum('job_run_status', ['running', 'succeeded', 'failed']);
export const actorType = pgEnum('actor_type', ['human', 'system', 'model']);
export const llmIsolation = pgEnum('llm_isolation', ['isolated_untrusted', 'privileged']);
export const llmCallStatus = pgEnum('llm_call_status', ['succeeded', 'failed', 'blocked']);
export const evalSplit = pgEnum('eval_split', ['dev', 'holdout']);
export const evalLabel = pgEnum('eval_label', ['qualified', 'rejected']);

// ---------------------------------------------------------------------------
// Tables (§4)
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: id(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('operator'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const campaigns = pgTable('campaigns', {
  id: id(),
  slug: citext('slug').notNull().unique(),
  name: text('name').notNull(),
  icp: jsonb('icp').notNull().default({}),
  angleLibrary: jsonb('angle_library').notNull().default([]),
  rubricVersion: text('rubric_version').notNull(),
  maxDraftsPerDay: integer('max_drafts_per_day').notNull().default(8),
  status: campaignStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const companies = pgTable('companies', {
  id: id(),
  canonicalDomain: citext('canonical_domain').notNull().unique(),
  legalName: text('legal_name'),
  state: text('state'),
  suburb: text('suburb'),
  phone: text('phone'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const companySources = pgTable(
  'company_sources',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    sourceKind: sourceKind('source_kind').notNull(),
    sourceRef: text('source_ref').notNull(),
    raw: jsonb('raw').notNull().default({}),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (table) => [index('company_sources_company_id_idx').on(table.companyId)],
);

export const webSnapshots = pgTable(
  'web_snapshots',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    url: text('url').notNull(),
    httpStatus: integer('http_status'),
    contentHash: text('content_hash').notNull(),
    /** UNTRUSTED page text. Pruned after 90 days (§16). */
    text: text('text'),
    bytes: integer('bytes'),
    robotsAllowed: boolean('robots_allowed').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    textPrunedAt: timestamp('text_pruned_at', { withTimezone: true }),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('web_snapshots_company_url_hash_key').on(
      table.companyId,
      table.url,
      table.contentHash,
    ),
    index('web_snapshots_company_id_fetched_at_idx').on(table.companyId, table.fetchedAt.desc()),
  ],
);

export const extractions = pgTable(
  'extractions',
  {
    id: id(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => webSnapshots.id),
    schemaVersion: text('schema_version').notNull(),
    extractorModel: text('extractor_model').notNull(),
    payload: jsonb('payload').notNull().default({}),
    valid: boolean('valid').notNull(),
    validationErrors: jsonb('validation_errors'),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('extractions_snapshot_schema_model_key').on(
      table.snapshotId,
      table.schemaVersion,
      table.extractorModel,
    ),
  ],
);

/** Append-only audit spine (§4). Never carries personal text (§16). */
export const events = pgTable(
  'events',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    kind: text('kind').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    payload: jsonb('payload').notNull().default({}),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('events_entity_created_at_idx').on(table.entityType, table.entityId, table.createdAt),
    index('events_trace_id_idx').on(table.traceId),
  ],
);

export const assessments = pgTable(
  'assessments',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    rubricVersion: text('rubric_version').notNull(),
    verdict: verdict('verdict').notNull(),
    score: integer('score').notNull(),
    subscores: jsonb('subscores').notNull().default({}),
    reasons: jsonb('reasons').notNull().default([]),
    evidenceKeys: text('evidence_keys').array().notNull().default(sql`'{}'`),
    contentHash: text('content_hash').notNull(),
    supersededBy: uuid('superseded_by'),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('assessments_company_campaign_rubric_hash_key').on(
      table.companyId,
      table.campaignId,
      table.rubricVersion,
      table.contentHash,
    ),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    fullName: text('full_name'),
    roleTitle: text('role_title'),
    email: citext('email'),
    /** NOT NULL by design (§9): no stored page behind it, no address. */
    emailSourceSnapshotId: uuid('email_source_snapshot_id')
      .notNull()
      .references(() => webSnapshots.id),
    discoverySource: discoverySource('discovery_source').notNull().default('own_site_published'),
    consentBasis: consentBasis('consent_basis').notNull(),
    consentEvidence: jsonb('consent_evidence'),
    roleRelevant: boolean('role_relevant').notNull().default(false),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    redactionEventId: uuid('redaction_event_id').references(() => events.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('contacts_company_id_idx').on(table.companyId),
    index('contacts_email_idx').on(table.email),
  ],
);

export const prospects = pgTable(
  'prospects',
  {
    id: id(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    stage: prospectStage('stage').notNull().default('discovered'),
    rankScore: numeric('rank_score', { precision: 6, scale: 4 }),
    rankingVersion: text('ranking_version'),
    assessmentId: uuid('assessment_id').references(() => assessments.id),
    contactId: uuid('contact_id').references(() => contacts.id),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('prospects_company_campaign_key').on(table.companyId, table.campaignId),
    index('prospects_campaign_stage_rank_idx').on(
      table.campaignId,
      table.stage,
      table.rankScore.desc(),
    ),
  ],
);

export const outreachDrafts = pgTable(
  'outreach_drafts',
  {
    id: id(),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    variantNo: integer('variant_no').notNull(),
    subject: text('subject'),
    bodyText: text('body_text'),
    humanEditedBody: text('human_edited_body'),
    angle: text('angle'),
    evidenceKeys: text('evidence_keys').array().notNull().default(sql`'{}'`),
    promptVersion: text('prompt_version').notNull(),
    status: outreachDraftStatus('status').notNull().default('pending_review'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewReasonCode: reviewReasonCode('review_reason_code'),
    reviewNote: text('review_note'),
    traceId: text('trace_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('outreach_drafts_prospect_contact_prompt_variant_key').on(
      table.prospectId,
      table.contactId,
      table.promptVersion,
      table.variantNo,
    ),
    /** §4: one pending_review per (prospect_id, contact_id). */
    uniqueIndex('outreach_drafts_one_pending_review_key')
      .on(table.prospectId, table.contactId)
      .where(sql`status = 'pending_review'`),
  ],
);

/** Immutable record of exactly what a human approved (§4, §14). */
export const approvedOutreach = pgTable(
  'approved_outreach',
  {
    id: id(),
    outreachDraftId: uuid('outreach_draft_id')
      .notNull()
      .unique()
      .references(() => outreachDrafts.id),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    toEmail: citext('to_email'),
    subject: text('subject'),
    bodyText: text('body_text'),
    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    approvalEventId: uuid('approval_event_id').notNull(),
    contentHash: text('content_hash').notNull(),
    handoffState: handoffState('handoff_state').notNull().default('ready'),
    markedSentAt: timestamp('marked_sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('approved_outreach_handoff_state_idx').on(table.handoffState)],
);

export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    matchType: suppressionMatchType('match_type').notNull(),
    matchValue: citext('match_value').notNull(),
    reason: suppressionReason('reason').notNull(),
    source: text('source'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('suppressions_match_type_value_key').on(
      table.matchType,
      sql`lower(${table.matchValue})`,
    ),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: jobKind('kind').notNull(),
    /** Unique: every enqueue is ON CONFLICT (dedupe_key) DO NOTHING (§7). */
    dedupeKey: text('dedupe_key').notNull().unique(),
    payload: jsonb('payload').notNull().default({}),
    status: jobStatus('status').notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    parentJobId: uuid('parent_job_id'),
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('jobs_status_run_after_priority_idx').on(
      table.status,
      table.runAfter,
      table.priority.desc(),
    ),
    index('jobs_running_locked_at_idx')
      .on(table.lockedAt)
      .where(sql`status = 'running'`),
    index('jobs_trace_id_idx').on(table.traceId),
  ],
);

export const jobRuns = pgTable(
  'job_runs',
  {
    id: id(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: jobRunStatus('status').notNull(),
    error: text('error'),
  },
  (table) => [uniqueIndex('job_runs_job_attempt_key').on(table.jobId, table.attempt)],
);

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: id(),
    traceId: text('trace_id').notNull(),
    jobId: uuid('job_id').references(() => jobs.id),
    purpose: text('purpose').notNull(),
    isolation: llmIsolation('isolation').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    status: llmCallStatus('status').notNull(),
    requestHash: text('request_hash'),
    createdAt: createdAt(),
  },
  (table) => [
    index('llm_calls_trace_id_idx').on(table.traceId),
    index('llm_calls_created_at_idx').on(table.createdAt),
  ],
);

export const modelPricing = pgTable(
  'model_pricing',
  {
    id: id(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputPerMtok: numeric('input_per_mtok', { precision: 12, scale: 6 }).notNull(),
    outputPerMtok: numeric('output_per_mtok', { precision: 12, scale: 6 }).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('model_pricing_provider_model_effective_key').on(
      table.provider,
      table.model,
      table.effectiveFrom,
    ),
  ],
);

/** The ceiling (§2, §16): $50/month, warning at $35, hard stop at $50 in V1. */
export const budgets = pgTable('budgets', {
  id: id(),
  periodMonth: date('period_month').notNull().unique(),
  limitUsd: numeric('limit_usd', { precision: 12, scale: 2 }).notNull(),
  warnUsd: numeric('warn_usd', { precision: 12, scale: 2 }).notNull(),
  hardStopUsd: numeric('hard_stop_usd', { precision: 12, scale: 2 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const schedules = pgTable(
  'schedules',
  {
    id: id(),
    kind: jobKind('kind').notNull(),
    cron: text('cron').notNull(),
    payload: jsonb('payload').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('schedules_due_idx').on(table.nextRunAt).where(sql`enabled`)],
);

export const evalFixtures = pgTable(
  'eval_fixtures',
  {
    id: id(),
    fixtureSet: text('fixture_set').notNull(),
    split: evalSplit('split').notNull(),
    domain: citext('domain').notNull(),
    label: evalLabel('label').notNull(),
    labelReasonCodes: text('label_reason_codes').array().notNull().default(sql`'{}'`),
    disqualifier: text('disqualifier'),
    labelledBy: text('labelled_by'),
    labelledAt: timestamp('labelled_at', { withTimezone: true }),
    snapshotPath: text('snapshot_path').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('eval_fixtures_set_domain_key').on(table.fixtureSet, table.domain)],
);

export const evalRuns = pgTable('eval_runs', {
  id: id(),
  fixtureSet: text('fixture_set').notNull(),
  split: evalSplit('split').notNull(),
  rubricVersion: text('rubric_version').notNull(),
  promptVersion: text('prompt_version').notNull(),
  model: text('model').notNull(),
  metrics: jsonb('metrics').notNull().default({}),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  createdAt: createdAt(),
});

export const evalResults = pgTable(
  'eval_results',
  {
    id: id(),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRuns.id),
    fixtureId: uuid('fixture_id')
      .notNull()
      .references(() => evalFixtures.id),
    predictedVerdict: verdict('predicted_verdict').notNull(),
    predictedScore: integer('predicted_score'),
    correct: boolean('correct').notNull(),
    reasons: jsonb('reasons').notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('eval_results_run_fixture_key').on(table.evalRunId, table.fixtureId)],
);

/** Human-maintained vertical value table (§9). Never written by a model. */
export const practiceAreaPriors = pgTable(
  'practice_area_priors',
  {
    id: id(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    practiceArea: citext('practice_area').notNull(),
    valueBand: smallint('value_band').notNull(),
    note: text('note'),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('practice_area_priors_campaign_area_key').on(table.campaignId, table.practiceArea),
  ],
);

/**
 * Liveness of the in-process scheduler (migration 003, §6, §20).
 *
 * One row. Distinct from schedules.last_run_at: this records that the scheduler
 * ticked, which is true even when nothing was due.
 */
export const schedulerHeartbeat = pgTable('scheduler_heartbeat', {
  id: boolean('id').primaryKey().default(true),
  lastTickAt: timestamp('last_tick_at', { withTimezone: true }).notNull(),
  lastTickBy: text('last_tick_by').notNull(),
});

export const robotsCache = pgTable('robots_cache', {
  id: id(),
  host: citext('host').notNull().unique(),
  body: text('body'),
  crawlDelaySeconds: numeric('crawl_delay_seconds', { precision: 6, scale: 2 }),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});
