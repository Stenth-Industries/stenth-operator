import { describe, expect, it } from 'vitest';

import { dedupeKey, isJobKind, JOB_KINDS, MAX_ATTEMPTS } from '../../src/jobs/kinds';

describe('job kinds (SPEC.md §6)', () => {
  it('declares the nine kinds and no retired one', () => {
    expect([...JOB_KINDS]).toStrictEqual([
      'discover.search',
      'company.resolve',
      'web.fetch',
      'web.extract',
      'company.assess',
      'contact.resolve',
      'outreach.draft',
      'maintenance.prune',
      'eval.run',
    ]);
    expect(isJobKind('gmail.create_draft')).toBe(false);
    expect(isJobKind('maintenance.tick')).toBe(false);
  });

  it('carries the §6 retry budgets exactly', () => {
    expect(MAX_ATTEMPTS).toStrictEqual({
      'discover.search': 3,
      'company.resolve': 3,
      'web.fetch': 3,
      'web.extract': 2,
      'company.assess': 2,
      'contact.resolve': 2,
      'outreach.draft': 2,
      'maintenance.prune': 3,
      'eval.run': 1,
    });
  });

  it('gives every kind a budget', () => {
    for (const kind of JOB_KINDS) {
      expect(MAX_ATTEMPTS[kind]).toBeGreaterThan(0);
    }
  });
});

describe('dedupe keys (SPEC.md §7)', () => {
  it('matches the §7 table', () => {
    expect(dedupeKey.discoverSearch('au-law', 'q9f2', '2026-10-07')).toBe(
      'discover:au-law:q9f2:2026-10-07',
    );
    expect(dedupeKey.companyResolve('example-legal.com.au')).toBe(
      'resolve:example-legal.com.au',
    );
    expect(dedupeKey.webFetch('c1', 'u7', '2026-10-07')).toBe('fetch:c1:u7:2026-10-07');
    expect(dedupeKey.webExtract('s1', 'v1')).toBe('extract:s1:v1');
    expect(dedupeKey.companyAssess('c1', 'k1', 'v1.1', 'h9')).toBe(
      'assess:c1:k1:v1.1:h9',
    );
    expect(dedupeKey.contactResolve('c1', 'a1')).toBe('contact:c1:a1');
    expect(dedupeKey.outreachDraft('p1', 'ct1', 'pv1', 'a1')).toBe(
      'draft:p1:ct1:pv1:a1',
    );
    expect(dedupeKey.maintenancePrune('2026-10-07')).toBe('prune:2026-10-07');
  });

  it('derives keys from the work, so the same work gives the same key', () => {
    expect(dedupeKey.companyAssess('c1', 'k1', 'v1.1', 'h9')).toBe(
      dedupeKey.companyAssess('c1', 'k1', 'v1.1', 'h9'),
    );
  });

  it('changes the assessment key when the rubric or the content moves (§7)', () => {
    const base = dedupeKey.companyAssess('c1', 'k1', 'v1.1', 'h9');
    expect(dedupeKey.companyAssess('c1', 'k1', 'v1.2', 'h9')).not.toBe(base);
    expect(dedupeKey.companyAssess('c1', 'k1', 'v1.1', 'h10')).not.toBe(base);
  });

  it('separates occurrences of recurring work (§7)', () => {
    expect(dedupeKey.maintenancePrune('2026-10-07')).not.toBe(
      dedupeKey.maintenancePrune('2026-10-08'),
    );
  });
});
