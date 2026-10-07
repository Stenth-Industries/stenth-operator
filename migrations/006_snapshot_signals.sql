-- ---------------------------------------------------------------------------
-- 006 — Tier A signals live with the snapshot (§9, §19, §23 case 13)
-- ---------------------------------------------------------------------------
--
-- Why this exists.
--
-- §9 says every Tier A signal is "read out of stored HTML by code, not inferred
-- by a model", and §23 case 13 says the scanner "reads script content, not
-- claims". The AW- identifier lives inside a <script>. The fetcher's HTML-to-
-- text step drops <script> — correctly, because that is where injected
-- instructions live (§8) — so by the time a page reaches web_snapshots.text the
-- evidence for the single most useful Tier A signal is gone.
--
-- Three ways out, and only one of them is good:
--
--   (a) Store the raw HTML as well. Rejected: it doubles storage, puts hostile
--       markup in the database, and gives §15's retention rules a second copy
--       of everything to prune.
--   (b) Re-fetch the page at extract time. Rejected: a second request per page
--       for data we already had, and the page can change between the two.
--   (c) Run the deterministic scan where the HTML already is — in the fetcher,
--       before the text conversion — and store only its structured result.
--
-- (c) is this migration. The scan is regular expressions and tag matching over
-- markup: no model, no network, no credential, and its output is booleans,
-- counts and identifier strings. It crosses the §5 trust boundary the same way
-- the text does, and unlike the text it cannot carry an instruction.
--
-- Deviation from §4, recorded in ops/deviations.md: web_snapshots gains a
-- column that §4's table does not list. §4 names "key columns and constraints"
-- rather than an exhaustive list, the column is nullable and additive, and it
-- belongs with the snapshot because it shares the snapshot's provenance,
-- trace id and retention. The alternative — a second table — would be a larger
-- departure for no benefit.
--
-- Backward compatible on purpose. Every snapshot stored before this migration
-- has signals NULL, and NULL means "no scanner has looked", which the
-- extraction records as `unknown` rather than `absent`. That distinction is
-- load-bearing: §10's Visible execution gap dimension pays 35 points for the
-- *absence* of an AW- tag, and awarding it for a signal nobody measured would
-- be the Day 3 finding-1 mistake in a new place.
--
-- Forward-only, and no down migration (§19 rule 3).

ALTER TABLE web_snapshots
  ADD COLUMN IF NOT EXISTS signals jsonb;

COMMENT ON COLUMN web_snapshots.signals IS
  'Deterministic Tier A scan of the page markup (SPEC.md §9), written by the '
  'fetcher before HTML-to-text because <script> is dropped there. NULL means '
  'no scanner has looked, which extraction records as unknown, never absent.';

-- operator_fetch already holds table-level INSERT on web_snapshots from
-- migration 002, which covers a new column, so no grant changes. It still has
-- no SELECT on this column, and does not need one: it writes the scan it just
-- performed.

-- The view is deliberately left alone.
--
-- usable_snapshots exists to stop later analysis treating a non-2xx row as
-- evidence (migration 005); it does not need this column to do that, and the
-- extract stage reads the snapshot row directly. Replacing the view here would
-- also make migration 005 non-re-runnable — CREATE OR REPLACE VIEW cannot drop
-- a column, so 005's older definition would fail against the newer view — and
-- 005 is already applied in production, where editing it is not an option
-- (§19 rule 3). The signals are available on web_snapshots and inside
-- extractions.payload, which is where Day 6 reads them from.
