-- ---------------------------------------------------------------------------
-- 008 — the fetcher may fill in a missing Tier A scan, and nothing else (§9, §17)
-- ---------------------------------------------------------------------------
--
-- Why this exists.
--
-- The 20 snapshots stored during Day 3 predate the scanner, so their `signals`
-- is NULL and extraction records Tier A as `unknown`. The fix is a controlled
-- re-fetch — but `web_snapshots` is unique on (company_id, url, content_hash),
-- so re-fetching a page whose content has not changed hits ON CONFLICT DO
-- NOTHING and the existing row keeps its NULL. The re-fetch would be 40 polite
-- requests that change nothing.
--
-- So the insert becomes "fill it in if it is missing", which needs UPDATE —
-- and migration 002 gave operator_fetch INSERT only, deliberately. The grant is
-- therefore column-level and conditional in the same breath:
--
--   * UPDATE on `signals` alone. Not the table. `text` stays immutable to the
--     fetcher, as do `url`, `http_status`, `content_hash` and `bytes` — a
--     compromised fetcher still cannot rewrite a stored page or a status.
--   * The statement itself only ever writes where `signals IS NULL`, so an
--     existing scan cannot be overwritten by a later fetch of the same bytes.
--
-- What this does not do: it does not let the fetcher read `signals` back. It
-- writes the scan it just performed, and migration 004's column grants still
-- withhold every read but id, company_id, url and content_hash.
--
-- Forward-only, no down migration (§19 rule 3).

GRANT UPDATE (signals) ON TABLE web_snapshots TO operator_fetch;

-- And SELECT on the same column, because the statement's own guard reads it:
-- "fill it in where it is NULL" is a read of `signals`. This is the fetcher
-- reading back the derived booleans and counts it produced itself a moment
-- ago — not page content. `text` remains unreadable to this role, which is the
-- guarantee migration 004 exists for.
GRANT SELECT (signals) ON TABLE web_snapshots TO operator_fetch;

COMMENT ON COLUMN web_snapshots.signals IS
  'Deterministic Tier A scan of the page markup (SPEC.md §9), written by the '
  'fetcher before HTML-to-text because <script> is dropped there. NULL means '
  'no scanner has looked, which extraction records as unknown, never absent. '
  'operator_fetch may UPDATE this column alone, and only from NULL, so a '
  're-fetch can fill in a missing scan without being able to rewrite a page.';
