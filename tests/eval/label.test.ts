/**
 * Human labelling (SPEC.md §21, §25 Day 5).
 *
 * §25's Day 5 exit criterion is "Kushagra labels 60 fixtures", so the tests here
 * are mostly about what the software refuses to do: infer a label, accept a
 * value outside §4's enum, overwrite a decision, or call 59 finished.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { readLabels } from '../../eval/corpus';
import {
  REQUIRED_LABEL_COUNT,
  labelStatus,
  labellingBrief,
  recordLabel,
} from '../../eval/label';
import { nextUnlabelled } from '../../eval/label-cli';
import { assignSplit } from '../../eval/split';
import { aLabel, removeSet, scratchSet, writeFixture, writeLabels } from './helpers';

const sets: string[] = [];

function freshSet(domains: readonly string[]): string {
  const fixtureSet = scratchSet('label');
  sets.push(fixtureSet);
  for (const domain of domains) {
    writeFixture(fixtureSet, domain);
  }
  return fixtureSet;
}

afterEach(() => {
  while (sets.length > 0) {
    removeSet(sets.pop() as string);
  }
});

const NOW = new Date('2026-10-10T04:05:06.000Z');

describe('recording a decision', () => {
  it('writes the label, the reasons, who decided and when', () => {
    const fixtureSet = freshSet(['harbourline.example']);
    const result = recordLabel({
      fixtureSet,
      domain: 'harbourline.example',
      label: 'qualified',
      reasonCodes: ['small_firm', 'no_aw_tag'],
      disqualifier: null,
      labelledBy: 'Kushagra',
      now: NOW,
    });

    expect(result.label).toStrictEqual({
      label: 'qualified',
      reason_codes: ['small_firm', 'no_aw_tag'],
      disqualifier: null,
      labelled_by: 'Kushagra',
      labelled_at: '2026-10-10T04:05:06.000Z',
    });
    expect(result.replaced).toBeUndefined();
    expect(readLabels(fixtureSet).labels['harbourline.example']?.label).toBe('qualified');
  });

  it('records a §10 hard disqualifier when one applies', () => {
    const fixtureSet = freshSet(['chambers.example']);
    const result = recordLabel({
      fixtureSet,
      domain: 'chambers.example',
      label: 'rejected',
      reasonCodes: ['barristers_chambers'],
      disqualifier: 'barristers chambers, not a firm',
      labelledBy: 'Kushagra',
      now: NOW,
    });
    expect(result.label.disqualifier).toBe('barristers chambers, not a firm');
  });

  it('refuses a label for a fixture that does not exist', () => {
    const fixtureSet = freshSet(['harbourline.example']);
    expect(() =>
      recordLabel({
        fixtureSet,
        domain: 'never-frozen.example',
        label: 'qualified',
        reasonCodes: [],
        disqualifier: null,
        labelledBy: 'Kushagra',
      }),
    ).toThrow(/missing_fixture/);
  });

  it('accepts only §4’s two label values', () => {
    const fixtureSet = freshSet(['harbourline.example']);
    for (const bad of ['uncertain', 'maybe', 'QUALIFIED', '', 'yes']) {
      expect(
        () =>
          recordLabel({
            fixtureSet,
            domain: 'harbourline.example',
            label: bad as 'qualified',
            reasonCodes: [],
            disqualifier: null,
            labelledBy: 'Kushagra',
          }),
        bad,
      ).toThrow();
    }
  });

  it('requires a labeller, because unattributable ground truth cannot be questioned', () => {
    const fixtureSet = freshSet(['harbourline.example']);
    expect(() =>
      recordLabel({
        fixtureSet,
        domain: 'harbourline.example',
        label: 'qualified',
        reasonCodes: [],
        disqualifier: null,
        labelledBy: '',
      }),
    ).toThrow();
  });

  it('refuses a reason code that is not a machine token', () => {
    const fixtureSet = freshSet(['harbourline.example']);
    expect(() =>
      recordLabel({
        fixtureSet,
        domain: 'harbourline.example',
        label: 'rejected',
        reasonCodes: ['Looks like an agency to me'],
        disqualifier: null,
        labelledBy: 'Kushagra',
      }),
    ).toThrow();
  });
});

describe('an existing label is never silently replaced', () => {
  it('refuses a second label and names who made the first', () => {
    const fixtureSet = freshSet(['harbourline.example']);
    const input = {
      fixtureSet,
      domain: 'harbourline.example',
      label: 'qualified' as const,
      reasonCodes: [],
      disqualifier: null,
      labelledBy: 'Kushagra',
      now: NOW,
    };
    recordLabel(input);
    expect(() => recordLabel({ ...input, label: 'rejected' })).toThrow(/already_labelled/);
    expect(() => recordLabel({ ...input, label: 'rejected' })).toThrow(/Kushagra/);
    // And the original stands.
    expect(readLabels(fixtureSet).labels['harbourline.example']?.label).toBe('qualified');
  });

  it('replaces only when asked, and reports what it overruled', () => {
    const fixtureSet = freshSet(['harbourline.example']);
    const input = {
      fixtureSet,
      domain: 'harbourline.example',
      label: 'qualified' as const,
      reasonCodes: [],
      disqualifier: null,
      labelledBy: 'Kushagra',
      now: NOW,
    };
    recordLabel(input);
    const result = recordLabel({ ...input, label: 'rejected', replace: true, labelledBy: 'Ansh' });
    expect(result.replaced?.label).toBe('qualified');
    expect(result.replaced?.labelled_by).toBe('Kushagra');
    expect(result.label.label).toBe('rejected');
    expect(result.label.labelled_by).toBe('Ansh');
  });
});

describe('status counts', () => {
  it('counts fixtures, labels, verdicts and the split', () => {
    const fixtureSet = freshSet(['a.example', 'b.example', 'c.example', 'd.example']);
    assignSplit(fixtureSet, { dev: 3, holdout: 1 });
    writeLabels(fixtureSet, {
      'a.example': aLabel({ label: 'qualified', labelled_by: 'Kushagra' }),
      'b.example': aLabel({ label: 'rejected', labelled_by: 'Kushagra' }),
      'c.example': aLabel({ label: 'rejected', labelled_by: 'Ansh' }),
    });

    const status = labelStatus(fixtureSet);
    expect(status).toMatchObject({
      total: 4,
      labelled: 3,
      unlabelled: 1,
      qualified: 1,
      rejected: 2,
      dev: 3,
      holdout: 1,
      unassigned: 0,
      required: REQUIRED_LABEL_COUNT,
      exitCriterionMet: false,
    });
    expect(status.unlabelledDomains).toStrictEqual(['d.example']);
    expect(status.labellers).toStrictEqual(['Ansh', 'Kushagra']);
  });

  it('never claims the §25 criterion at 59, and claims it at 60', () => {
    const domains = Array.from({ length: 59 }, (_u, index) => `firm-${index}.example`);
    const fixtureSet = freshSet(domains);
    writeLabels(
      fixtureSet,
      Object.fromEntries(domains.map((domain) => [domain, aLabel()])),
    );

    const atFiftyNine = labelStatus(fixtureSet);
    expect(atFiftyNine.labelled).toBe(59);
    expect(atFiftyNine.exitCriterionMet).toBe(false);

    writeFixture(fixtureSet, 'firm-59.example');
    writeLabels(fixtureSet, {
      ...readLabels(fixtureSet).labels,
      'firm-59.example': aLabel(),
    });
    const atSixty = labelStatus(fixtureSet);
    expect(atSixty.labelled).toBe(60);
    expect(atSixty.exitCriterionMet).toBe(true);
  }, 120_000);

  it('finds the next unlabelled fixture, and nothing when all are done', () => {
    const fixtureSet = freshSet(['a.example', 'b.example']);
    expect(nextUnlabelled(fixtureSet)).toBe('a.example');
    writeLabels(fixtureSet, { 'a.example': aLabel() });
    expect(nextUnlabelled(fixtureSet)).toBe('b.example');
    writeLabels(fixtureSet, { 'a.example': aLabel(), 'b.example': aLabel() });
    expect(nextUnlabelled(fixtureSet)).toBeUndefined();
  });
});

describe('the labelling brief', () => {
  it('shows the evidence a human needs, and no model output', () => {
    const fixtureSet = freshSet(['harbourline.example']);
    const brief = labellingBrief(fixtureSet, 'harbourline.example');

    expect(brief).toContain('harbourline.example');
    expect(brief).toContain('(unlabelled)');
    expect(brief).toContain('paid_search_tag present');
    expect(brief).toContain('Harbourline Criminal Defence');
    // No suggestion, no score, no verdict: a labeller nudged by a machine is no
    // longer an independent ground truth.
    expect(brief).not.toMatch(/suggest|recommend|likely|probably|score/i);
  });

  it('says plainly when no scanner looked, rather than implying absence', () => {
    const fixtureSet = scratchSet('label');
    sets.push(fixtureSet);
    writeFixture(fixtureSet, 'unscanned.example', [
      {
        url: 'https://unscanned.example/',
        http_status: 200,
        robots_allowed: true,
        content_hash: 'h',
        bytes: 10,
        text: 'A firm.',
        signals: null,
        page_kind: 'home',
      },
    ]);
    expect(labellingBrief(fixtureSet, 'unscanned.example')).toContain(
      'no scan (unknown, which is not the same as absent)',
    );
  });
});
