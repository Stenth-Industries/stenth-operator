-- 001_init.sql — STENTH Operator V1.1 initial schema.
--
-- Covers every table in SPEC.md §4. Forward-only: this file is never edited
-- once applied (SPEC.md §19 rule 3). Every statement is guarded so the file is
-- individually re-runnable on a fresh database as well as idempotent through
-- the schema_migrations ledger.
--
-- Conventions from §4: all ids are uuid default gen_random_uuid(), all
-- timestamps are timestamptz, all enums are Postgres enum types.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- §4 users.role. §26 defers multi-user and roles, so V1 has one value.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('operator');
  END IF;

  -- §4 campaigns.status. Values not enumerated in the spec.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'campaign_status') THEN
    CREATE TYPE campaign_status AS ENUM ('active', 'paused', 'archived');
  END IF;

  -- §4 company_sources.source_kind. Values not enumerated in the spec;
  -- discovery in V1 is discover.search (§6) plus manual entry.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'source_kind') THEN
    CREATE TYPE source_kind AS ENUM ('search_query', 'manual');
  END IF;

  -- §4 assessments.verdict, also eval_results.predicted_verdict.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verdict') THEN
    CREATE TYPE verdict AS ENUM ('qualified', 'uncertain', 'rejected');
  END IF;

  -- §9: contact discovery is frozen to the firm's own published site, enforced
  -- structurally by an enum with exactly one permitted value in V1.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'discovery_source') THEN
    CREATE TYPE discovery_source AS ENUM ('own_site_published');
  END IF;

  -- §15 consent model.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consent_basis') THEN
    CREATE TYPE consent_basis AS ENUM ('express', 'inferred_published', 'none');
  END IF;

  -- §4 prospects.stage. Values not enumerated in the spec; derived from the
  -- pipeline stages of §6 and the review actions of §13.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'prospect_stage') THEN
    CREATE TYPE prospect_stage AS ENUM (
      'discovered', 'assessed', 'contact_resolved', 'drafted',
      'approved', 'rejected', 'suppressed', 'snoozed'
    );
  END IF;

  -- §4 outreach_drafts.status.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outreach_draft_status') THEN
    CREATE TYPE outreach_draft_status AS ENUM (
      'pending_review', 'approved', 'rejected', 'superseded'
    );
  END IF;

  -- §13: reason codes are mandatory and closed.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'review_reason_code') THEN
    CREATE TYPE review_reason_code AS ENUM (
      'bad_fit', 'wrong_contact', 'weak_angle', 'factual_error',
      'tone', 'compliance', 'other'
    );
  END IF;

  -- §4/§14 approved_outreach.handoff_state.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'handoff_state') THEN
    CREATE TYPE handoff_state AS ENUM ('ready', 'opened', 'marked_sent', 'abandoned');
  END IF;

  -- §4 suppressions.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'suppression_match_type') THEN
    CREATE TYPE suppression_match_type AS ENUM ('domain', 'email', 'company_id');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'suppression_reason') THEN
    CREATE TYPE suppression_reason AS ENUM (
      'existing_client', 'existing_prospect', 'unsubscribed', 'complaint',
      'do_not_contact', 'competitor', 'manual'
    );
  END IF;

  -- §6: nine job kinds. gmail.create_draft and maintenance.tick are gone in v1.1.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_kind') THEN
    CREATE TYPE job_kind AS ENUM (
      'discover.search', 'company.resolve', 'web.fetch', 'web.extract',
      'company.assess', 'contact.resolve', 'outreach.draft',
      'maintenance.prune', 'eval.run'
    );
  END IF;

  -- §6 job states. dead and blocked are terminal.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM (
      'queued', 'running', 'succeeded', 'failed', 'blocked', 'dead'
    );
  END IF;

  -- §4 job_runs.status. Values not enumerated in the spec.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_run_status') THEN
    CREATE TYPE job_run_status AS ENUM ('running', 'succeeded', 'failed');
  END IF;

  -- §4 events.actor_type.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'actor_type') THEN
    CREATE TYPE actor_type AS ENUM ('human', 'system', 'model');
  END IF;

  -- §4/§8 llm_calls.isolation — the trust boundary, recorded per call.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'llm_isolation') THEN
    CREATE TYPE llm_isolation AS ENUM ('isolated_untrusted', 'privileged');
  END IF;

  -- §4 llm_calls.status. Values not enumerated in the spec; 'blocked' is the
  -- budget hard stop of §16, which never contacts the provider.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'llm_call_status') THEN
    CREATE TYPE llm_call_status AS ENUM ('succeeded', 'failed', 'blocked');
  END IF;

  -- §21 fixture splits and labels.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'eval_split') THEN
    CREATE TYPE eval_split AS ENUM ('dev', 'holdout');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'eval_label') THEN
    CREATE TYPE eval_label AS ENUM ('qualified', 'rejected');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Append-only and write-once enforcement (§4, §16)
