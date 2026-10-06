/**
 * The full allow/deny matrix for operator_fetch (SPEC.md §8, §17, §23).
 *
 * §8 assumes the fetcher is the process that will be compromised: it is the
 * only one that parses attacker-controlled HTML. Its containment is not a
 * property of its code — code is what an attacker replaces — it is a property
 * of the database role its connection authenticates as. So the role is the
 * thing under test here, against a real PostgreSQL, statement by statement.
 *
 * The matrix is exhaustive on purpose. A privilege the fetcher does not need is
 * a privilege a later migration can hand it by accident: 004 widened the role
 * to make `RETURNING id` and `ON CONFLICT` work, and the narrow fix (column
 * grants on four columns) and the wide one (SELECT on the table, including the
 * page text) are one word apart in the SQL.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';

const describeWithDb = hasDatabase ? describe : describe.skip;

/** Any well-formed uuid: the statement must be refused before it is resolved. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

if (!hasDatabase) {
  console.warn(
    'TEST_ADMIN_DATABASE_URL is not set — skipping the operator_fetch ' +
      'privilege matrix. It needs a real PostgreSQL 16 superuser connection.',
  );
}

describeWithDb('operator_fetch holds exactly the privileges the fetcher needs', () => {
  let db: TestDatabase;
  let fetchPool: Pool;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    fetchPool = db.poolAs('operator_fetch');
    const company = await db.adminPool.query<{ id: string }>(
      `INSERT INTO companies (canonical_domain) VALUES ('matrix-example.com.au')
       RETURNING id`,
    );
    companyId = company.rows[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  /** Runs one statement as operator_fetch and rolls it back. */
  async function attempt(sql: string, params: unknown[] = []): Promise<void> {
    const client = await fetchPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql, params);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  describe('what §8 step 4 needs in order to store a page', () => {
    it('inserts a snapshot', async () => {
      await attempt(
        `INSERT INTO web_snapshots (company_id, url, content_hash, text, robots_allowed)
         VALUES ($1, 'https://matrix-example.com.au/', 'h1', 'body text', true)`,
        [companyId],
      );
    });

    it('reads back the id it just wrote, which is all it returns to the worker', async () => {
      await attempt(
        `INSERT INTO web_snapshots (company_id, url, content_hash, robots_allowed)
         VALUES ($1, 'https://matrix-example.com.au/a', 'h2', true)
         RETURNING id`,
        [companyId],
      );
    });

    it('names the unique constraint as an ON CONFLICT target', async () => {
      // Inference needs SELECT on the inference columns, which is why 004
      // granted exactly company_id, url and content_hash and nothing else.
      await attempt(
        `INSERT INTO web_snapshots (company_id, url, content_hash, robots_allowed)
         VALUES ($1, 'https://matrix-example.com.au/b', 'h3', true)
         ON CONFLICT (company_id, url, content_hash) DO NOTHING
         RETURNING id`,
        [companyId],
      );
    });

    it('reads and writes the robots cache it obeys', async () => {
      await attempt('SELECT host, body, crawl_delay_seconds, fetched_at FROM robots_cache');
      await attempt(
        `INSERT INTO robots_cache (host, body, crawl_delay_seconds)
         VALUES ('matrix-example.com.au', 'User-agent: *', 2)
         ON CONFLICT (host) DO UPDATE SET body = EXCLUDED.body`,
      );
    });
  });

  describe('it cannot read the page text back, not even its own', () => {
    // The point of the column grants: the fetcher writes `text` and is denied
    // reading it. A compromised fetcher cannot turn the snapshot table into a
    // queryable archive of every site the Operator has ever visited.
    it.each([
      ['the text column', 'SELECT text FROM web_snapshots'],
      ['a star select', 'SELECT * FROM web_snapshots'],
      ['any other column', 'SELECT http_status, bytes, trace_id FROM web_snapshots'],
    ])('is denied %s', async (_label, sql) => {
      await expect(attempt(sql)).rejects.toThrow(/permission denied/);
    });

    it('is denied UPDATE, DELETE and TRUNCATE on snapshots', async () => {
      for (const sql of [
        `UPDATE web_snapshots SET content_hash = 'tampered'`,
        'DELETE FROM web_snapshots',
        'TRUNCATE web_snapshots',
      ]) {
        await expect(attempt(sql)).rejects.toThrow(/permission denied/);
      }
    });

    it('is denied DELETE on the robots cache, so it cannot forget a Disallow', async () => {
      await expect(attempt('DELETE FROM robots_cache')).rejects.toThrow(/permission denied/);
    });
  });

  describe('no application-wide DML: every other table is closed', () => {
    // Not an allowlist of a few sensitive tables — the whole §4 schema minus
    // the two the fetcher writes. A new table is denied by default, and a
    // migration that grants it one has to pass this test to land.
    const CLOSED_TABLES = [
      'users', 'campaigns', 'companies', 'company_sources', 'extractions',
      'assessments', 'contacts', 'prospects', 'outreach_drafts',
      'approved_outreach', 'suppressions', 'jobs', 'job_runs', 'events',
      'llm_calls', 'model_pricing', 'budgets', 'schedules', 'eval_fixtures',
      'eval_runs', 'eval_results', 'practice_area_priors',
      'schema_migrations', 'scheduler_heartbeat',
    ];

    it.each(CLOSED_TABLES)('cannot read %s', async (table) => {
      await expect(attempt(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/,
      );
    });

    it('cannot write the audit spine, so it cannot forge or bury an event', async () => {
      await expect(
        attempt(`INSERT INTO events (kind, payload) VALUES ('fetch.completed', '{}')`),
      ).rejects.toThrow(/permission denied/);
    });

    it('cannot raise the budget that caps model spend', async () => {
      await expect(
        attempt('UPDATE budgets SET hard_stop_usd = 100000'),
      ).rejects.toThrow(/permission denied/);
    });

    it('cannot forge a contact, a draft or an approval', async () => {
      for (const sql of [
        `INSERT INTO contacts (company_id, email, consent_basis)
         VALUES ('${NIL_UUID}', 'x@y.com', 'inferred_published')`,
        `INSERT INTO outreach_drafts
           (prospect_id, contact_id, variant_no, body_text, prompt_version)
         VALUES ('${NIL_UUID}', '${NIL_UUID}', 1, 'b', 'v1')`,
      ]) {
        await expect(attempt(sql)).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe('no queue privileges: it cannot claim, create or retry work', () => {
    it.each([
      ['claim a job', `UPDATE jobs SET status = 'running' WHERE status = 'queued'`],
      ['enqueue a job', `INSERT INTO jobs (kind, dedupe_key, payload) VALUES ('web.fetch', 'k', '{}')`],
      ['read the queue', 'SELECT id, kind FROM jobs'],
      ['write a run record', `INSERT INTO job_runs (job_id, attempt) VALUES (gen_random_uuid(), 1)`],
    ])('cannot %s', async (_label, sql) => {
      await expect(attempt(sql)).rejects.toThrow(/permission denied/);
    });
  });

  describe('no scheduler privileges: the lock namespace is not its to take', () => {
    it('cannot take an advisory lock at all', async () => {
      // The scheduler's singleton guarantee is one advisory lock. PostgreSQL
      // grants that namespace to PUBLIC by default, so bootstrap revokes it and
      // grants it to operator_sched alone: otherwise a compromised fetcher
      // stalls every tick with one statement, silently and without error.
      await expect(attempt('SELECT pg_try_advisory_lock(1)')).rejects.toThrow(
        /permission denied for function/,
      );
      await expect(attempt('SELECT pg_advisory_xact_lock(1)')).rejects.toThrow(
        /permission denied for function/,
      );
    });

    it('leaves the lock working for the role that needs it', async () => {
      const sched = db.poolAs('operator_sched');
      const taken = await sched.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(424242) AS acquired',
      );
      expect(taken.rows[0]?.acquired).toBe(true);
      await sched.query('SELECT pg_advisory_unlock(424242)');
    });

    it('cannot touch the heartbeat the health endpoint reads', async () => {
      await expect(
        attempt('UPDATE scheduler_heartbeat SET last_tick_at = now()'),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('no migration or admin privileges', () => {
    it.each([
      ['create a table', 'CREATE TABLE fetch_owned (id int)'],
      ['alter a table it writes', 'ALTER TABLE web_snapshots ADD COLUMN injected int'],
      ['drop a table', 'DROP TABLE robots_cache'],
      ['record a migration', `INSERT INTO schema_migrations (version, filename, checksum) VALUES (999, 'x', 'y')`],
    ])('cannot %s', async (_label, sql) => {
      await expect(attempt(sql)).rejects.toThrow(/permission denied|must be owner/);
    });

    it.each([
      ['create a role', 'CREATE ROLE fetch_escalated'],
      ["change another role's password", `ALTER ROLE operator_app PASSWORD 'pwned'`],
      ['become another role', 'SET ROLE operator_app'],
      ['read the password hashes', 'SELECT rolname, rolpassword FROM pg_authid'],
      ['read pg_shadow', 'SELECT * FROM pg_shadow'],
      ['read a file from the host', `SELECT pg_read_file('/etc/passwd')`],
      ['shell out through COPY', `COPY web_snapshots FROM PROGRAM 'id'`],
    ])('cannot %s', async (_label, sql) => {
      await expect(attempt(sql)).rejects.toThrow(/permission denied|must be/);
    });
  });

  describe('two PostgreSQL behaviours that look like escalation and are not', () => {
    it('cannot widen itself with GRANT, which PostgreSQL ignores', async () => {
      // `GRANT SELECT ON web_snapshots TO operator_fetch` run *as*
      // operator_fetch returns success. It is a no-op: PostgreSQL raises
      // WARNING "no privileges were granted" and changes nothing, because the
      // role grants only what it holds WITH GRANT OPTION, which is nothing.
      // Asserted on the outcome rather than the exit code, because the exit
      // code is the misleading part.
      const client = await fetchPool.connect();
      const notices: string[] = [];
      try {
        client.on('notice', (notice) => notices.push(notice.message ?? ''));
        await client.query('GRANT SELECT ON web_snapshots TO operator_fetch');
      } finally {
        client.release(true);
      }
      expect(notices.join(' ')).toMatch(/no privileges were granted/);

      // The privilege it tried to give itself still is not there.
      await expect(attempt('SELECT text FROM web_snapshots')).rejects.toThrow(
        /permission denied/,
      );
      const held = await db.adminPool.query<{ entry: string }>(
        `SELECT table_name || '.' || column_name || ':' || privilege_type AS entry
         FROM information_schema.column_privileges
         WHERE grantee = 'operator_fetch' AND privilege_type = 'SELECT'
         ORDER BY entry`,
      );
      expect(held.rows.map((row) => row.entry)).toEqual([
        'robots_cache.body:SELECT',
        'robots_cache.crawl_delay_seconds:SELECT',
        'robots_cache.fetched_at:SELECT',
        'robots_cache.host:SELECT',
        'robots_cache.id:SELECT',
        'web_snapshots.company_id:SELECT',
        'web_snapshots.content_hash:SELECT',
        'web_snapshots.id:SELECT',
        'web_snapshots.url:SELECT',
      ]);
    });

    it('may change its own password, which buys it nothing', async () => {
      // PostgreSQL lets any role set its own password and there is no privilege
      // to revoke for it. The result is the same role with the same grants: it
      // reads no more than before, and the one thing it can do with it — lock
      // itself out of its own connection — is a self-inflicted outage the
      // health endpoint reports, not an escalation. Changing *another* role's
      // password, the move that would matter, is denied above.
      await attempt(`ALTER ROLE operator_fetch PASSWORD 'rotated_by_itself'`);
      await expect(attempt('SELECT * FROM web_snapshots')).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it('holds no table-level privilege beyond the two tables it works on', async () => {
    const held = await db.adminPool.query<{ entry: string }>(
      `SELECT table_name || ':' || privilege_type AS entry
       FROM information_schema.table_privileges
       WHERE grantee = 'operator_fetch'
       ORDER BY entry`,
    );
    expect(held.rows.map((row) => row.entry)).toEqual([
      'robots_cache:INSERT',
      'robots_cache:SELECT',
      'robots_cache:UPDATE',
      'web_snapshots:INSERT',
    ]);
  });
});
