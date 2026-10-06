/**
 * A throwaway migrated database per suite.
 *
 * The queue's guarantees are PostgreSQL's — FOR UPDATE SKIP LOCKED, unique
 * constraints, advisory locks, transaction isolation. Mocking those would test
 * the mock, so every suite that touches them runs against a real PostgreSQL 16
 * and creates its own database so suites cannot interfere with each other.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { Pool } from 'pg';

import { apply, bootstrap, loadMigrations } from '../../src/db/migrate';

export const ROLE_PASSWORDS: Readonly<Record<string, string>> = {
  OPERATOR_APP_PASSWORD: 'test_app_pw',
  OPERATOR_FETCH_PASSWORD: 'test_fetch_pw',
  OPERATOR_SCHED_PASSWORD: 'test_sched_pw',
  OPERATOR_MIGRATE_PASSWORD: 'test_migrate_pw',
  OPERATOR_RO_PASSWORD: 'test_ro_pw',
};

export interface TestDatabase {
  readonly dbName: string;
  /** Superuser connection to the throwaway database. */
  readonly adminPool: Pool;
  /** A pool connected as one of the five roles of §17. */
  poolAs(role: 'operator_app' | 'operator_sched' | 'operator_fetch' | 'operator_ro'): Pool;
  urlAs(role: string): string;
  /** Truncates the queue tables between cases without re-migrating. */
  resetQueue(): Promise<void>;
  close(): Promise<void>;
}

export const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;

/** True when a real database is configured; suites skip cleanly without one. */
export const hasDatabase = adminUrl !== undefined;

export async function createTestDatabase(): Promise<TestDatabase> {
  if (adminUrl === undefined) {
    throw new Error('TEST_ADMIN_DATABASE_URL is not set');
  }

  for (const [key, value] of Object.entries(ROLE_PASSWORDS)) {
    process.env[key] = value;
  }

  const dbName = `operator_test_${randomBytes(6).toString('hex')}`;
  const maintenancePool = new Pool({ connectionString: adminUrl });
  maintenancePool.on('error', () => undefined);
  await maintenancePool.query(`CREATE DATABASE ${dbName}`);

  const target = new URL(adminUrl);
  target.pathname = `/${dbName}`;
  const targetUrl = target.toString();

  const pools: Pool[] = [];
  function track(connectionString: string): Pool {
    const pool = new Pool({ connectionString });
    // DROP DATABASE WITH (FORCE) terminates whatever is still connected, which
    // reaches an idle client as an unhandled 57P01 without this.
    pool.on('error', () => undefined);
    pools.push(pool);
    return pool;
  }

  const adminPool = track(targetUrl);

  const client = await adminPool.connect();
  try {
    await bootstrap(client);
  } finally {
    client.release();
  }
  await apply(adminPool, loadMigrations(join(__dirname, '..', '..', 'migrations')));

  function urlAs(role: string): string {
    const url = new URL(targetUrl);
    url.username = role;
    const password = ROLE_PASSWORDS[`${role.toUpperCase()}_PASSWORD`];
    if (password === undefined) {
      throw new Error(`No test password for role ${role}`);
    }
    url.password = password;
    return url.toString();
  }

  const byRole = new Map<string, Pool>();

  return {
    dbName,
    adminPool,
    urlAs,
    poolAs(role) {
      let pool = byRole.get(role);
      if (pool === undefined) {
        pool = track(urlAs(role));
        byRole.set(role, pool);
      }
      return pool;
    },
    async resetQueue() {
      // events and job_runs are append-only through their triggers, so the
      // reset goes through the owner and TRUNCATE, which triggers do not see.
      await adminPool.query(
        'TRUNCATE events, job_runs, jobs, schedules, scheduler_heartbeat CASCADE',
      );
    },
    async close() {
      await Promise.allSettled(pools.map((pool) => pool.end()));
      await maintenancePool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await maintenancePool.end();
    },
  };
}