--
-- "If a guarantee can be structural, it must be structural" (§1). The audit
-- spine is append-only in the database, not by convention in a handler.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION forbid_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only (SPEC.md §4): % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- job_runs is append-only history (§4), but an attempt's outcome is recorded
-- when the attempt ends. Nothing already written may change; the completion
-- fields may be filled in exactly once, from null.
CREATE OR REPLACE FUNCTION job_runs_complete_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.job_id <> OLD.job_id
     OR NEW.attempt <> OLD.attempt
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION
      'job_runs identity and history are append-only (SPEC.md §4)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
    RAISE EXCEPTION
      'job_runs.finished_at is written once (SPEC.md §4)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'running' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'job_runs.status is terminal once the attempt has finished (SPEC.md §4)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

-- approved_outreach is the compliance-relevant artefact: the exact text a human
-- authorised. §4: "No row is ever updated except handoff_state and its
-- timestamp; the approved content itself is write-once." §15 step 2 must still
-- be able to redact personal text, so the personal columns may move to null —
-- never to different content.
CREATE OR REPLACE FUNCTION approved_outreach_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.outreach_draft_id <> OLD.outreach_draft_id
     OR NEW.prospect_id <> OLD.prospect_id
     OR NEW.contact_id <> OLD.contact_id
     OR NEW.approved_by <> OLD.approved_by
     OR NEW.approved_at <> OLD.approved_at
     OR NEW.approval_event_id <> OLD.approval_event_id
     OR NEW.content_hash <> OLD.content_hash
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION
      'approved_outreach is write-once apart from handoff_state (SPEC.md §4)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Personal text may only be removed (§15 redact_contact), never rewritten.
  IF (NEW.to_email IS DISTINCT FROM OLD.to_email AND NEW.to_email IS NOT NULL)
     OR (NEW.subject IS DISTINCT FROM OLD.subject AND NEW.subject IS NOT NULL)
     OR (NEW.body_text IS DISTINCT FROM OLD.body_text AND NEW.body_text IS NOT NULL) THEN
    RAISE EXCEPTION
      'approved content is write-once; redaction may only null it (SPEC.md §4, §15)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- users (§4) — the operator, for audit attribution
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,                       -- argon2id (§13)
  role          user_role NOT NULL DEFAULT 'operator',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- campaigns (§4) — an ICP plus an outreach angle
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               citext NOT NULL UNIQUE,
  name               text NOT NULL,
  icp                jsonb NOT NULL DEFAULT '{}'::jsonb,
  angle_library      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- §12
  rubric_version     text NOT NULL,
  max_drafts_per_day integer NOT NULL DEFAULT 8,            -- §11 daily cap
  status             campaign_status NOT NULL DEFAULT 'active',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_max_drafts_per_day_positive CHECK (max_drafts_per_day > 0)
);

