-- 004_fetcher_snapshot_grants.sql — the four column grants the fetcher needs to
-- do what §8 describes.
--
-- WHY THIS MIGRATION EXISTS
--
-- §8 step 4: the fetcher "returns the snapshot id and status to the worker".
-- Returning the id means INSERT ... RETURNING id, and RETURNING requires SELECT
-- on the returned column. web_snapshots also carries
-- UNIQUE (company_id, url, content_hash), so re-fetching unchanged content must
-- be an ON CONFLICT with that target — and an explicit conflict target makes
-- Postgres infer the unique index, which requires SELECT on the inference
-- columns.
--
-- 002 granted operator_fetch INSERT and nothing else, so both statements failed
-- with "permission denied for table web_snapshots". Measured, not assumed: the
-- fetcher could not perform its specified function at all.
--
-- The grant is four columns, not the table. What it deliberately leaves out is
-- the point:
--
--   text  -- the untrusted page content
--
-- The fetcher writes hostile content and cannot read it back. Nor can it read
-- bytes, http_status, fetched_at or trace_id of any snapshot, its own included.
-- A compromise of the one process that touches hostile input yields the ability
-- to add a snapshot and to learn the id of one it just added. Tests assert each
-- of those denials by connecting as the role.
--
-- Forward-only. 001, 002 and 003 are applied in production and are not touched.

-- RETURNING id, and reading back the id of an already-stored identical snapshot.
GRANT SELECT (id) ON TABLE web_snapshots TO operator_fetch;

-- The ON CONFLICT (company_id, url, content_hash) inference target, and the
-- WHERE clause that reads the existing id back.
GRANT SELECT (company_id, url, content_hash) ON TABLE web_snapshots TO operator_fetch;

COMMENT ON COLUMN web_snapshots.text IS
  'UNTRUSTED page text. Pruned after 90 days by maintenance.prune (SPEC.md §16). '
  'operator_fetch can write this column and deliberately cannot read it '
  '(migration 004).';
