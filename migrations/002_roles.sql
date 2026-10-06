-- 002_roles.sql — least-privilege grants for the five Postgres roles (§17).
--
-- The roles themselves are created, and given their passwords, by the bootstrap
-- phase of src/db/migrate.ts, which runs as the admin connection: CREATE ROLE
-- requires a privilege operator_migrate deliberately does not have, and role
-- passwords live in .env (§17), never in a committed migration.
--
-- This file grants table privileges, which the table owner (operator_migrate)
-- can issue. Forward-only: a later migration that adds a table adds its grants.
--
--   operator_app      DML on application tables
--   operator_fetch    insert into web_snapshots, read robots_cache, nothing else
--   operator_sched    read and update schedules, insert into jobs
--   operator_migrate  DDL, used only by the migration step (owns every table)
--   operator_ro       read-only, for ad-hoc queries

-- ---------------------------------------------------------------------------
-- operator_app — the web app and the worker
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO operator_app;
REVOKE ALL ON TABLE schema_migrations FROM operator_app;

-- The audit spine is append-only (§4). The trigger enforces it; the privilege
-- layer enforces it too, so a dropped trigger is not a silent loss of the
-- guarantee.
REVOKE UPDATE, DELETE ON TABLE events FROM operator_app;
REVOKE DELETE ON TABLE job_runs FROM operator_app;
REVOKE DELETE ON TABLE approved_outreach FROM operator_app;

-- ---------------------------------------------------------------------------
-- operator_fetch — the fetcher service, the one process that touches hostile
-- input (§8). This is the entire blast radius of a compromise: it can add a
-- snapshot and maintain the robots cache it obeys. It can read nothing
-- sensitive. §23 asserts this by connecting as the role and expecting a
-- permission error.
--
-- §17 describes robots_cache as read-only for this role while §8 step 3 has
-- the fetcher fetching and caching robots.txt itself. Maintaining the cache it
-- consults is the only reading under which the fetcher can do its job, so it
-- holds insert and update on that one table.
-- ---------------------------------------------------------------------------

GRANT INSERT ON TABLE web_snapshots TO operator_fetch;
GRANT SELECT, INSERT, UPDATE ON TABLE robots_cache TO operator_fetch;

-- ---------------------------------------------------------------------------
-- operator_sched — the in-process scheduler (§6)
-- ---------------------------------------------------------------------------

GRANT SELECT, UPDATE ON TABLE schedules TO operator_sched;
GRANT INSERT ON TABLE jobs TO operator_sched;

-- ---------------------------------------------------------------------------
-- operator_ro — ad-hoc queries
-- ---------------------------------------------------------------------------

GRANT SELECT ON ALL TABLES IN SCHEMA public TO operator_ro;

-- ---------------------------------------------------------------------------
-- Default privileges, so a table created by a later migration arrives with the
-- same shape of access rather than silently unreadable.
-- ---------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO operator_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO operator_ro;