-- ---------------------------------------------------------------------------
-- companies (§4) — one row per firm
--
-- canonical_domain unique is the deduplication guarantee (§4). Dropping it to
-- make a migration pass is a bug, not a shortcut.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_domain citext NOT NULL UNIQUE,   -- registrable domain, lowercased, no www
  legal_name       text,
  state            text,
  suburb           text,
  phone            text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- company_sources (§4) — how we found it
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS company_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies (id),
  source_kind source_kind NOT NULL,
  source_ref  text NOT NULL,
  raw         jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  trace_id    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_sources_company_id_idx
  ON company_sources (company_id);

-- ---------------------------------------------------------------------------
-- web_snapshots (§4) — UNTRUSTED raw page text
--
-- text is nullable because maintenance.prune removes it after 90 days while
-- keeping the hash and the extraction (§16), and because redaction may drop it
-- (§15 step 3).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS web_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  url            text NOT NULL,
  http_status    integer,
  content_hash   text NOT NULL,
  text           text,
  bytes          integer,
  robots_allowed boolean NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  text_pruned_at timestamptz,
  trace_id       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_snapshots_company_url_hash_key
    UNIQUE (company_id, url, content_hash)
);

CREATE INDEX IF NOT EXISTS web_snapshots_company_id_fetched_at_idx
  ON web_snapshots (company_id, fetched_at DESC);

-- ---------------------------------------------------------------------------
-- extractions (§4) — validated output of the isolated call
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS extractions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id       uuid NOT NULL REFERENCES web_snapshots (id),
  schema_version    text NOT NULL,
  extractor_model   text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid             boolean NOT NULL,
  validation_errors jsonb,
  trace_id          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extractions_snapshot_schema_model_key
    UNIQUE (snapshot_id, schema_version, extractor_model)
);

-- ---------------------------------------------------------------------------
-- events (§4) — append-only audit spine
--
-- §16: an event records entity ids, a kind, an actor and a reference, never a
-- copy of someone's name or address. That is what lets §15 redact personal
-- data while leaving audit history intact, "and it only works if it is enforced
-- from the first migration". The check below rejects the payload keys that
-- carry personal text; the triggers make the table append-only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  kind        text NOT NULL,
  actor_type  actor_type NOT NULL,
  actor_id    uuid,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_payload_carries_no_personal_text CHECK (
    NOT (payload ?| ARRAY[
      'email', 'to_email', 'full_name', 'name', 'phone', 'address',
      'subject', 'body', 'body_text', 'human_edited_body', 'consent_evidence'
    ])
  )
);

CREATE INDEX IF NOT EXISTS events_entity_created_at_idx
  ON events (entity_type, entity_id, created_at);

CREATE INDEX IF NOT EXISTS events_trace_id_idx ON events (trace_id);

DROP TRIGGER IF EXISTS events_no_update ON events;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_rewrite();

DROP TRIGGER IF EXISTS events_no_delete ON events;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_rewrite();

-- ---------------------------------------------------------------------------
-- assessments (§4) — qualification result
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assessments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  campaign_id    uuid NOT NULL REFERENCES campaigns (id),
  rubric_version text NOT NULL,
  verdict        verdict NOT NULL,
  score          integer NOT NULL,
  subscores      jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_keys  text[] NOT NULL DEFAULT '{}',
  content_hash   text NOT NULL,                        -- §7 assess dedupe key
  superseded_by  uuid REFERENCES assessments (id),
  trace_id       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessments_score_range CHECK (score BETWEEN 0 AND 100)
);

-- §7: a company is re-assessed only when the rubric version or the content hash
-- changes. §24 idempotency asserts one assessment per company, rubric and hash.
CREATE UNIQUE INDEX IF NOT EXISTS assessments_company_campaign_rubric_hash_key
  ON assessments (company_id, campaign_id, rubric_version, content_hash);

