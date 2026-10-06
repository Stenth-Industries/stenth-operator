/**
 * Database access (SPEC.md §3, §19).
 *
 * One pool per process, connected with the application role (operator_app).
 * The migration step and the fetcher service use their own roles and their own
 * connection strings — least privilege is a connection-level property here, not
 * a code-level one.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import { getConfig } from '../config';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Database | undefined;

function poolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    // A missing or wedged database must surface as a failed health check, not
    // as a request that hangs until the proxy gives up.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    application_name: getConfig().SERVICE_NAME,
  };
}

export function getPool(): Pool {
  pool ??= new Pool(poolConfig(getConfig().DATABASE_URL));
  return pool;
}

export function getDb(): Database {
  db ??= drizzle(getPool(), { schema });
  return db;
}

/** A short-lived pool on an arbitrary connection string, for scripts and tests. */
export function createPool(connectionString: string): Pool {
  return new Pool(poolConfig(connectionString));
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    const closing = pool;
    pool = undefined;
    db = undefined;
    await closing.end();
  }
}

export { schema };
