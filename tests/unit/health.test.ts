import { describe, expect, it } from 'vitest';

import { collectHealth, spendState } from '../../src/db/health';

describe('spend state against the V1 ceiling (SPEC.md §2, §16)', () => {
  const warn = 35;
  const hardStop = 50;

  it('is ok below the warning', () => {
    expect(spendState(0, warn, hardStop)).toBe('ok');
    expect(spendState(34.99, warn, hardStop)).toBe('ok');
  });

  it('warns from the warning threshold up', () => {
    expect(spendState(35, warn, hardStop)).toBe('warn');
    expect(spendState(49.99, warn, hardStop)).toBe('warn');
  });

  it('is stopped at the hard stop, so the ceiling is a control and not a report', () => {
    expect(spendState(50, warn, hardStop)).toBe('stopped');
    expect(spendState(120, warn, hardStop)).toBe('stopped');
  });
});

describe('collectHealth when the database is unreachable (§20)', () => {
  it('reports an error status rather than throwing', async () => {
    const failing = {
      connect: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.1:5432')),
    } as unknown as Parameters<typeof collectHealth>[0];

    const report = await collectHealth(failing);

    expect(report.status).toBe('error');
    expect(report.database.connected).toBe(false);
    expect(report.queue).toBeNull();
    expect(report.spend).toBeNull();
    expect(report.database.error).toContain('ECONNREFUSED');
  });
});