-- ---------------------------------------------------------------------------
-- contacts (§4) — decision makers
--
-- §9 freezes contact discovery structurally: discovery_source is an enum with
-- one permitted value, and email_source_snapshot_id is NOT NULL, so an address
-- with no stored page behind it cannot be written at all.
-- Personal columns are nullable because §15 redact_contact overwrites them.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contacts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies (id),
  full_name                text,
  role_title               text,
  email                    citext,
  email_source_snapshot_id uuid NOT NULL REFERENCES web_snapshots (id),
  discovery_source         discovery_source NOT NULL DEFAULT 'own_site_published',
  consent_basis            consent_basis NOT NULL,
  consent_evidence         jsonb,
  role_relevant            boolean NOT NULL DEFAULT false,
  redacted_at              timestamptz,
  redaction_event_id       uuid REFERENCES events (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON contacts (company_id);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts (email);

-- ---------------------------------------------------------------------------
-- prospects (§4) — the pipeline row
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS prospects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies (id),
  campaign_id     uuid NOT NULL REFERENCES campaigns (id),
  stage           prospect_stage NOT NULL DEFAULT 'discovered',
  rank_score      numeric(6, 4),
  ranking_version text,                                  -- §11
  assessment_id   uuid REFERENCES assessments (id),
  contact_id      uuid REFERENCES contacts (id),
  snoozed_until   timestamptz,                            -- §13 snooze
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prospects_company_campaign_key UNIQUE (company_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS prospects_campaign_stage_rank_idx
  ON prospects (campaign_id, stage, rank_score DESC);

-- ---------------------------------------------------------------------------
-- outreach_drafts (§4) — generated and human-edited copy
--
-- The partial unique index is one of the four constraints that carry the
-- system's safety: one open draft per contact.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id        uuid NOT NULL REFERENCES prospects (id),
  contact_id         uuid NOT NULL REFERENCES contacts (id),
  variant_no         integer NOT NULL,
  subject            text,
  body_text          text,
  human_edited_body  text,
  angle              text,
  evidence_keys      text[] NOT NULL DEFAULT '{}',
  prompt_version     text NOT NULL,
  status             outreach_draft_status NOT NULL DEFAULT 'pending_review',
  reviewed_by        uuid REFERENCES users (id),
  reviewed_at        timestamptz,
  review_reason_code review_reason_code,
  review_note        text,
  trace_id           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_drafts_variant_no_range CHECK (variant_no > 0),
  -- §7: replaying a handler produces the same rows rather than duplicates.
  CONSTRAINT outreach_drafts_prospect_contact_prompt_variant_key
    UNIQUE (prospect_id, contact_id, prompt_version, variant_no)
);

-- §4: partial unique index — one pending_review per (prospect_id, contact_id).
CREATE UNIQUE INDEX IF NOT EXISTS outreach_drafts_one_pending_review_key
  ON outreach_drafts (prospect_id, contact_id)
  WHERE status = 'pending_review';

-- ---------------------------------------------------------------------------
-- approved_outreach (§4, §14) — immutable record of exactly what a human
-- approved. Replaces gmail_drafts. outreach_draft_id unique means a
-- double-clicked approve button cannot produce two rows (§4, §7).
--
-- approval_event_id is DEFERRABLE INITIALLY DEFERRED so the approval
-- transaction can run in the statement order §7 states literally.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approved_outreach (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outreach_draft_id  uuid NOT NULL UNIQUE REFERENCES outreach_drafts (id),
  prospect_id        uuid NOT NULL REFERENCES prospects (id),
  contact_id         uuid NOT NULL REFERENCES contacts (id),
  to_email           citext,
  subject            text,
  body_text          text,
  approved_by        uuid NOT NULL REFERENCES users (id),
  approved_at        timestamptz NOT NULL DEFAULT now(),
  approval_event_id  uuid NOT NULL REFERENCES events (id)
                       DEFERRABLE INITIALLY DEFERRED,
  content_hash       text NOT NULL,
  handoff_state      handoff_state NOT NULL DEFAULT 'ready',
  marked_sent_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approved_outreach_handoff_state_idx
  ON approved_outreach (handoff_state);

DROP TRIGGER IF EXISTS approved_outreach_write_once ON approved_outreach;
CREATE TRIGGER approved_outreach_write_once BEFORE UPDATE ON approved_outreach
  FOR EACH ROW EXECUTE FUNCTION approved_outreach_write_once();

DROP TRIGGER IF EXISTS approved_outreach_no_delete ON approved_outreach;
CREATE TRIGGER approved_outreach_no_delete BEFORE DELETE ON approved_outreach
  FOR EACH ROW EXECUTE FUNCTION forbid_rewrite();

-- ---------------------------------------------------------------------------
-- suppressions (§4, §15) — do-not-contact
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type  suppression_match_type NOT NULL,
  match_value citext NOT NULL,
  reason      suppression_reason NOT NULL,
  source      text,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS suppressions_match_type_value_key
  ON suppressions (match_type, lower(match_value));

-- ---------------------------------------------------------------------------
-- jobs (§4, §6) — the queue
--
-- dedupe_key unique is the idempotent-enqueue guarantee (§4, §7): every
-- enqueue is INSERT ... ON CONFLICT (dedupe_key) DO NOTHING.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          job_kind NOT NULL,
  dedupe_key    text NOT NULL UNIQUE,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        job_status NOT NULL DEFAULT 'queued',
  priority      integer NOT NULL DEFAULT 0,
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  parent_job_id uuid REFERENCES jobs (id),
  trace_id      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts > 0),
  CONSTRAINT jobs_attempts_non_negative CHECK (attempts >= 0)
);

