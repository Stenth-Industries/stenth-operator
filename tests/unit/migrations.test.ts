import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checksum, loadMigrations } from '../../src/db/migrate';

const migrationsDir = join(__dirname, '..', '..', 'migrations');
const init = readFileSync(join(migrationsDir, '001_init.sql'), 'utf8');

/**
 * Strips -- line comments. The "must not appear" assertions below are claims
 * about schema objects, not about the prose that documents what v1.1 removed:
 * a comment recording that gmail_drafts is gone is the opposite of a problem.
 */
function statementsOnly(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const initStatements = statementsOnly(init);

/** Every table in SPEC.md §4. */
const SPEC_TABLES = [
  'users',
  'campaigns',
  'companies',
  'company_sources',
  'web_snapshots',
  'extractions',
  'assessments',
  'contacts',
  'prospects',
  'outreach_drafts',
  'approved_outreach',
  'suppressions',
  'jobs',
  'job_runs',
  'events',
  'llm_calls',
  'model_pricing',
  'budgets',
  'schedules',
  'eval_fixtures',
  'eval_runs',
  'eval_results',
  'practice_area_priors',
  'robots_cache',
];

describe('migration loading (SPEC.md §19 rule 3)', () => {
  it('loads the numbered migrations in version order', () => {
    const migrations = loadMigrations(migrationsDir);
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    expect(migrations[0]?.filename).toBe('001_init.sql');
    expect(migrations[1]?.filename).toBe('002_roles.sql');

    const versions = migrations.map((migration) => migration.version);
    expect(versions).toStrictEqual([...versions].sort());
  });

  it('checksums content, so an edited migration cannot pass unnoticed', () => {
    expect(checksum('a')).toBe(checksum('a'));
    expect(checksum('a')).not.toBe(checksum('a '));
    expect(checksum(init)).toHaveLength(64);
  });
});

describe('001_init.sql covers SPEC.md §4', () => {
  it.each(SPEC_TABLES)('creates %s', (table) => {
    expect(init).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
  });

  it('creates every table §4 lists and no table it does not', () => {
    const created = [...init.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
      (match) => match[1],
    );
    expect(new Set(created)).toStrictEqual(new Set(SPEC_TABLES));
    expect(created).toHaveLength(SPEC_TABLES.length);
  });

  it('declares the enum types §4 requires', () => {
    for (const type of [
      'verdict',
      'discovery_source',
      'consent_basis',
      'outreach_draft_status',
      'review_reason_code',
      'handoff_state',
      'suppression_match_type',
      'suppression_reason',
      'job_kind',
      'job_status',
      'actor_type',
      'llm_isolation',
      'eval_split',
      'eval_label',
    ]) {
      expect(init).toContain(`CREATE TYPE ${type} AS ENUM`);
    }
  });

  it('freezes contact discovery to one permitted source (§9)', () => {
    expect(init).toContain("CREATE TYPE discovery_source AS ENUM ('own_site_published')");
    expect(init).toMatch(/email_source_snapshot_id\s+uuid NOT NULL REFERENCES web_snapshots/);
  });

  it('lists the nine job kinds of §6 and no retired one', () => {
    for (const kind of [
      'discover.search',
      'company.resolve',
      'web.fetch',
      'web.extract',
      'company.assess',
      'contact.resolve',
      'outreach.draft',
      'maintenance.prune',
      'eval.run',
    ]) {
      expect(init).toContain(`'${kind}'`);
    }
    // Retired in v1.1 (§6): no mail API, and the scheduler is not a job.
    expect(initStatements).not.toContain('gmail.create_draft');
    expect(initStatements).not.toContain('maintenance.tick');
  });

  describe('the four constraints that carry the system’s safety (§4)', () => {
    it('deduplicates companies on canonical_domain', () => {
      expect(init).toMatch(/canonical_domain citext NOT NULL UNIQUE/);
    });

    it('makes enqueue idempotent on jobs.dedupe_key', () => {
      expect(init).toMatch(/dedupe_key\s+text NOT NULL UNIQUE/);
    });

    it('permits exactly one approved record per draft', () => {
      expect(init).toMatch(
        /outreach_draft_id\s+uuid NOT NULL UNIQUE REFERENCES outreach_drafts/,
      );
    });

    it('permits one open draft per contact', () => {
      expect(init).toContain('outreach_drafts_one_pending_review_key');
      expect(init).toMatch(/WHERE status = 'pending_review'/);
    });
  });

  it('keeps the audit spine append-only and free of personal text (§4, §16)', () => {
    expect(init).toContain('events_no_update');
    expect(init).toContain('events_no_delete');
    expect(init).toContain('events_payload_carries_no_personal_text');
  });

  it('makes approved content write-once apart from the handoff state (§4, §14)', () => {
    expect(init).toContain('approved_outreach_write_once');
    expect(init).toContain('approved_outreach_no_delete');
  });

  it('carries the warning threshold the $50 ceiling needs (§2, §16)', () => {
    expect(init).toMatch(/warn_usd\s+numeric\(12, 2\) NOT NULL/);
    expect(init).toContain('budgets_warn_at_or_below_limit');
    expect(init).toContain('budgets_hard_stop_at_or_above_limit');
  });

  it('has no table, column or type for a mail credential (§14)', () => {
    const lowered = initStatements.toLowerCase();
    for (const forbidden of ['gmail_drafts', 'refresh_token', 'oauth', 'smtp']) {
      expect(lowered).not.toContain(forbidden);
    }
  });

  it('writes no down-migration (§3: forward-only)', () => {
    expect(initStatements).not.toMatch(/\bDROP TABLE\b/);
    expect(initStatements).not.toMatch(/\bDROP TYPE\b/);
    expect(initStatements).not.toMatch(/\bDROP COLUMN\b/);
  });
});

describe('002_roles.sql grants the five roles of §17', () => {
  const roles = readFileSync(join(migrationsDir, '002_roles.sql'), 'utf8');
  const roleStatements = statementsOnly(roles);

  it('gives the application role DML', () => {
    expect(roles).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO operator_app',
    );
  });

  it('boxes the fetcher in (§8, §23)', () => {
    expect(roles).toContain('GRANT INSERT ON TABLE web_snapshots TO operator_fetch');
    for (const table of ['contacts', 'outreach_drafts', 'approved_outreach', 'events']) {
      expect(roleStatements).not.toMatch(
        new RegExp(`GRANT[^;]*ON TABLE ${table} TO operator_fetch`),
      );
    }
  });

  it('gives the scheduler only schedules and an enqueue (§6, §17)', () => {
    expect(roles).toContain('GRANT SELECT, UPDATE ON TABLE schedules TO operator_sched');
    expect(roles).toContain('GRANT INSERT ON TABLE jobs TO operator_sched');
  });

  it('keeps the read-only role read-only', () => {
    expect(roles).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public TO operator_ro');
    expect(roleStatements).not.toMatch(
      /GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO operator_ro/,
    );
  });

  it('creates no role here: passwords never live in a committed migration (§17)', () => {
    expect(roleStatements).not.toMatch(/\bCREATE ROLE\b/i);
    expect(roleStatements).not.toMatch(/\bPASSWORD\b/i);
    expect(roleStatements).not.toMatch(/\bALTER ROLE\b/i);
  });
});

