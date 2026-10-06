import type { Config } from 'drizzle-kit';

/**
 * Drizzle is used for queries and types only. Migrations are hand-written SQL
 * in migrations/ and are never generated (SPEC.md §3): the SQL stays visible
 * and reviewable. This config exists for introspection and for `drizzle-kit
 * check`, not for `generate`.
 */
export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