-- §4: index on (status, run_after, priority desc) — serves the claim query.
CREATE INDEX IF NOT EXISTS jobs_status_run_after_priority_idx
  ON jobs (status, run_after, priority DESC);

-- Serves the reaper (§6): running jobs whose lock has expired.
CREATE INDEX IF NOT EXISTS jobs_running_locked_at_idx
  ON jobs (locked_at) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS jobs_trace_id_idx ON jobs (trace_id);

-- ---------------------------------------------------------------------------
-- job_runs (§4) — one row per attempt, append-only
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs (id),
  attempt     integer NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      job_run_status NOT NULL,
  error       text,
  CONSTRAINT job_runs_job_attempt_key UNIQUE (job_id, attempt),
  CONSTRAINT job_runs_attempt_positive CHECK (attempt > 0)
);

DROP TRIGGER IF EXISTS job_runs_complete_once ON job_runs;
CREATE TRIGGER job_runs_complete_once BEFORE UPDATE ON job_runs
  FOR EACH ROW EXECUTE FUNCTION job_runs_complete_once();

DROP TRIGGER IF EXISTS job_runs_no_delete ON job_runs;
CREATE TRIGGER job_runs_no_delete BEFORE DELETE ON job_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_rewrite();

-- ---------------------------------------------------------------------------
-- llm_calls (§4, §16) — every model call
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS llm_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id      text NOT NULL,
  job_id        uuid REFERENCES jobs (id),
  purpose       text NOT NULL,
  isolation     llm_isolation NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cached_tokens integer NOT NULL DEFAULT 0,
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms    integer,
  status        llm_call_status NOT NULL,
  request_hash  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_calls_trace_id_idx ON llm_calls (trace_id);

-- Serves month-to-date spend for /api/health and the §16 budget check.
CREATE INDEX IF NOT EXISTS llm_calls_created_at_idx ON llm_calls (created_at);

-- ---------------------------------------------------------------------------
-- model_pricing (§4, §16) — cost is computed, never hard-coded
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_pricing (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL,
  model           text NOT NULL,
  input_per_mtok  numeric(12, 6) NOT NULL,
  output_per_mtok numeric(12, 6) NOT NULL,
  effective_from  timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_pricing_provider_model_effective_key
    UNIQUE (provider, model, effective_from)
);

