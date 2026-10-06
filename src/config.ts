/**
 * Zod-validated environment, failing fast on boot (SPEC.md §19).
 *
 * Every secret in the §17 table appears here. The ones a later day introduces
 * are optional until that day wires them, and the comment names the day — a
 * config that demands a credential nothing reads yet is friction, and a config
 * that silently tolerates a missing credential something does read is a
 * 3am outage.
 *
 * There is deliberately no mail credential of any kind in this schema, in
 * .env.example, or anywhere in the deployment (§1, §14, §17).
 */
import { z } from 'zod';

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    { message: 'must be a postgres:// or postgresql:// URL' },
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Application role (operator_app). Used by the web app and the worker. */
  DATABASE_URL: postgresUrl,

  /**
   * Admin connection, used only by the migration step's bootstrap phase to
   * create extensions and the five roles. Not present on the running app.
   */
  ADMIN_DATABASE_URL: postgresUrl.optional(),

  /** Role passwords (§17), read by the migration step's bootstrap phase. */
  OPERATOR_APP_PASSWORD: z.string().min(1).optional(),
  OPERATOR_FETCH_PASSWORD: z.string().min(1).optional(),
  OPERATOR_SCHED_PASSWORD: z.string().min(1).optional(),
  OPERATOR_MIGRATE_PASSWORD: z.string().min(1).optional(),
  OPERATOR_RO_PASSWORD: z.string().min(1).optional(),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  /** Service name on every log line, so one stdout stream stays readable. */
  SERVICE_NAME: z.string().min(1).default('web'),

  /** Fetcher shared secret (§8, §17). Required from Day 3. */
  FETCHER_SHARED_SECRET: z.string().min(32).optional(),

  /** Session signing key (§13, §17). Required from Day 8. */
  SESSION_SIGNING_KEY: z.string().min(32).optional(),

  /** Model provider API key (§17). Required from Day 4. */
  MODEL_API_KEY: z.string().min(1).optional(),

  /**
   * Monthly AI budget (§2, §16). The budgets table is the operational source of
   * truth; these are the values a month's row is created with, kept in the
   * environment so the ceiling can be raised after the two-week review without
   * a migration.
   *
   * V1 starts deliberately conservative: $50/month, warning at $35, hard stop
   * at $50, sized to 20-40 discovered and 10-15 assessed prospects a day.
   */
  AI_BUDGET_MONTHLY_USD: z.coerce.number().nonnegative().default(50),
  AI_BUDGET_WARN_USD: z.coerce.number().nonnegative().default(35),
  AI_BUDGET_HARD_STOP_USD: z.coerce.number().nonnegative().default(50),
})
  .refine((env) => env.AI_BUDGET_WARN_USD <= env.AI_BUDGET_MONTHLY_USD, {
    message: 'AI_BUDGET_WARN_USD must not exceed AI_BUDGET_MONTHLY_USD',
    path: ['AI_BUDGET_WARN_USD'],
  })
  .refine((env) => env.AI_BUDGET_HARD_STOP_USD >= env.AI_BUDGET_MONTHLY_USD, {
    message: 'AI_BUDGET_HARD_STOP_USD must be at or above AI_BUDGET_MONTHLY_USD',
    path: ['AI_BUDGET_HARD_STOP_USD'],
  });

export type Config = Readonly<z.infer<typeof envSchema>>;

function describe(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `  ${path}: ${issue.message}`;
  });
  return `Invalid environment:\n${lines.join('\n')}`;
}

/**
 * Parses an environment without touching module state. Exported for the config
 * tests, which must not depend on the ambient process environment.
 */
export function parseConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(describe(result.error));
  }
  return Object.freeze(result.data);
}

let cached: Config | undefined;

/** The process configuration. Throws on first call if the environment is invalid. */
export function getConfig(): Config {
  cached ??= parseConfig();
  return cached;
}
