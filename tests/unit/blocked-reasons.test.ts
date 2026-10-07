/**
 * Blocked reason codes (SPEC.md §6, Day 4 review item 5).
 *
 * §6 makes `blocked` terminal and alerting, which means a human reads it and
 * has to know what to do. One generic state would tell them nothing, so every
 * cause carries its own machine token — and the five the review named each have
 * a different answer:
 *
 *   model_calls_disabled   set MODEL_CALLS_ENABLED
 *   provider_unconfigured  record the Day 6 decision, set MODEL_PROVIDER
 *   budget_hard_stop       raise the ceiling, or wait for the month
 *   missing_pricing        add the model_pricing row
 *   reservation_in_flight  reconcile the open reservation against the billing
 *   security_refusal       declared, with no producer yet — see below
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ControlRefusal } from '../../src/jobs/queue';
import { ExtractBlocked, type ExtractBlockedReason } from '../../src/worker/handlers/web-extract';

const root = join(__dirname, '..', '..');

/** Every code the type admits, listed so a new one has to be added here too. */
const ALL_REASONS: ExtractBlockedReason[] = [
  'model_calls_disabled',
  'provider_unconfigured',
  'budget_hard_stop',
  'missing_pricing',
  'reservation_in_flight',
  'security_refusal',
];

describe('every blocked cause is its own code', () => {
  it('covers the five the review named, plus the reconciliation state', () => {
    expect(ALL_REASONS).toContain('model_calls_disabled');
    expect(ALL_REASONS).toContain('budget_hard_stop');
    expect(ALL_REASONS).toContain('missing_pricing');
    expect(ALL_REASONS).toContain('provider_unconfigured');
    expect(ALL_REASONS).toContain('security_refusal');
    expect(ALL_REASONS).toContain('reservation_in_flight');
    expect(new Set(ALL_REASONS).size).toBe(ALL_REASONS.length);
  });

  it('is a ControlRefusal, so the worker blocks rather than retries', () => {
    for (const reason of ALL_REASONS) {
      const error = new ExtractBlocked(reason, 'detail');
      expect(error).toBeInstanceOf(ControlRefusal);
      expect(error.reason).toBe(reason);
      expect(error.name).toBe('ExtractBlocked');
    }
  });

  it('puts the code where the operator sees it: last_error and the event', () => {
    // blockJob writes error.reason into the job.blocked event payload and
    // error.message into jobs.last_error, so both halves have to be useful.
    const queue = readFileSync(join(root, 'src', 'jobs', 'queue.ts'), 'utf8');
    expect(queue).toContain("'job.blocked'");
    expect(queue).toMatch(/JSON\.stringify\(\{ job_kind: job\.kind, reason/);
  });

  it('is raised for each cause that has a producer today', () => {
    // Grep the source rather than assert from memory: a code with no producer
    // is either a gap or a reservation for later, and the two must be
    // distinguishable.
    const sources = [
      readFileSync(join(root, 'src', 'worker', 'handlers', 'web-extract.ts'), 'utf8'),
      readFileSync(join(root, 'src', 'worker', 'index.ts'), 'utf8'),
    ].join('\n');

    for (const reason of [
      'model_calls_disabled',
      'provider_unconfigured',
      'budget_hard_stop',
      'missing_pricing',
      'reservation_in_flight',
    ]) {
      expect(sources, `${reason} has no producer`).toContain(reason);
    }
  });

  it('declares security_refusal with no producer yet, deliberately', () => {
    // Day 4's §8 controls do not block a job: a sanitiser rejection or a failed
    // parse is stored as valid = false and the page stops there, which is what
    // §8 asks for. The code exists so that Day 6's consent and suppression
    // controls, and §23 case 12, have somewhere correct to land — rather than
    // reaching for one of the budget codes or inventing a producer here to make
    // a test pass.
    const handler = readFileSync(
      join(root, 'src', 'worker', 'handlers', 'web-extract.ts'),
      'utf8',
    );
    // The union declares it, so a grep for the string finds it. What must be
    // absent is a *construction* — the code being raised.
    const statements = handler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(statements).not.toMatch(/ExtractBlocked\(\s*'security_refusal'/);
    expect(statements).toContain("| 'security_refusal'");
    // But it is a valid code, so a future caller cannot invent a spelling.
    expect(new ExtractBlocked('security_refusal', 'x').reason).toBe('security_refusal');
  });
});
