-- ---------------------------------------------------------------------------
-- 009 — an abandoned reservation keeps saying what it claimed (§16, §4)
-- ---------------------------------------------------------------------------
--
-- Why this exists.
--
-- Migration 007 made the reservation the control: one row per piece of work,
-- unique while `reservation_key` is set, inserted inside the month's budget
-- lock. Abandoning an uncharged reservation releases that identity by setting
-- the key to NULL, which is what lets the same extraction be attempted again.
--
-- Releasing it by *erasing* it costs the audit trail the one fact that makes
-- the row interpretable. An abandoned row said: zero cost, reconciled by a
-- person, with a note — and no record of which work the money had been held
-- for. "kushagra released $0.09 on the 3rd, for something" is not an audit
-- trail. §4 wants the ledger readable after the fact; §16 wants a correction
-- attributable to a decision about a specific call.
--
-- So the key moves instead of vanishing. `reservation_key` goes to NULL, which
-- frees the work exactly as before — the unique index is partial on
-- `reservation_key IS NOT NULL` and nothing reads this new column as a
-- control — and the released value lands in `released_reservation_key`, which
-- is write-once.
--
-- Write-once matters because this column is the evidence that a particular
-- reservation was released. A column that can be rewritten later is not
-- evidence of anything. The pattern is the one 001 already uses for
-- approved_outreach and job_runs: a BEFORE UPDATE trigger that raises rather
-- than a convention that holds until someone writes a different UPDATE.
--
-- Deliberately NOT unique: several attempts at the same work can each be
-- reserved and each be abandoned, and every one of those releases is a fact.
-- Uniqueness here would make the second honest abandonment fail.
--
-- Nothing to backfill. Production llm_calls is empty — Day 4 ships with model
-- calls disabled and month-to-date spend is $0.00 — so no row has already lost
-- its key. Had there been one, the key would be unrecoverable, which is the
-- bug being fixed rather than an argument for a destructive rewrite.
--
-- Additive and forward-only (§19 rule 3): one nullable column, one trigger.
-- Migrations 001–008 are unchanged and need no alteration.

-- ---------------------------------------------------------------------------
-- 1. The column.
-- ---------------------------------------------------------------------------
ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS released_reservation_key text;

COMMENT ON COLUMN llm_calls.released_reservation_key IS
  'The reservation_key this row held before a human abandoned it (SPEC.md §16). '
  'Set once, by abandonReservation, in the same statement that nulls '
  'reservation_key: the work identity is freed for a retry while the row keeps '
  'saying which work it was. Never read as a control — reservations are '
  'serialised on reservation_key alone — and never unique, because two '
  'successive attempts at the same work can both be reserved and both be '
  'released. Write-once: see llm_calls_released_key_write_once.';

-- ---------------------------------------------------------------------------
-- 2. Write-once, enforced in the database.
-- ---------------------------------------------------------------------------
--
-- Once set, the value cannot be changed or cleared. Setting it on a row that
-- still holds a live reservation_key is also refused: the column means "this
-- was released", and a row claiming to have released a key it is still holding
-- would be a contradiction in the ledger. The two writes belong in one
-- statement, which is how abandonReservation does it.
CREATE OR REPLACE FUNCTION llm_calls_released_key_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_reservation_key IS NOT NULL
     AND NEW.released_reservation_key IS DISTINCT FROM OLD.released_reservation_key THEN
    RAISE EXCEPTION
      'llm_calls.released_reservation_key is write-once; % already recorded a release (SPEC.md 16)',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.released_reservation_key IS NOT NULL
     AND NEW.reservation_key IS NOT NULL THEN
    RAISE EXCEPTION
      'llm_calls % cannot record a released reservation key while still holding one (SPEC.md 16)',
      NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS llm_calls_released_key_write_once ON llm_calls;
CREATE TRIGGER llm_calls_released_key_write_once BEFORE UPDATE ON llm_calls
  FOR EACH ROW EXECUTE FUNCTION llm_calls_released_key_write_once();

-- ---------------------------------------------------------------------------
-- 3. Reconciliation reads this.
-- ---------------------------------------------------------------------------
--
-- "Has this work been released before, and how often" — the question that
-- separates one unlucky crash from a retry loop burning the pessimistic
-- estimate over and over.
CREATE INDEX IF NOT EXISTS llm_calls_released_reservation_key_idx
  ON llm_calls (released_reservation_key)
  WHERE released_reservation_key IS NOT NULL;
