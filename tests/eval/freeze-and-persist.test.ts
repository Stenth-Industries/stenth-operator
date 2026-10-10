/**
 * Freezing from a real database, and persisting a run to the real eval tables
 * (SPEC.md §21, §25 Day 5).
 *
 * Against a throwaway PostgreSQL, because the two claims worth testing are
 * claims about SQL: that the freeze only ever reads, and that §4's existing
 * eval contract is enough to hold a run without a migration.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { canonicalJson } from '../../eval/canonical';
import { loadFixture } from '../../eval/corpus';
import { SELECT_SNAPSHOTS, freeze, readDomainsFile, readSnapshots } from '../../eval/freeze';
import { clearPredictors, registerAvailablePredictors } from '../../eval/predictors';
import { clearScript, scriptAnswer, scriptedTestPredictor } from '../../eval/predictors/test-only-scripted';
import { runEval } from '../../eval/run';
import { assignSplit } from '../../eval/split';
import { scanTierASignals } from '../../src/fetch/signals';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../helpers/testDb';
import { SAMPLE_HTML, aLabel, removeSet, scratchSet, writeLabels } from './helpers';

const describeWithDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  console.warn('TEST_ADMIN_DATABASE_URL is not set — skipping the eval freeze suite.');
}

describeWithDb('freezing from the database (§21)', () => {
  let db: TestDatabase;
  let app: Pool;
  const sets: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    app = db.poolAs('operator_app');
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  afterEach(async () => {
    while (sets.length > 0) {
      removeSet(sets.pop() as string);
    }
    await db.adminPool.query('TRUNCATE web_snapshots, companies CASCADE');
    await db.adminPool.query('TRUNCATE eval_results, eval_runs, eval_fixtures CASCADE');
  });

  function freshSet(): string {
    const fixtureSet = scratchSet('freeze');
    sets.push(fixtureSet);
    return fixtureSet;
  }

  async function seedCompany(
    domain: string,
    pages: readonly { url: string; text?: string | null; status?: number | null; robots?: boolean }[],
  ): Promise<string> {
    const { rows } = await db.adminPool.query<{ id: string }>(
      `INSERT INTO companies (canonical_domain) VALUES ($1) RETURNING id`,
      [domain],
    );
    const companyId = rows[0]!.id;
    for (const page of pages) {
      await db.adminPool.query(
        `INSERT INTO web_snapshots
           (company_id, url, http_status, content_hash, text, bytes, robots_allowed,
            trace_id, signals)
         VALUES ($1, $2, $3, $4, $5, 2048, $6, $7, $8::jsonb)`,
        [
          companyId,
          page.url,
          page.status === undefined ? 200 : page.status,
          `hash-${page.url}`,
          page.text === undefined ? 'The firm, in Sydney. '.repeat(40) : page.text,
          page.robots ?? true,
          '01JA2BCDEFGHJKMNPQRSTVWXYZ',
          JSON.stringify({ ...scanTierASignals(SAMPLE_HTML) }),
        ],
      );
    }
    return companyId;
  }

  it('freezes every stored page for one firm, deterministically', async () => {
    await seedCompany('harbourline.example', [
      { url: 'https://harbourline.example/' },
      { url: 'https://harbourline.example/about' },
    ]);
    const fixtureSet = freshSet();

    const frozen = await freeze(app, {
      fixtureSet,
      domains: ['harbourline.example'],
      replace: false,
    });
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ domain: 'harbourline.example', pages: 2, action: 'written' });

    const loaded = loadFixture(fixtureSet, 'harbourline.example');
    expect(loaded.fixture.pages.map((page) => page.url)).toStrictEqual([
      'https://harbourline.example/',
      'https://harbourline.example/about',
    ]);
    expect(loaded.fixture.pages[0]?.signals?.paid_search_tag).toBe('present');
    expect(loaded.path).toBe(
      `eval/fixtures/${fixtureSet}/companies/harbourline.example.json`,
    );
  });

  it('produces identical bytes from identical source material', async () => {
    await seedCompany('harbourline.example', [{ url: 'https://harbourline.example/' }]);
    const a = freshSet();
    const b = freshSet();

    const [first] = await freeze(app, { fixtureSet: a, domains: ['harbourline.example'], replace: false });
    const [second] = await freeze(app, { fixtureSet: b, domains: ['harbourline.example'], replace: false });

    // The pages and the digest are byte-identical; only the set-derived id and
    // the set name differ, which is what they are for.
    expect(canonicalJson(first?.fixture?.pages)).toBe(canonicalJson(second?.fixture?.pages));
    expect(first?.fixture?.content_digest).toBe(second?.fixture?.content_digest);
    expect(first?.fixture?.fixture_id).not.toBe(second?.fixture?.fixture_id);
  });

  it('refuses to overwrite an existing fixture unless told to', async () => {
    await seedCompany('harbourline.example', [{ url: 'https://harbourline.example/' }]);
    const fixtureSet = freshSet();

    await freeze(app, { fixtureSet, domains: ['harbourline.example'], replace: false });
    const again = await freeze(app, { fixtureSet, domains: ['harbourline.example'], replace: false });
    expect(again[0]?.action).toBe('skipped_exists');
    expect(again[0]?.pages).toBe(0);

    const replaced = await freeze(app, {
      fixtureSet,
      domains: ['harbourline.example'],
      replace: true,
    });
    expect(replaced[0]?.action).toBe('replaced');
  });

  it('refuses to freeze without an explicit selection', async () => {
    const fixtureSet = freshSet();
    await expect(freeze(app, { fixtureSet, domains: [], replace: false })).rejects.toThrow(
      /no_selection/,
    );
  });

  it('refuses a duplicated domain in one selection', async () => {
    await seedCompany('harbourline.example', [{ url: 'https://harbourline.example/' }]);
    const fixtureSet = freshSet();
    await expect(
      freeze(app, {
        fixtureSet,
        domains: ['harbourline.example', 'harbourline.example'],
        replace: false,
      }),
    ).rejects.toThrow(/duplicate_domain/);
  });

  it('refuses a firm with no stored evidence rather than writing an empty fixture', async () => {
    const fixtureSet = freshSet();
    await expect(
      freeze(app, { fixtureSet, domains: ['never-fetched.example'], replace: false }),
    ).rejects.toThrow(/no_evidence/);
  });

  it('keeps a text-free row as evidence of a refusal, with text null', async () => {
    await seedCompany('refusing.example', [
      { url: 'https://refusing.example/', text: null, status: 403 },
      { url: 'https://refusing.example/about', text: null, status: null, robots: false },
    ]);
    const fixtureSet = freshSet();
    const [frozen] = await freeze(app, {
      fixtureSet,
      domains: ['refusing.example'],
      replace: false,
    });

    expect(frozen?.pages).toBe(2);
    const pages = frozen?.fixture?.pages ?? [];
    expect(pages[0]?.http_status).toBe(403);
    expect(pages[0]?.text).toBeNull();
    expect(pages[1]?.robots_allowed).toBe(false);
  });

  it('is read-only: the only statement is a SELECT, and nothing changed', async () => {
    await seedCompany('harbourline.example', [{ url: 'https://harbourline.example/' }]);
    const fixtureSet = freshSet();

    // The SQL itself, asserted as text. A write would have to appear here.
    expect(SELECT_SNAPSHOTS.trim().startsWith('SELECT')).toBe(true);
    for (const forbidden of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ALTER', 'DROP']) {
      expect(SELECT_SNAPSHOTS.toUpperCase(), forbidden).not.toContain(forbidden);
    }

    const before = await db.adminPool.query<{ snapshots: string; companies: string }>(
      `SELECT (SELECT count(*) FROM web_snapshots)::text AS snapshots,
              (SELECT count(*) FROM companies)::text AS companies`,
    );
    await freeze(app, { fixtureSet, domains: ['harbourline.example'], replace: false });
    const after = await db.adminPool.query<{ snapshots: string; companies: string }>(
      `SELECT (SELECT count(*) FROM web_snapshots)::text AS snapshots,
              (SELECT count(*) FROM companies)::text AS companies`,
    );
    expect(after.rows[0]).toStrictEqual(before.rows[0]);
  });

  it('works through the read-only role, which is the §17 way to mean it', async () => {
    await seedCompany('harbourline.example', [{ url: 'https://harbourline.example/' }]);
    const fixtureSet = freshSet();
    const readOnly = db.poolAs('operator_ro');
    const frozen = await freeze(readOnly, {
      fixtureSet,
      domains: ['harbourline.example'],
      replace: false,
    });
    expect(frozen[0]?.action).toBe('written');
  });

  it('takes one row per URL, the most recently fetched', async () => {
    const companyId = await seedCompany('versions.example', [
      { url: 'https://versions.example/', text: 'the older text '.repeat(80) },
    ]);
    await db.adminPool.query(
      `INSERT INTO web_snapshots
         (company_id, url, http_status, content_hash, text, bytes, robots_allowed, trace_id, fetched_at)
       VALUES ($1, 'https://versions.example/', 200, 'hash-newer', $2, 2048, true, 'T', now() + interval '1 hour')`,
      [companyId, 'the newer text '.repeat(80)],
    );

    const rows = await readSnapshots(app, 'versions.example');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_hash).toBe('hash-newer');
  });

  it('reads a domains file, ignoring comments and blanks', () => {
    const { writeFileSync, mkdtempSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'stenth-domains-'));
    const path = join(dir, 'domains.txt');
    writeFileSync(path, '# a comment\n\nfirm-a.example\nfirm-b.example # inline\n   \n', 'utf8');
    expect(readDomainsFile(path)).toStrictEqual(['firm-a.example', 'firm-b.example']);
  });

  // ------------------------------------------------------------ persistence
  describe('persisting a run to §4’s existing eval tables', () => {
    beforeAll(() => {
      clearPredictors();
      registerAvailablePredictors();
    });

    afterEach(() => {
      clearScript();
    });

    async function seedAndFreeze(fixtureSet: string, domains: readonly string[]): Promise<void> {
      for (const domain of domains) {
        await seedCompany(domain, [{ url: `https://${domain}/` }]);
      }
      await freeze(app, { fixtureSet, domains, replace: false });
    }

    it('writes eval_fixtures, eval_runs and eval_results with no migration', async () => {
      const fixtureSet = freshSet();
      await seedAndFreeze(fixtureSet, ['a-firm.example', 'b-firm.example']);
      assignSplit(fixtureSet, { dev: 2, holdout: 0 });
      writeLabels(fixtureSet, {
        'a-firm.example': aLabel({ label: 'qualified', reason_codes: ['small_firm'] }),
        'b-firm.example': aLabel({ label: 'rejected', disqualifier: 'marketing agency' }),
      });
      scriptAnswer('a-firm.example', { verdict: 'qualified', score: 82, reasons: ['scripted'] });
      scriptAnswer('b-firm.example', { verdict: 'uncertain', score: 60 });

      const result = await runEval({
        fixtureSet,
        split: 'dev',
        predictor: scriptedTestPredictor,
        rubricVersion: 'none-day6-owns-this',
        promptVersion: 'extract-v1',
        allowHoldout: false,
        allowBillable: false,
        now: new Date('2026-10-10T04:05:06.000Z'),
        pool: app,
        writeReport: false,
      });

      expect(result.runId).toBeDefined();

      const fixtures = await app.query<{
        domain: string;
        split: string;
        label: string;
        label_reason_codes: string[];
        disqualifier: string | null;
        labelled_by: string;
        snapshot_path: string;
      }>(
        `SELECT domain::text AS domain, split::text AS split, label::text AS label,
                label_reason_codes, disqualifier, labelled_by, snapshot_path
           FROM eval_fixtures ORDER BY domain`,
      );
      expect(fixtures.rows).toHaveLength(2);
      expect(fixtures.rows[0]).toMatchObject({
        domain: 'a-firm.example',
        split: 'dev',
        label: 'qualified',
        label_reason_codes: ['small_firm'],
        labelled_by: 'Kushagra',
        snapshot_path: `eval/fixtures/${fixtureSet}/companies/a-firm.example.json`,
      });
      expect(fixtures.rows[1]?.disqualifier).toBe('marketing agency');

      const runs = await app.query<{
        split: string;
        rubric_version: string;
        prompt_version: string;
        model: string;
        cost_usd: string;
        metrics: Record<string, unknown>;
      }>(
        `SELECT split::text AS split, rubric_version, prompt_version, model, cost_usd, metrics
           FROM eval_runs`,
      );
      expect(runs.rows[0]).toMatchObject({
        split: 'dev',
        rubric_version: 'none-day6-owns-this',
        prompt_version: 'extract-v1',
        model: 'test-only-scripted',
      });
      expect(Number(runs.rows[0]?.cost_usd)).toBe(0);
      expect(runs.rows[0]?.metrics).toMatchObject({ total: 2, correct: 1, predictor_id: 'test-only-scripted' });

      const results = await app.query<{
        predicted_verdict: string;
        predicted_score: number | null;
        correct: boolean;
        reasons: unknown;
        domain: string;
      }>(
        `SELECT r.predicted_verdict::text AS predicted_verdict, r.predicted_score, r.correct,
                r.reasons, f.domain::text AS domain
           FROM eval_results r JOIN eval_fixtures f ON f.id = r.fixture_id
          ORDER BY f.domain`,
      );
      expect(results.rows).toHaveLength(2);
      expect(results.rows[0]).toMatchObject({
        domain: 'a-firm.example',
        predicted_verdict: 'qualified',
        predicted_score: 82,
        correct: true,
        reasons: ['scripted'],
      });
      // `uncertain` is a legitimate §10 stage 7 verdict and matches no label.
      expect(results.rows[1]).toMatchObject({
        predicted_verdict: 'uncertain',
        correct: false,
      });
    });

    it('is idempotent on the fixture rows and additive on the runs', async () => {
      const fixtureSet = freshSet();
      await seedAndFreeze(fixtureSet, ['a-firm.example']);
      assignSplit(fixtureSet, { dev: 1, holdout: 0 });
      writeLabels(fixtureSet, { 'a-firm.example': aLabel({ label: 'qualified' }) });
      scriptAnswer('a-firm.example', { verdict: 'qualified' });

      const options = {
        fixtureSet,
        split: 'dev' as const,
        predictor: scriptedTestPredictor,
        rubricVersion: 'none-day6-owns-this',
        promptVersion: 'extract-v1',
        allowHoldout: false,
        allowBillable: false,
        pool: app,
        writeReport: false as const,
      };

      const first = await runEval(options);
      const second = await runEval(options);
      expect(second.runId).not.toBe(first.runId);

      // §4's unique (fixture_set, domain) means the upsert keeps one row.
      const fixtures = await app.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM eval_fixtures',
      );
      expect(fixtures.rows[0]?.count).toBe('1');

      // Two runs, two result rows, and the unique (eval_run_id, fixture_id)
      // holds within each.
      const runs = await app.query<{ count: string }>('SELECT count(*)::text AS count FROM eval_runs');
      expect(runs.rows[0]?.count).toBe('2');
      const results = await app.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM eval_results',
      );
      expect(results.rows[0]?.count).toBe('2');
    });

    it('rolls the whole run back if any part of it fails', async () => {
      const fixtureSet = freshSet();
      await seedAndFreeze(fixtureSet, ['a-firm.example']);
      assignSplit(fixtureSet, { dev: 1, holdout: 0 });
      writeLabels(fixtureSet, { 'a-firm.example': aLabel() });
      scriptAnswer('a-firm.example', { verdict: 'qualified' });

      // A rubric version longer than the column will take: the eval_runs insert
      // fails after the eval_fixtures upsert has already run.
      await expect(
        runEval({
          fixtureSet,
          split: 'dev',
          predictor: scriptedTestPredictor,
          rubricVersion: 'v'.repeat(100),
          promptVersion: 'extract-v1',
          allowHoldout: false,
          allowBillable: false,
          pool: {
            connect: async () => {
              const client = await app.connect();
              const original = client.query.bind(client);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (client as any).query = (...args: unknown[]) => {
                const sql = typeof args[0] === 'string' ? args[0] : '';
                if (sql.includes('INSERT INTO eval_runs')) {
                  return Promise.reject(new Error('simulated failure'));
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (original as any)(...args);
              };
              return client;
            },
          } as unknown as Pool,
          writeReport: false,
        }),
      ).rejects.toThrow(/simulated failure/);

      // Nothing committed: not the run, and not the fixture rows either.
      for (const table of ['eval_fixtures', 'eval_runs', 'eval_results']) {
        const { rows } = await app.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        expect(rows[0]?.count, table).toBe('0');
      }
    });
  });
});
