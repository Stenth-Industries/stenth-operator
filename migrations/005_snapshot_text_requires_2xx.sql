-- ---------------------------------------------------------------------------
-- 005 — only a 2xx page may carry text, and only 2xx rows are evidence
-- ---------------------------------------------------------------------------
--
-- Why this exists.
--
-- Until now the fetcher stored any non-redirect response as a snapshot: a 403
-- error page arrived with robots_allowed = true and its own prose in `text`,
-- indistinguishable from a page we actually read. §9's Tier A signals are
-- observations of the firm's own public site read out of stored HTML by code,
-- and every one of them is absent from an error page — which is precisely what
-- §10's Visible execution gap dimension, the largest of the five, pays for. A
-- blocked firm therefore scored like a strong prospect on no evidence at all.
--
-- The fetcher no longer does that: a 4xx is stored with text NULL, a 5xx is not
-- stored at all, and only a 2xx produces text. This migration makes that a
-- property of the database rather than of the code that happens to write to it.
-- §1: "If a guarantee can be structural, it must be structural."
--
-- Two mechanisms, because they answer two different questions.

-- 1. Nothing new can be written that carries text without a 2xx behind it.
--
-- NOT VALID on purpose. One row already in production breaks this rule — the
-- Doogue + George 403 captured on 2026-10-07, before the fetcher was corrected
-- — and it is deliberately kept: deleting history to make a constraint pass is
-- how you lose the evidence that the bug was real. NOT VALID still enforces the
-- check on every INSERT and UPDATE from here on; it only skips the scan of what
-- is already there.
--
-- A consequence to know about: `VALIDATE CONSTRAINT` will fail while that row
-- exists. That is the intended trade, and the view below is what later analysis
-- reads, so the legacy row is excluded there whether or not it is ever cleaned.
--
-- Note what the check permits, because both cases are correct:
--   * text NULL with http_status NULL — the §8 robots-disallowed row, which
--     records a decision about a page that was never fetched.
--   * text NULL with http_status 200 — a snapshot whose text maintenance.prune
--     has removed past its retention window (§6, §15).
-- Guarded, because PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS and every
-- migration file here re-runs cleanly on its own: a hand-run during an incident
-- must not half-apply. Adding it only when absent also means a later
-- VALIDATE CONSTRAINT is not quietly undone by a re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'web_snapshots_text_requires_2xx'
      AND conrelid = 'web_snapshots'::regclass
  ) THEN
    ALTER TABLE web_snapshots
      ADD CONSTRAINT web_snapshots_text_requires_2xx
      CHECK (
        text IS NULL
        OR (http_status IS NOT NULL AND http_status BETWEEN 200 AND 299)
      )
      NOT VALID;
  END IF;
END
$$;

COMMENT ON CONSTRAINT web_snapshots_text_requires_2xx ON web_snapshots IS
  'Page text may exist only behind a 2xx response (SPEC.md §8, §9). NOT VALID: '
  'one pre-correction 403 row is kept as history and is excluded by the '
  'usable_snapshots view instead.';

-- 2. What later analysis is allowed to treat as the firm's own evidence.
--
-- The constraint above cannot speak for rows written before it existed, and
-- "WHERE text IS NOT NULL" is therefore not a safe predicate on its own: the
-- legacy 403 row satisfies it. So the rule gets one definition, here, and the
-- pipeline reads it instead of restating it per query. Day 4's web.extract
-- selects from this view.
--
-- Deliberately not granted to operator_fetch. A view runs with its owner's
-- privileges, so granting it to the fetcher role would hand it the page text
-- that migration 004's column grants specifically withheld.
CREATE OR REPLACE VIEW usable_snapshots AS
  SELECT id,
         company_id,
         url,
         http_status,
         content_hash,
         text,
         bytes,
         robots_allowed,
         fetched_at,
         text_pruned_at,
         trace_id,
         created_at
  FROM web_snapshots
  WHERE http_status BETWEEN 200 AND 299
    AND robots_allowed
    AND text IS NOT NULL;

COMMENT ON VIEW usable_snapshots IS
  'Snapshots that may be used as company evidence (SPEC.md §9): fetched with '
  'permission, answered 2xx, and still carrying text. Non-2xx rows, '
  'robots-disallowed rows, pruned rows and the one pre-correction 403 are '
  'structurally excluded. Does not filter off-domain final URLs — finding 2 '
  'in ops/day3-acceptance/findings.md is an open policy question, and Day 4 '
  'must not consume an off-domain snapshot until it is resolved.';

GRANT SELECT ON usable_snapshots TO operator_app;
GRANT SELECT ON usable_snapshots TO operator_ro;
