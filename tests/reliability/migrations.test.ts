import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectHealth } from '../../src/db/health';
import { ROLES, apply, bootstrap, loadMigrations } from '../../src/db/migrate';

/**
 * Day 1 exit criterion: "migrations idempotent on a fresh database" (§25).
 *
 * This runs against a real PostgreSQL 16. Set TEST_ADMIN_DATABASE_URL to a
 * superuser connection; the suite creates its own throwaway database, migrates
 * it, and drops it again, so it never touches an existing one.
 */
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const migrationsDir = join(__dirname, '..', '..', 'migrations');

const describeWithDb = adminUrl === undefined ? describe.skip : describe;

if (adminUrl === undefined) {
  console.warn(
    'TEST_ADMIN_DATABASE_URL is not set — skipping the migration reliability ' +
      'suite. It needs a real PostgreSQL 16 superuser connection.',
  );
}

const PASSWORDS: Record<string, string> = {
  OPERATOR_APP_PASSWORD: 'test_app_pw',
  OPERATOR_FETCH_PASSWORD: 'test_fetch_pw',
  OPERATOR_SCHED_PASSWORD: 'test_sched_pw',
  OPERATOR_MIGRATE_PASSWORD: 'test_migrate_pw',
  OPERATOR_RO_PASSWORD: 'test_ro_pw',
};

/** Every table in SPEC.md §4. */
const SPEC_TABLES = [
  'users', 'campaigns', 'companies', 'company_sources', 'web_snapshots',
  'extractions', 'assessments', 'contacts', 'prospects', 'outreach_drafts',
  'approved_outreach', 'suppressions', 'jobs', 'job_runs', 'events',
  'llm_calls', 'model_pricing', 'budgets', 'schedules', 'eval_fixtures',
  'eval_runs', 'eval_results', 'practice_area_priors', 'robots_cache',
];