/**
 * Migration 005: the structural half of finding 1.
 *
 * The fetcher no longer writes a text-bearing non-2xx row, but code is what a
 * future change replaces. §1: "If a guarantee can be structural, it must be
 * structural." These assertions are about the SQL as committed; the behaviour
 * against a real PostgreSQL is in tests/reliability/http-status-outcomes.test.ts.
 */
describe('migration 005: page text requires a 2xx (§8, §9)', () => {
  const sql = readFileSync(join(migrationsDir, '005_snapshot_text_requires_2xx.sql'), 'utf8');
  const statements = statementsOnly(sql);

  it('constrains text to a 2xx status', () => {
    expect(statements).toContain('ADD CONSTRAINT web_snapshots_text_requires_2xx');
    expect(statements).toMatch(/http_status BETWEEN 200 AND 299/);
    // text IS NULL stays legal: the robots-disallowed row and a pruned snapshot
    // both need it (§8, §15).
    expect(statements).toMatch(/text IS NULL/);
  });

  it('adds it NOT VALID, so the one pre-correction row survives', () => {
    // The user's instruction was explicit: keep the historical 403 and write no
    // delete migration. NOT VALID enforces the rule on every new write and
    // skips the scan of what is already there.
    expect(statements).toMatch(/NOT VALID/);
  });

  it('deletes nothing and drops nothing', () => {
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    expect(statements).not.toMatch(/\bDROP TABLE\b/i);
    expect(statements).not.toMatch(/\bDROP COLUMN\b/i);
    // No down migration, per §19 rule 3.
    expect(statements).not.toMatch(/DROP CONSTRAINT(?! IF EXISTS)/i);
  });

  it('defines the one predicate later analysis reads', () => {
    expect(statements).toContain('CREATE OR REPLACE VIEW usable_snapshots');
    expect(statements).toMatch(/http_status BETWEEN 200 AND 299/);
    expect(statements).toMatch(/robots_allowed/);
    expect(statements).toMatch(/text IS NOT NULL/);
  });

  it('never grants that view to the fetcher role', () => {
    // A view runs with its owner's privileges, so granting usable_snapshots to
    // operator_fetch would hand back the page text migration 004 withheld
    // column by column. Granting it to the app and the read-only role is fine.
    expect(statements).toContain('GRANT SELECT ON usable_snapshots TO operator_app');
    expect(statements).toContain('GRANT SELECT ON usable_snapshots TO operator_ro');
    expect(statements).not.toMatch(/usable_snapshots TO operator_fetch/);
    expect(statements).not.toMatch(/usable_snapshots TO PUBLIC/i);
  });
});

