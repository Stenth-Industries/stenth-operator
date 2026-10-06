/**
 * The migration step (SPEC.md §3, §19, §20).
 *
 * Deploy is four commands, and this is the third of them: it runs as its own
 * step, with the migrate role, before the new code serves traffic.
 *
 * Two phases:
 *
 *   bootstrap  as the admin connection — extensions, and the five roles of §17
 *              with their passwords from the environment. CREATE ROLE needs a
 *              privilege operator_migrate deliberately does not have, and a
 *              role password must never sit in a committed migration.
 *
 *   apply      as operator_migrate — the numbered SQL in migrations/, forward
 *              only, each file once, recorded in schema_migrations.
 *
 * §19 rule 3: migrations are forward-only and are never edited once applied.
 * That rule is enforced here rather than trusted: every applied file's checksum
 * is recorded, and a changed file fails the run instead of drifting silently.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { getConfig } from '../config';
import { getLogger } from '../obs/log';
import { createPool } from './client';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** The five roles of §17, and the environment variable holding each password. */
export const ROLES = [
  { name: 'operator_app', passwordEnv: 'OPERATOR_APP_PASSWORD' },
  { name: 'operator_fetch', passwordEnv: 'OPERATOR_FETCH_PASSWORD' },
  { name: 'operator_sched', passwordEnv: 'OPERATOR_SCHED_PASSWORD' },
  { name: 'operator_migrate', passwordEnv: 'OPERATOR_MIGRATE_PASSWORD' },
  { name: 'operator_ro', passwordEnv: 'OPERATOR_RO_PASSWORD' },
] as const;

const MIGRATION_ROLE = 'operator_migrate';

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Role names are interpolated into DDL, which accepts no bind parameters. They
 * come from the ROLES constant above, and this makes that structural rather
 * than a thing a future edit has to remember.
 */
function assertIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to interpolate "${name}" as an SQL identifier`);
  }
}

export interface Migration {
  readonly version: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

const MIGRATION_FILENAME = /^(\d{3,})_[a-z0-9_]+\.sql$/;

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Reads migrations/ in version order, rejecting anything misnamed or duplicated. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  const seen = new Set<string>();

  for (const filename of files) {
    const match = MIGRATION_FILENAME.exec(basename(filename));
    if (match === null) {
      throw new Error(
        `Migration filename "${filename}" must look like 001_description.sql`,
      );
    }
    const version = match[1];
    if (version === undefined) {
      throw new Error(`Migration filename "${filename}" carries no version`);
    }
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${version}`);
    }
    seen.add(version);

    const sql = readFileSync(join(dir, filename), 'utf8');
    migrations.push({ version, filename, sql, checksum: checksum(sql) });
  }

  return migrations;
}

/**
 * Phase 1. Extensions and roles, as the admin connection.
 *
 * Idempotent: every statement tolerates having been run before, because this
 * runs on every deploy and not only on a fresh database.
 */
export async function bootstrap(client: PoolClient): Promise<void> {
  const log = getLogger();

  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query('CREATE EXTENSION IF NOT EXISTS citext');

  for (const role of ROLES) {
    assertIdentifier(role.name);

    // A dollar-quoted DO body cannot take bind parameters — $1 inside it is
    // literal text — so existence is checked with a parameterised query and the
    // role name, which comes from the ROLES constant, is interpolated.
    const existing = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [role.name],
    );
    if (existing.rowCount === 0) {
      await client.query(`CREATE ROLE ${role.name} LOGIN`);
      log.info({ role: role.name }, 'role created');
    }

    const password = process.env[role.passwordEnv];
    if (password === undefined || password === '') {
      log.warn(
        { role: role.name, env: role.passwordEnv },
        'role password not set; leaving the existing password untouched',
      );
    } else {
      // CREATE/ALTER ROLE accepts no parameters, so the password is quoted by
      // the server and the quoted literal is spliced in. Never interpolate the
      // raw value, and never log the statement.
      const quoted = await client.query<{ literal: string }>(
        'SELECT quote_literal($1::text) AS literal',
        [password],
      );
      const literal = quoted.rows[0]?.literal;
      if (literal === undefined) {
        throw new Error(`Could not quote the password for ${role.name}`);
      }
      await client.query(
        `ALTER ROLE ${role.name} WITH LOGIN PASSWORD ${literal}`,
      );
    }
  }

  // The migration role owns the schema; nobody else may create in it.
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_ROLE}`);
  for (const role of ROLES) {
    if (role.name !== MIGRATION_ROLE) {
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role.name}`);
    }
  }

  // SET ROLE needs membership. A superuser admin already has it; a non-superuser
  // admin with CREATEROLE granted the role above and so can grant it onward.
  await client.query(
    `DO $$
     BEGIN
       IF NOT pg_has_role(current_user, '${MIGRATION_ROLE}', 'MEMBER') THEN
         EXECUTE format('GRANT ${MIGRATION_ROLE} TO %I', current_user);
       END IF;
     END
     $$`,
  );

  log.info({ roles: ROLES.map((role) => role.name) }, 'bootstrap complete');
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      filename   text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

interface LedgerRow {
  version: string;
  filename: string;
  checksum: string;
}

/**
 * Phase 2. Applies every migration not yet recorded, as operator_migrate, each
 * in its own transaction so a failure leaves the ledger and the schema in step.
 */
export async function apply(
  pool: Pool,
  migrations: Migration[],
): Promise<{ applied: string[]; skipped: string[] }> {
  const log = getLogger();
  const applied: string[] = [];
  const skipped: string[] = [];

  const setup = await pool.connect();
  let recorded: Map<string, LedgerRow>;
  try {
    await setup.query(`SET ROLE ${MIGRATION_ROLE}`);
    await ensureLedger(setup);
    const { rows } = await setup.query<LedgerRow>(
      'SELECT version, filename, checksum FROM schema_migrations',
    );
    recorded = new Map(rows.map((row) => [row.version, row]));
  } finally {
    setup.release();
  }

  for (const migration of migrations) {
    const previous = recorded.get(migration.version);

    if (previous !== undefined) {
      if (previous.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.filename} has changed since it was applied. ` +
            'Migrations are forward-only and are never edited once applied ' +
            '(SPEC.md §19 rule 3). Add a new migration instead.',
        );
      }
      skipped.push(migration.filename);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${MIGRATION_ROLE}`);
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.filename, migration.checksum],
      );
      await client.query('COMMIT');
      applied.push(migration.filename);
      log.info({ migration: migration.filename }, 'migration applied');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  const config = getConfig();
  const log = getLogger();

  const adminUrl = config.ADMIN_DATABASE_URL;
  if (adminUrl === undefined) {
    throw new Error(
      'ADMIN_DATABASE_URL is required by the migration step: it creates the ' +
        'extensions and the five roles of SPEC.md §17, which operator_app ' +
        'cannot do.',
    );
  }

  const migrations = loadMigrations();
  log.info({ count: migrations.length }, 'migrations discovered');

  const pool = createPool(adminUrl);
  try {
    const client = await pool.connect();
    try {
      await bootstrap(client);
    } finally {
      client.release();
    }

    const result = await apply(pool, migrations);
    log.info(
      { applied: result.applied, skipped: result.skipped.length },
      'migrations up to date',
    );
    return result;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      getLogger().error({ err: error }, 'migration failed');
      process.exit(1);
    });
}
