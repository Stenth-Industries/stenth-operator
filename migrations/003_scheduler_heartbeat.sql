-- 003_scheduler_heartbeat.sql — liveness for the in-process scheduler, and the
-- one column grant its enqueue needs.
--
-- WHY THIS MIGRATION EXISTS — 1 of 2: the heartbeat
--
-- §20 requires /api/health to report "the age of the last scheduler tick".
-- There is no column in §4 that can answer it. schedules.last_run_at is the
-- last time a schedule *fired*, which is a different fact: a scheduler with no
-- enabled schedules ticks correctly every 60 seconds while last_run_at stays
-- null forever, so the metric could never detect the one failure it exists to
-- detect. And /api/health runs in the web container, which cannot see the
-- worker process's memory, so the database is the only channel between them.
--
-- One row, written once per tick while the scheduler holds its advisory lock.
--
-- Forward-only. 001 and 002 are already applied in production and are not
-- touched here.

CREATE TABLE IF NOT EXISTS scheduler_heartbeat (
  -- A boolean primary key constrained to true permits exactly one row, so the
  -- table cannot grow and a reader never has to pick between rows.
  id           boolean PRIMARY KEY DEFAULT true,
  last_tick_at timestamptz NOT NULL,
  -- Which worker ticked. Useful the moment a second worker exists and the
  -- advisory lock is doing something observable.
  last_tick_by text NOT NULL,
  CONSTRAINT scheduler_heartbeat_single_row CHECK (id)
);

COMMENT ON TABLE scheduler_heartbeat IS
  'Liveness of the in-process scheduler (SPEC.md §6, §20). One row, updated on '
  'every tick under the advisory lock, including a tick with nothing due. '
  'Distinct from schedules.last_run_at, which records a schedule firing.';

-- The scheduler connects as operator_sched (§17), whose other grants are read
-- and update on schedules and insert on jobs. operator_app and operator_ro get
-- their access from the default privileges 002 set for tables created by
-- operator_migrate; tests assert that rather than assuming it.
GRANT SELECT, INSERT, UPDATE ON TABLE scheduler_heartbeat TO operator_sched;

-- WHY THIS MIGRATION EXISTS — 2 of 2: the scheduler could not enqueue at all
--
-- §7 specifies the enqueue as "INSERT ... ON CONFLICT (dedupe_key) DO NOTHING",
-- and §17 gives operator_sched "insert into jobs". Those two are in direct
-- conflict, and the conflict is invisible until it runs: naming an explicit
-- conflict target makes PostgreSQL infer the unique index, which needs SELECT
-- on the inference column, so the statement fails with "permission denied for
-- table jobs" even though INSERT was granted. A target-less ON CONFLICT DO
-- NOTHING needs no SELECT and would have worked — but it also swallows every
-- other unique violation, so a future constraint on jobs would start failing
-- silently.
--
-- The narrow fix keeps both sections honest: SELECT on one column. The
-- scheduler computes dedupe keys itself, so reading them back grants it nothing
-- it did not already know, and it still cannot read a job's payload or claim a
-- job. Tests assert both of those denials.
GRANT SELECT (dedupe_key) ON TABLE jobs TO operator_sched;