-- ---------------------------------------------------------------------------
-- budgets (§4, §16) — the ceiling
--
-- warn_usd is the softer threshold: crossing it raises a warning and the system
-- keeps working, so the hard stop arrives announced rather than as an outage
-- mid-run. V1 starts at a $50 monthly budget, a $35 warning and a $50 hard stop
-- (§2), sized to the first two weeks' deliberately low volume.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS budgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month  date NOT NULL UNIQUE,
  limit_usd     numeric(12, 2) NOT NULL,
  warn_usd      numeric(12, 2) NOT NULL,
  hard_stop_usd numeric(12, 2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budgets_hard_stop_at_or_above_limit
    CHECK (hard_stop_usd >= limit_usd),
  CONSTRAINT budgets_warn_at_or_below_limit
    CHECK (warn_usd <= limit_usd),
  CONSTRAINT budgets_amounts_non_negative
    CHECK (limit_usd >= 0 AND warn_usd >= 0 AND hard_stop_usd >= 0)
);

-- ---------------------------------------------------------------------------
-- schedules (§4, §6) — recurring work, driven by the in-process scheduler
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        job_kind NOT NULL,
  cron        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedules_due_idx
  ON schedules (next_run_at) WHERE enabled;

-- ---------------------------------------------------------------------------
-- eval_fixtures, eval_runs, eval_results (§4, §21)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS eval_fixtures (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_set        text NOT NULL,
  split              eval_split NOT NULL,
  domain             citext NOT NULL,
  label              eval_label NOT NULL,
  label_reason_codes text[] NOT NULL DEFAULT '{}',
  disqualifier       text,
  labelled_by        text,
  labelled_at        timestamptz,
  snapshot_path      text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_fixtures_set_domain_key UNIQUE (fixture_set, domain)
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_set    text NOT NULL,
  split          eval_split NOT NULL,
  rubric_version text NOT NULL,
  prompt_version text NOT NULL,
  model          text NOT NULL,
  metrics        jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd       numeric(12, 6) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_run_id       uuid NOT NULL REFERENCES eval_runs (id),
  fixture_id        uuid NOT NULL REFERENCES eval_fixtures (id),
  predicted_verdict verdict NOT NULL,
  predicted_score   integer,
  correct           boolean NOT NULL,
  reasons           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_results_run_fixture_key UNIQUE (eval_run_id, fixture_id)
);

-- ---------------------------------------------------------------------------
-- practice_area_priors (§4, §9) — human-maintained vertical value table.
-- Vertical value comes from this table, never from the model.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS practice_area_priors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns (id),
  practice_area citext NOT NULL,
  value_band    smallint NOT NULL,
  note          text,
  updated_by    uuid REFERENCES users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT practice_area_priors_campaign_area_key
    UNIQUE (campaign_id, practice_area),
  CONSTRAINT practice_area_priors_value_band_range
    CHECK (value_band BETWEEN 1 AND 5)
);

-- ---------------------------------------------------------------------------
-- robots_cache (§4, §8) — robots.txt, cached 24h, used by the fetcher role
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS robots_cache (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host                 citext NOT NULL UNIQUE,
  body                 text,
  crawl_delay_seconds  numeric(6, 2),
  fetched_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Documented invariants (§4, §16)
-- ---------------------------------------------------------------------------

COMMENT ON TABLE events IS
  'Append-only audit spine (SPEC.md §4). Records entity ids, a kind, an actor '
  'and a reference — never a copy of personal text. §15 redaction writes a '
  'non-identifying tombstone here.';

COMMENT ON TABLE approved_outreach IS
  'Immutable record of exactly what a human approved (SPEC.md §4, §14). '
  'Write-once apart from handoff_state and marked_sent_at; redaction may null '
  'personal text but never rewrite it.';

COMMENT ON COLUMN web_snapshots.text IS
  'UNTRUSTED page text. Pruned after 90 days by maintenance.prune (SPEC.md §16).';

COMMENT ON COLUMN contacts.email_source_snapshot_id IS
  'NOT NULL by design (SPEC.md §9): an address with no stored page behind it '
  'cannot be written at all.';
