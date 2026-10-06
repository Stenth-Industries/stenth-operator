import { readFileSync } from 'node:fs';
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
const init = readFileSync(join(__dirname, '..', '..', 'migrations', '001_init.sql'), 'utf8');

const sqlTables = new Set(
  [...init.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map((match) => match[1] as string),
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

  it('covers all 24 tables of §4', () => {
    expect(drizzleTables.size).toBe(24);
  });
});
