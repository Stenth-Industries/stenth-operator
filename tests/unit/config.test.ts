import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config';

const minimal: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://operator_app:pw@postgres:5432/operator',
};

describe('config', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => parseConfig({})).toThrowError(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => parseConfig({ DATABASE_URL: 'mysql://host/db' })).toThrowError(
      /postgres/,
    );
  });

  it('applies the documented defaults', () => {
    const config = parseConfig({ ...minimal });
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.PORT).toBe(3000);
  });

  it('defaults the AI budget to the conservative V1 ceiling (SPEC.md §2)', () => {
    const config = parseConfig({ ...minimal });
    expect(config.AI_BUDGET_MONTHLY_USD).toBe(50);
    expect(config.AI_BUDGET_WARN_USD).toBe(35);
    expect(config.AI_BUDGET_HARD_STOP_USD).toBe(50);
  });

  it('rejects a warning threshold above the monthly budget', () => {
    expect(() =>
      parseConfig({ ...minimal, AI_BUDGET_WARN_USD: '60' }),
    ).toThrowError(/AI_BUDGET_WARN_USD/);
  });

  it('rejects a hard stop below the monthly budget', () => {
    expect(() =>
      parseConfig({ ...minimal, AI_BUDGET_HARD_STOP_USD: '20' }),
    ).toThrowError(/AI_BUDGET_HARD_STOP_USD/);
  });

  it('accepts a raised ceiling, which is the point of keeping it in the environment', () => {
    const config = parseConfig({
      ...minimal,
      AI_BUDGET_MONTHLY_USD: '150',
      AI_BUDGET_WARN_USD: '120',
      AI_BUDGET_HARD_STOP_USD: '200',
    });
    expect(config.AI_BUDGET_MONTHLY_USD).toBe(150);
  });

  it('holds no mail credential of any kind (SPEC.md §14, §17)', () => {
    const config = parseConfig({ ...minimal });
    const keys = Object.keys(config).join(' ').toLowerCase();
    for (const forbidden of ['gmail', 'smtp', 'sendgrid', 'postmark', 'resend', 'mail']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('requires a session key long enough to sign with, when present', () => {
    expect(() =>
      parseConfig({ ...minimal, SESSION_SIGNING_KEY: 'short' }),
    ).toThrowError(/SESSION_SIGNING_KEY/);
  });
});
