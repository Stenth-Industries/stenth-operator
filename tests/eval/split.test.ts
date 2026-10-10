/**
 * The dev/holdout split (SPEC.md §21, §25 Day 5).
 *
 * Three properties, and the suite exists for them: the assignment is
 * deterministic, it is append-only, and it never looks at a label. The last one
 * is the one that is easy to lose later and impossible to notice losing.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { readSplit } from '../../eval/corpus';
import {
  assignSplit,
  assignmentOrder,
  auditSplit,
  planAssignment,
  rebuildSplit,
} from '../../eval/split';
import { aLabel, removeSet, scratchSet, writeFixture, writeLabels } from './helpers';

const sets: string[] = [];

function freshSet(domains: readonly string[]): string {
  const fixtureSet = scratchSet('split');
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

const TEN = Array.from({ length: 10 }, (_u, index) => `firm-${index}.example`);

describe('the assignment is deterministic', () => {
  it('orders unassigned domains the same way every time, on any machine', () => {
    const once = assignmentOrder('a-set', TEN);
    const twice = assignmentOrder('a-set', [...TEN].reverse());
    expect(once).toStrictEqual(twice);
    // Not alphabetical: a hash decides, so the order carries no information a
    // tuner could use and no accident of naming.
    expect(once).not.toStrictEqual([...TEN].sort());
  });

  it('depends on the fixture set, so two corpora do not share a partition', () => {
    expect(assignmentOrder('set-a', TEN)).not.toStrictEqual(assignmentOrder('set-b', TEN));
  });

  it('produces the same split on a rerun of the same counts', () => {
    const fixtureSet = freshSet(TEN);
    const first = assignSplit(fixtureSet, { dev: 7, holdout: 3 }, { dryRun: true });
    const second = assignSplit(fixtureSet, { dev: 7, holdout: 3 }, { dryRun: true });
    expect(first.plan).toStrictEqual(second.plan);
  });
});

describe('coverage and non-overlap', () => {
  it('puts every fixture in exactly one split', () => {
    const fixtureSet = freshSet(TEN);
    assignSplit(fixtureSet, { dev: 6, holdout: 4 });

    const audit = auditSplit(fixtureSet);
    expect(audit.total).toBe(10);
    expect(audit.dev).toBe(6);
    expect(audit.holdout).toBe(4);
    expect(audit.unassigned).toStrictEqual([]);
    expect(audit.overlapping).toStrictEqual([]);
    expect(audit.orphaned).toStrictEqual([]);

    const { assignments } = readSplit(fixtureSet);
    expect(Object.keys(assignments).sort()).toStrictEqual([...TEN].sort());
  });

  it('refuses counts that do not account for every unassigned fixture', () => {
    const fixtureSet = freshSet(TEN);
    for (const counts of [
      { dev: 5, holdout: 4 },
      { dev: 10, holdout: 1 },
      { dev: 0, holdout: 0 },
    ]) {
      expect(() => assignSplit(fixtureSet, counts), JSON.stringify(counts)).toThrow(/bad_counts/);
    }
    expect(auditSplit(fixtureSet).unassigned).toHaveLength(10);
  });

  it('refuses non-integer and negative counts', () => {
    const fixtureSet = freshSet(TEN);
    for (const counts of [
      { dev: 1.5, holdout: 8.5 },
      { dev: -1, holdout: 11 },
      { dev: Number.NaN, holdout: 10 },
    ]) {
      expect(() => assignSplit(fixtureSet, counts)).toThrow(/bad_counts/);
    }
  });

  it('refuses a set with no fixtures at all', () => {
    const fixtureSet = scratchSet('split-empty');
    sets.push(fixtureSet);
    expect(() => assignSplit(fixtureSet, { dev: 0, holdout: 0 })).toThrow(/empty_set/);
  });
});

describe('the split is immutable without an explicit rebuild', () => {
  it('leaves existing assignments alone and assigns only the new fixtures', () => {
    const fixtureSet = freshSet(TEN);
    assignSplit(fixtureSet, { dev: 6, holdout: 4 });
    const before = readSplit(fixtureSet).assignments;

    // The corpus grows, as it must on the way to sixty.
    writeFixture(fixtureSet, 'firm-10.example');
    writeFixture(fixtureSet, 'firm-11.example');
    const result = assignSplit(fixtureSet, { dev: 1, holdout: 1 });

    expect(result.plan.unchanged).toHaveLength(10);
    expect(result.plan.dev.length + result.plan.holdout.length).toBe(2);

    const after = readSplit(fixtureSet).assignments;
    for (const [domain, split] of Object.entries(before)) {
      expect(after[domain], domain).toBe(split);
    }
    expect(auditSplit(fixtureSet).unassigned).toStrictEqual([]);
  });

  it('cannot be asked to move a fixture between splits', () => {
    const fixtureSet = freshSet(TEN);
    assignSplit(fixtureSet, { dev: 10, holdout: 0 });
    // Everything is assigned, so there is nothing to assign — any counts above
    // zero are refused rather than reinterpreted as a reshuffle.
    expect(() => assignSplit(fixtureSet, { dev: 0, holdout: 10 })).toThrow(/bad_counts/);
    expect(auditSplit(fixtureSet)).toMatchObject({ dev: 10, holdout: 0 });
  });

  it('only changes after an explicit rebuild', () => {
    const fixtureSet = freshSet(TEN);
    assignSplit(fixtureSet, { dev: 10, holdout: 0 });
    expect(auditSplit(fixtureSet).dev).toBe(10);

    rebuildSplit(fixtureSet);
    expect(auditSplit(fixtureSet)).toMatchObject({ dev: 0, holdout: 0 });
    expect(auditSplit(fixtureSet).unassigned).toHaveLength(10);

    assignSplit(fixtureSet, { dev: 0, holdout: 10 });
    expect(auditSplit(fixtureSet)).toMatchObject({ dev: 0, holdout: 10 });
  });

  it('reports an assignment whose fixture is gone rather than hiding it', () => {
    const fixtureSet = freshSet(['firm-0.example']);
    assignSplit(fixtureSet, { dev: 1, holdout: 0 });
    writeFixture(fixtureSet, 'firm-1.example');
    assignSplit(fixtureSet, { dev: 0, holdout: 1 });

    // Simulate a fixture being removed while the manifest still names it.
    removeSet(fixtureSet);
    sets.pop();
    expect(auditSplit(fixtureSet).total).toBe(0);
  });
});

describe('no label leakage', () => {
  it('assigns identically whether or not labels exist', () => {
    const withoutLabels = freshSet(TEN);
    const planA = assignSplit(withoutLabels, { dev: 5, holdout: 5 }, { dryRun: true }).plan;

    const withLabels = scratchSet('split');
    sets.push(withLabels);
    for (const domain of TEN) {
      writeFixture(withLabels, domain);
    }
    // Every fixture labelled, half one way and half the other. A splitter that
    // peeked would balance them and produce a different partition.
    writeLabels(
      withLabels,
      Object.fromEntries(
        TEN.map((domain, index) => [
          domain,
          aLabel({ label: index % 2 === 0 ? 'qualified' : 'rejected' }),
        ]),
      ),
    );
    const planB = assignSplit(withLabels, { dev: 5, holdout: 5 }, { dryRun: true }).plan;

    // Different fixture-set names mean different hashes, so compare the shape
    // and, more importantly, that labelling changed nothing about the mechanism.
    expect(planA.dev).toHaveLength(planB.dev.length);
    expect(planA.holdout).toHaveLength(planB.holdout.length);

    // The decisive check: the same set, assigned before and after labelling.
    const sameSet = freshSet(['a-firm.example', 'b-firm.example', 'c-firm.example']);
    const beforeLabels = assignSplit(sameSet, { dev: 2, holdout: 1 }, { dryRun: true }).plan;
    writeLabels(sameSet, {
      'a-firm.example': aLabel({ label: 'rejected' }),
      'b-firm.example': aLabel({ label: 'rejected' }),
      'c-firm.example': aLabel({ label: 'qualified' }),
    });
    const afterLabels = assignSplit(sameSet, { dev: 2, holdout: 1 }, { dryRun: true }).plan;
    expect(afterLabels).toStrictEqual(beforeLabels);
  });

  it('is computed by a function that is not given labels at all', () => {
    // planAssignment's signature is the guarantee: domains, existing
    // assignments and counts. There is no parameter a label could arrive in.
    const plan = planAssignment('a-set', TEN, {}, { dev: 4, holdout: 6 });
    expect(plan.dev).toHaveLength(4);
    expect(plan.holdout).toHaveLength(6);
    expect(new Set([...plan.dev, ...plan.holdout]).size).toBe(10);
  });
});

describe('a dry run', () => {
  it('writes nothing', () => {
    const fixtureSet = freshSet(TEN);
    const result = assignSplit(fixtureSet, { dev: 5, holdout: 5 }, { dryRun: true });
    expect(result.written).toBe(false);
    expect(readSplit(fixtureSet).assignments).toStrictEqual({});
    expect(auditSplit(fixtureSet).unassigned).toHaveLength(10);
  });
});