/**
 * Migration 006: the Tier A scan lives with the snapshot.
 *
 * §9's signals are read out of the HTML by code, and the HTML is gone by the
 * time a snapshot is stored — html-to-text drops <script>, which is where the
 * AW- identifier lives. The column is where the deterministic scan lands.
 */
describe('migration 006: web_snapshots.signals (§9, §23 case 13)', () => {
  const sql = readFileSync(join(migrationsDir, '006_snapshot_signals.sql'), 'utf8');
  const statements = statementsOnly(sql);

  it('adds one nullable jsonb column, idempotently', () => {
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS signals jsonb/);
    expect(statements).not.toMatch(/NOT NULL/);
  });

  it('changes nothing else: no new table, no dropped object, no grant change', () => {
    expect(statements).not.toMatch(/CREATE TABLE/i);
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bGRANT\b/i);
    expect(statements).not.toMatch(/\bREVOKE\b/i);
  });

  it('leaves the usable_snapshots view alone', () => {
    // Replacing it here would make migration 005 non-re-runnable: CREATE OR
    // REPLACE VIEW cannot drop a column, so 005's older definition would fail
    // against the newer view — and 005 is applied in production, where editing
    // it is not an option (§19 rule 3).
    expect(statements).not.toMatch(/usable_snapshots/);
  });
});

/**
 * Migration 007: the hard stop becomes atomic.
 *
 * §16's control is only a control if it cannot be overtaken. The reservation
 * design is in src/ai/budget.ts; these are the schema facts it rests on.
 */
describe('migration 007: reservations (§16)', () => {
  const sql = readFileSync(join(migrationsDir, '007_llm_call_reservations.sql'), 'utf8');
  const statements = statementsOnly(sql);

  it('adds the two states a reservation needs', () => {
    expect(statements).toMatch(/ADD VALUE IF NOT EXISTS 'reserved'/);
    expect(statements).toMatch(/ADD VALUE IF NOT EXISTS 'abandoned'/);
  });

  it('makes one provider invocation per piece of work structural', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS llm_calls_reservation_key_idx/);
    expect(statements).toMatch(/WHERE reservation_key IS NOT NULL/);
  });

  it('carries no status predicate on that index, so a release can free the work', () => {
    // ALTER TYPE ... ADD VALUE cannot be used in the same transaction, and an
    // abandoned reservation must stop blocking the retry it exists to permit.
    const index = /CREATE UNIQUE INDEX[\s\S]*?;/.exec(statements)?.[0] ?? '';
    expect(index).not.toContain('status');
  });

  it('keeps the estimate alongside the actual, so over-reservation is measurable', () => {
    expect(statements).toMatch(/estimated_cost_usd\s+numeric\(12, 6\)/);
    expect(statements).toMatch(/reserved_at/);
    expect(statements).toMatch(/finalized_at/);
  });

  it('records who reconciled an ambiguous call, and why', () => {
    expect(statements).toMatch(/reconciled_by/);
    expect(statements).toMatch(/reconciliation_note/);
  });

  it('deletes nothing and drops nothing', () => {
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
  });
});

/**
 * Migration 008: the fetcher may fill in a missing scan, and nothing else.
 */
describe('migration 008: the signals backfill grant (§9, §17)', () => {
  const sql = readFileSync(join(migrationsDir, '008_fetcher_signal_backfill.sql'), 'utf8');
  const statements = statementsOnly(sql);

  it('grants UPDATE on one column, never on the table', () => {
    expect(statements).toContain('GRANT UPDATE (signals) ON TABLE web_snapshots TO operator_fetch');
    expect(statements).not.toMatch(/GRANT UPDATE ON TABLE/);
    expect(statements).not.toMatch(/GRANT UPDATE \((?!signals\))/);
  });

  it('reads back only the column it writes, and never the page text', () => {
    // The conflict's own guard — "fill it in where it is NULL" — is a read of
    // `signals`, so the fetcher needs SELECT on that one column. Derived
    // booleans it produced itself; `text` stays unreadable to this role.
    expect(statements).toContain('GRANT SELECT (signals) ON TABLE web_snapshots TO operator_fetch');
    expect(statements).not.toMatch(/GRANT SELECT \((?!signals\))/);
    expect(statements).not.toMatch(/GRANT SELECT ON TABLE/);
  });

  it('grants nothing wider, and nothing to another role', () => {
    expect(statements).not.toMatch(/GRANT (DELETE|INSERT|ALL)/);
    expect(statements).not.toMatch(/TO operator_(app|sched|migrate|ro)/);
    expect(statements).not.toMatch(/TO PUBLIC/i);
  });
});
