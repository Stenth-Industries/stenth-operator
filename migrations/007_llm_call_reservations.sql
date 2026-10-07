-- ---------------------------------------------------------------------------
-- 007 — the budget hard stop becomes atomic (§16)
-- ---------------------------------------------------------------------------
--
-- Why this exists.
--
-- Day 4 checked the budget, then called the provider, then recorded the call.
-- §16 says "the budget check runs before the call, not after it", and that
-- sequence satisfies the letter of it while leaving two races that both end
-- with money spent past the ceiling:
--
--   A. Two workers evaluate the same remaining budget before either has
--      recorded anything. Both pass. Both spend. The hard stop is advisory.
--   B. The provider bills us and the process dies before the INSERT. The
--      charge exists and nothing in the database knows. A retry charges again.
--
-- A check that can be overtaken is not a control. So the call is *reserved*
-- before it is made: one row, inserted inside a transaction that holds the
-- month's budgets row with FOR UPDATE, carrying the pessimistic maximum cost.
-- Reserved cost counts against the ceiling exactly like spent cost, so the
-- arithmetic is "committed + in flight" rather than "committed".
--
-- Why FOR UPDATE on budgets rather than an advisory lock: operator_app does not
-- hold the advisory-lock namespace — migration 005's bootstrap gave that to
-- operator_sched alone, so the scheduler's singleton cannot be stolen by the
-- app or the fetcher. The month's budgets row is the natural serialisation
-- point for a monthly ceiling, operator_app already has UPDATE on it, and the
-- lock is held only for the few milliseconds of the reservation — never across
-- the provider call.
--
-- Forward-only, no down migration (§19 rule 3).

-- ---------------------------------------------------------------------------
-- 1. Two more call states.
-- ---------------------------------------------------------------------------
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction since PostgreSQL 12,
-- but the new value cannot be *used* in the same transaction. Nothing below
-- references either literal, which is also why the unique index at the end
-- carries no status predicate.
--
--   reserved   A reservation exists and the outcome is not yet known: the call
--              is in flight, or the process died holding it. cost_usd carries
--              the pessimistic estimate and counts against the ceiling.
--   abandoned  A human has verified that no charge occurred and released the
--              reservation. cost_usd is set to 0 and the identity is freed, so
--              the work can be re-enqueued.
ALTER TYPE llm_call_status ADD VALUE IF NOT EXISTS 'reserved';
ALTER TYPE llm_call_status ADD VALUE IF NOT EXISTS 'abandoned';

-- ---------------------------------------------------------------------------
-- 2. The reservation columns.
-- ---------------------------------------------------------------------------
ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS reservation_key     text,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd  numeric(12, 6),
  ADD COLUMN IF NOT EXISTS reserved_at         timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_at        timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_by       text,
  ADD COLUMN IF NOT EXISTS reconciliation_note text;

COMMENT ON COLUMN llm_calls.reservation_key IS
  'The work this call is for, as one string: purpose, snapshot, schema version, '
  'extractor model and request hash. Unique while set, so two workers cannot '
  'both invoke the provider for the same work. Released (set to NULL) when a '
  'human abandons an uncharged reservation, which lets the work be retried.';

COMMENT ON COLUMN llm_calls.estimated_cost_usd IS
  'The pessimistic maximum the reservation held: input tokens estimated from '
  'the prompt, output tokens assumed to hit the cap. Kept after finalisation '
  'so the estimate can be compared with what was actually billed.';

COMMENT ON COLUMN llm_calls.cost_usd IS
  'Reserved rows carry the pessimistic estimate; finalised rows carry the '
  'actual cost from model_pricing; blocked and abandoned rows carry 0. The '
  'month-to-date figure is therefore a plain sum over this column — committed '
  'spend plus everything in flight — with no status filter to get wrong.';

-- ---------------------------------------------------------------------------
-- 3. One provider invocation per piece of work.
-- ---------------------------------------------------------------------------
--
-- No status predicate, deliberately: see the note above about ALTER TYPE, and
-- because abandoning a reservation releases the key rather than leaving a row
-- that silently blocks every future attempt at the same work.
CREATE UNIQUE INDEX IF NOT EXISTS llm_calls_reservation_key_idx
  ON llm_calls (reservation_key)
  WHERE reservation_key IS NOT NULL;

-- Reconciliation reads this: reservations still open, oldest first.
CREATE INDEX IF NOT EXISTS llm_calls_reserved_at_idx
  ON llm_calls (reserved_at)
  WHERE finalized_at IS NULL;