describeWithDb('migrations on a fresh database (SPEC.md §25 Day 1)', () => {
  const dbName = `operator_test_${randomBytes(6).toString('hex')}`;
  let maintenancePool: Pool;
  let pool: Pool;
  let targetUrl: string;

  /**
   * Every pool the suite opens, so teardown can close all of them before the
   * database is dropped. DROP DATABASE WITH (FORCE) terminates whatever is
   * still connected, which reaches an idle client as an unhandled 57P01; the
   * error handler keeps a connection the server closed from failing the run.
   */
  const pools: Pool[] = [];

  function trackPool(connectionString: string): Pool {
    const created = new Pool({ connectionString });
    created.on('error', () => {
      // A connection terminated by the server during teardown is expected.
    });
    pools.push(created);
    return created;
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(PASSWORDS)) {
      process.env[key] = value;
    }

    const base = new URL(adminUrl as string);
    maintenancePool = new Pool({ connectionString: adminUrl });
    await maintenancePool.query(`CREATE DATABASE ${dbName}`);

    base.pathname = `/${dbName}`;
    targetUrl = base.toString();
    pool = trackPool(targetUrl);

    const client = await pool.connect();
    try {
      await bootstrap(client);
    } finally {
      // SET ROLE lasts for the session, so a client released still wearing
      // a role lends it to the next borrower of that connection.
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });

  afterAll(async () => {
    // Close every connection first, then drop. The other order makes the drop
    // race pools that are still ending.
    await Promise.allSettled(pools.map((open) => open.end()));
    if (maintenancePool !== undefined) {
      await maintenancePool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await maintenancePool.end();
    }
  });

  it('applies every migration on the first run', async () => {
    const result = await apply(pool, loadMigrations(migrationsDir));
    expect(result.applied).toStrictEqual([
      '001_init.sql',
      '002_roles.sql',
      '003_scheduler_heartbeat.sql',
      '004_fetcher_snapshot_grants.sql',
    ]);
    expect(result.skipped).toStrictEqual([]);
  });

  it('is idempotent: a second run applies nothing and fails nothing', async () => {
    const result = await apply(pool, loadMigrations(migrationsDir));
    expect(result.applied).toStrictEqual([]);
    expect(result.skipped).toStrictEqual([
      '001_init.sql',
      '002_roles.sql',
      '003_scheduler_heartbeat.sql',
      '004_fetcher_snapshot_grants.sql',
    ]);
  });

  it('is idempotent at the file level too: the raw SQL re-runs cleanly', async () => {
    // The ledger makes re-running a no-op, but each file is also individually
    // guarded, so a hand-run during an incident cannot half-apply.
    const client = await pool.connect();
    try {
      await client.query('SET ROLE operator_migrate');
      for (const file of [
        '001_init.sql',
        '002_roles.sql',
        '003_scheduler_heartbeat.sql',
        '004_fetcher_snapshot_grants.sql',
      ]) {
        await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
      }
    } finally {
      // SET ROLE lasts for the session, so a client released still wearing
      // a role lends it to the next borrower of that connection.
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });

  it('refuses a migration that changed after it was applied (§19 rule 3)', async () => {
    const migrations = loadMigrations(migrationsDir).map((migration) =>
      migration.version === '001'
        ? { ...migration, checksum: 'tampered' }
        : migration,
    );
    await expect(apply(pool, migrations)).rejects.toThrow(/forward-only/);
  });

  it('creates all 24 tables of §4', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const present = new Set(rows.map((row) => row.table_name));
    for (const table of SPEC_TABLES) {
      expect(present.has(table), `${table} is missing`).toBe(true);
    }
    // Plus scheduler_heartbeat (migration 003) and the migration ledger, which
    // is infrastructure rather than §4 schema.
    expect(present.has('scheduler_heartbeat')).toBe(true);
    expect(present.size).toBe(SPEC_TABLES.length + 2);
  });

  it('creates the five roles of §17', async () => {
    const { rows } = await pool.query<{ rolname: string; rolcanlogin: boolean }>(
      'SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)',
      [ROLES.map((role) => role.name)],
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.rolcanlogin, `${row.rolname} cannot log in`).toBe(true);
    }
  });

  it('installs the four constraints that carry the system’s safety (§4)', async () => {
    const { rows } = await pool.query<{ indexdef: string; indexname: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const defs = rows.map((row) => row.indexdef).join('\n');

    expect(defs).toMatch(/UNIQUE INDEX .*companies.*\(canonical_domain\)/);
    expect(defs).toMatch(/UNIQUE INDEX .*jobs.*\(dedupe_key\)/);
    expect(defs).toMatch(/UNIQUE INDEX .*approved_outreach.*\(outreach_draft_id\)/);
    expect(
      rows.some(
        (row) =>
          row.indexname === 'outreach_drafts_one_pending_review_key' &&
          row.indexdef.includes("WHERE (status = 'pending_review'::outreach_draft_status)"),
      ),
      'the partial unique index on outreach_drafts is missing',
    ).toBe(true);
  });

  it('indexes the claim query and the audit spine (§4, §6)', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(rows.map((row) => row.indexname));
    expect(names.has('jobs_status_run_after_priority_idx')).toBe(true);
    expect(names.has('events_entity_created_at_idx')).toBe(true);
  });

  it('rejects a duplicate dedupe_key, so an enqueue is idempotent (§7)', async () => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE operator_app');
      const key = `fetch:test:${randomBytes(4).toString('hex')}`;
      const insert = `INSERT INTO jobs (kind, dedupe_key, max_attempts, trace_id)
                      VALUES ('web.fetch', $1, 3, '01JA2BCDEFGHJKMNPQRSTVWXYZ')`;
      await client.query(insert, [key]);
      await expect(client.query(insert, [key])).rejects.toThrow(/duplicate key/);

      // Which is why the real enqueue is ON CONFLICT DO NOTHING (§7).
      const onConflict = await client.query(
        `${insert} ON CONFLICT (dedupe_key) DO NOTHING`,
        [key],
      );
      expect(onConflict.rowCount).toBe(0);
    } finally {
      // SET ROLE lasts for the session, so a client released still wearing
      // a role lends it to the next borrower of that connection.
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });

  describe('the audit spine is append-only (§4, §16)', () => {
    it('refuses an update or a delete, as the table owner', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE operator_migrate');
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload)
           VALUES ('company', gen_random_uuid(), 'test.recorded', 'system', '{"ref":"x"}')
           RETURNING id`,
        );
        const id = rows[0]?.id as string;

        await expect(
          client.query("UPDATE events SET kind = 'tampered' WHERE id = $1", [id]),
        ).rejects.toThrow(/append-only/);
        await expect(
          client.query('DELETE FROM events WHERE id = $1', [id]),
        ).rejects.toThrow(/append-only/);
      } finally {
        // SET ROLE lasts for the session, so a client released still wearing
        // a role lends it to the next borrower of that connection.
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });

    it('refuses a payload carrying personal text (§16)', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE operator_app');
        await expect(
          client.query(
            `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload)
             VALUES ('contact', gen_random_uuid(), 'contact.resolved', 'system',
                     '{"email":"partner@example.com.au"}')`,
          ),
        ).rejects.toThrow(/events_payload_carries_no_personal_text/);
      } finally {
        // SET ROLE lasts for the session, so a client released still wearing
        // a role lends it to the next borrower of that connection.
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });
  });

  describe('approved_outreach is write-once (§4, §14)', () => {
    let approvedId: string;

    beforeAll(async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE operator_app');
        await client.query('BEGIN');

        const user = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash) VALUES ('ops@example.com.au', '$argon2id$stub')
           RETURNING id`,
        );
        const campaign = await client.query<{ id: string }>(
          `INSERT INTO campaigns (slug, name, rubric_version) VALUES ('au-law', 'AU law firms', 'v1.1')
           RETURNING id`,
        );
        const company = await client.query<{ id: string }>(
          `INSERT INTO companies (canonical_domain) VALUES ('example-legal.com.au') RETURNING id`,
        );
        const snapshot = await client.query<{ id: string }>(
          `INSERT INTO web_snapshots (company_id, url, content_hash, robots_allowed)
           VALUES ($1, 'https://example-legal.com.au/team', 'abc123', true) RETURNING id`,
          [company.rows[0]?.id],
        );
        const contact = await client.query<{ id: string }>(
          `INSERT INTO contacts (company_id, full_name, email, email_source_snapshot_id, consent_basis, role_relevant)
           VALUES ($1, 'A Partner', 'partner@example-legal.com.au', $2, 'inferred_published', true)
           RETURNING id`,
          [company.rows[0]?.id, snapshot.rows[0]?.id],
        );
        const prospect = await client.query<{ id: string }>(
          `INSERT INTO prospects (company_id, campaign_id) VALUES ($1, $2) RETURNING id`,
          [company.rows[0]?.id, campaign.rows[0]?.id],
        );
        const draft = await client.query<{ id: string }>(
          `INSERT INTO outreach_drafts (prospect_id, contact_id, variant_no, subject, body_text, prompt_version)
           VALUES ($1, $2, 1, 'A subject', 'A body', 'p1') RETURNING id`,
          [prospect.rows[0]?.id, contact.rows[0]?.id],
        );

        // The approval transaction, in the statement order §7 states literally:
        // the approved row first, then its event. The FK is DEFERRABLE, so this
        // order works without a second pass.
        const approved = await client.query<{ id: string }>(
          `INSERT INTO approved_outreach
             (outreach_draft_id, prospect_id, contact_id, to_email, subject, body_text,
              approved_by, approval_event_id, content_hash)
           VALUES ($1, $2, $3, 'partner@example-legal.com.au', 'A subject', 'A body',
                   $4, $5, 'hash-1')
           RETURNING id`,
          [
            draft.rows[0]?.id,
            prospect.rows[0]?.id,
            contact.rows[0]?.id,
            user.rows[0]?.id,
            '00000000-0000-0000-0000-000000000001',
          ],
        );
        await client.query(
          `INSERT INTO events (id, entity_type, entity_id, kind, actor_type, actor_id)
           VALUES ($1, 'outreach_draft', $2, 'outreach.approved', 'human', $3)`,
          ['00000000-0000-0000-0000-000000000001', draft.rows[0]?.id, user.rows[0]?.id],
        );
        await client.query(
          `UPDATE outreach_drafts SET status = 'approved' WHERE id = $1`,
          [draft.rows[0]?.id],
        );

        await client.query('COMMIT');
        approvedId = approved.rows[0]?.id as string;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        // SET ROLE lasts for the session, so a client released still wearing
        // a role lends it to the next borrower of that connection.
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });

    it('permits exactly one approved record per draft, so a double click cannot duplicate it', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE operator_app');
        const { rows } = await client.query<{ outreach_draft_id: string }>(
          'SELECT outreach_draft_id FROM approved_outreach WHERE id = $1',
          [approvedId],
        );
        await expect(
          client.query(
            `INSERT INTO approved_outreach
               (outreach_draft_id, prospect_id, contact_id, approved_by, approval_event_id, content_hash)
             SELECT outreach_draft_id, prospect_id, contact_id, approved_by, approval_event_id, 'hash-2'
             FROM approved_outreach WHERE id = $1`,
            [approvedId],
          ),
        ).rejects.toThrow(/duplicate key/);
        expect(rows).toHaveLength(1);
      } finally {
        // SET ROLE lasts for the session, so a client released still wearing
        // a role lends it to the next borrower of that connection.
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });

    it('allows the handoff state to move', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE operator_app');
        await client.query(
          `UPDATE approved_outreach SET handoff_state = 'marked_sent', marked_sent_at = now()
           WHERE id = $1`,
          [approvedId],
        );
        const { rows } = await client.query<{ handoff_state: string }>(
          'SELECT handoff_state FROM approved_outreach WHERE id = $1',
          [approvedId],
        );
        expect(rows[0]?.handoff_state).toBe('marked_sent');
      } finally {
        // SET ROLE lasts for the session, so a client released still wearing
        // a role lends it to the next borrower of that connection.
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });

    it('refuses to rewrite the approved content', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE operator_app');
        await expect(
          client.query(
            `UPDATE approved_outreach SET body_text = 'something else' WHERE id = $1`,
            [approvedId],
          ),
        ).rejects.toThrow(/write-once/);
        await expect(
          client.query(`UPDATE approved_outreach SET content_hash = 'x' WHERE id = $1`, [
            approvedId,
          ]),
        ).rejects.toThrow(/write-once/);
      } finally {
        // SET ROLE lasts for the session, so a client released still wearing
        // a role lends it to the next borrower of that connection.
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });

    it('permits redaction to null personal text, which §15 step 2 requires', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE operator_app');
        await client.query(
          `UPDATE approved_outreach SET to_email = NULL, body_text = NULL WHERE id = $1`,
          [approvedId],
        );
        const { rows } = await client.query<{ to_email: string | null }>(
          'SELECT to_email FROM approved_outreach WHERE id = $1',
          [approvedId],
        );
        expect(rows[0]?.to_email).toBeNull();
      } finally {
        // SET ROLE lasts for the session, so a client released still wearing
        // a role lends it to the next borrower of that connection.
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });

    it('refuses a contact address with no stored page behind it (§9)', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE operator_app');
        await expect(
          client.query(
            `INSERT INTO contacts (company_id, email, consent_basis)
             SELECT id, 'guessed@example-legal.com.au', 'inferred_published'
             FROM companies LIMIT 1`,
          ),
        ).rejects.toThrow(/email_source_snapshot_id/);
      } finally {
        // SET ROLE lasts for the session, so a client released still wearing
        // a role lends it to the next borrower of that connection.
        await client.query('RESET ROLE').catch(() => undefined);
        client.release();
      }
    });
  });

  it('hands pooled connections back without a lingering SET ROLE (§17)', async () => {
    // apply() runs each migration as operator_migrate, and SET ROLE outlives
    // the statement — it lasts for the session. A client released without
    // RESET ROLE lends operator_migrate to whoever borrows that connection
    // next, so the admin pool silently stops being the admin pool. It surfaced
    // as the scheduler's advisory lock being denied to a superuser connection,
    // which is the kind of clue that costs an afternoon.
    //
    // Every connection in the pool is checked, not one: the tainted client is
    // whichever the migration happened to borrow.
    const clients = await Promise.all(
      Array.from({ length: 10 }, () => pool.connect()),
    );
    try {
      for (const client of clients) {
        const { rows } = await client.query<{ now_role: string; login_role: string }>(
          'SELECT current_user AS now_role, session_user AS login_role',
        );
        expect(rows[0]?.now_role).toBe(rows[0]?.login_role);
        expect(rows[0]?.now_role).not.toBe('operator_migrate');
      }
    } finally {
      for (const client of clients) {
        client.release();
      }
    }
  });

  describe('the fetcher is boxed in (§8, §17, §23)', () => {
    let fetcherPool: Pool;

    beforeAll(() => {
      const url = new URL(targetUrl);
      url.username = 'operator_fetch';
      url.password = PASSWORDS.OPERATOR_FETCH_PASSWORD as string;
      fetcherPool = trackPool(url.toString());
    });

    it.each(['contacts', 'outreach_drafts', 'approved_outreach', 'events'])(
      'cannot read %s',
      async (table) => {
        await expect(fetcherPool.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(
          /permission denied/,
        );
      },
    );

    it('can insert a snapshot and read the robots cache it obeys', async () => {
      const company = await pool.query<{ id: string }>(
        'SELECT id FROM companies LIMIT 1',
      );
      await fetcherPool.query(
        `INSERT INTO web_snapshots (company_id, url, content_hash, robots_allowed)
         VALUES ($1, 'https://example-legal.com.au/about', 'def456', true)`,
        [company.rows[0]?.id],
      );
      await fetcherPool.query('SELECT * FROM robots_cache LIMIT 1');
    });

    it('cannot claim a job, which is why the worker calls it instead (§8)', async () => {
      await expect(
        fetcherPool.query(
          `UPDATE jobs SET status = 'running' WHERE status = 'queued'`,
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it('serves a green health report against the migrated database (§20)', async () => {
    const appUrl = new URL(targetUrl);
    appUrl.username = 'operator_app';
    appUrl.password = PASSWORDS.OPERATOR_APP_PASSWORD as string;
    const appPool = trackPool(appUrl.toString());

    try {
      const report = await collectHealth(appPool);
      expect(report.status).toBe('ok');
      expect(report.database.connected).toBe(true);
      expect(report.queue).not.toBeNull();
      expect(report.queue?.dead).toBe(0);
      expect(report.queue?.blocked).toBe(0);
      expect(report.last_scheduler_tick_age_seconds).toBeNull();
      expect(report.spend?.month_to_date_usd).toBe(0);
      expect(report.spend?.warn_usd).toBe(35);
      expect(report.spend?.hard_stop_usd).toBe(50);
      expect(report.spend?.state).toBe('ok');
    } finally {
      await appPool.end();
    }
  });

  it('reports a warning state once spend crosses $35 (§2, §16)', async () => {
    const appUrl = new URL(targetUrl);
    appUrl.username = 'operator_app';
    appUrl.password = PASSWORDS.OPERATOR_APP_PASSWORD as string;
    const appPool = trackPool(appUrl.toString());

    try {
      // The budgets row is the operational source of truth, so the ceiling is a
      // data change and not a deploy (§16).
      await appPool.query(
        `INSERT INTO budgets (period_month, limit_usd, warn_usd, hard_stop_usd)
         VALUES (date_trunc('month', now())::date, 50, 35, 50)
         ON CONFLICT (period_month) DO NOTHING`,
      );
      await appPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, status, cost_usd)
         VALUES ('01JA2BCDEFGHJKMNPQRSTVWXYZ', 'company.assess', 'privileged',
                 'test', 'test-model', 'succeeded', 36.00)`,
      );

      const report = await collectHealth(appPool);
      expect(report.spend?.month_to_date_usd).toBe(36);
      expect(report.spend?.state).toBe('warn');

      // And the hard stop, which blocks rather than warns.
      await appPool.query(
        `INSERT INTO llm_calls (trace_id, purpose, isolation, provider, model, status, cost_usd)
         VALUES ('01JA2BCDEFGHJKMNPQRSTVWXYZ', 'company.assess', 'privileged',
                 'test', 'test-model', 'succeeded', 20.00)`,
      );
      const stopped = await collectHealth(appPool);
      expect(stopped.spend?.state).toBe('stopped');
    } finally {
      await appPool.end();
    }
  });

  it('refuses a budget whose warning sits above its limit (§16)', async () => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE operator_app');
      await expect(
        client.query(
          `INSERT INTO budgets (period_month, limit_usd, warn_usd, hard_stop_usd)
           VALUES ('2030-01-01', 50, 60, 50)`,
        ),
      ).rejects.toThrow(/budgets_warn_at_or_below_limit/);
    } finally {
      // SET ROLE lasts for the session, so a client released still wearing
      // a role lends it to the next borrower of that connection.
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });
});
