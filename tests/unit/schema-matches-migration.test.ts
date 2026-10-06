import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';

/**
 * The hand-written SQL is the source of truth (SPEC.md §3). This asserts the
 * Drizzle schema has not drifted from it, because a schema that silently
 * disagrees with the database is worse than no schema at all.
 */
const migrationsDir = join(__dirname, '..', '..', 'migrations');

/** Every migration, so a table added by a later one is covered too. */
const allMigrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n');

const sqlTables = new Set(
  [...allMigrations.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1] as string,
  ),
);

const exported: unknown[] = Object.values(schema);

const drizzleTables = new Set(
  exported
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table)),
);

describe('schema.ts mirrors migration 001', () => {
  it('declares a table for every table the migration creates', () => {
    const missing = [...sqlTables].filter((table) => !drizzleTables.has(table));
    expect(missing).toStrictEqual([]);
  });

  it('declares no table the migration does not create', () => {
    const extra = [...drizzleTables].filter((table) => !sqlTables.has(table));
    expect(extra).toStrictEqual([]);
  });

  it('covers the 24 tables of §4 plus scheduler_heartbeat (migration 003)', () => {
    expect(drizzleTables.size).toBe(25);
    expect(drizzleTables.has('scheduler_heartbeat')).toBe(true);
  });
});
