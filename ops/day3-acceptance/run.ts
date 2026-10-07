/**
 * Day 3 acceptance run: 16 real law-firm sites through the real pipeline.
 *
 * SPEC.md §25 Day 3 exits on "20 real law-firm sites fetched and stored". This
 * script is the repeatable way to get there, and it is deliberately boring: it
 * inserts companies, enqueues web.fetch jobs through the existing enqueue path,
 * and then reads back what happened. It opens no socket to the public internet
 * — the running worker claims the jobs and the fetcher service does the
 * fetching, exactly as production will.
 *
 * What it will not do:
 *
 *   * No UPDATE and no DELETE, anywhere. Two INSERTs are its entire write
 *     surface: companies (ON CONFLICT DO NOTHING) and jobs (ON CONFLICT DO
 *     NOTHING, through src/jobs/enqueue.ts). Nothing already in the database is
 *     modified, so a second run is a no-op rather than a second set of rows.
 *   * No robots.txt or SSRF decision of its own. Those live in the fetcher and
 *     are not reachable from here, which is the point of §8.
 *   * No bypass of a refusal. A 403, a Disallow or a guard refusal is the
 *     result, and the result is reported, never retried around.
 *
 * Modes:
 *
 *   plan      (default) prints exactly what enqueueing would do. Writes nothing.
 *   enqueue   does it. Requires --yes.
 *   report    read-only; prints the acceptance table and the 2xx count.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { z } from 'zod';

import { createPool } from '../../src/db/client';
import { enqueue } from '../../src/jobs/enqueue';
import { dedupeKey } from '../../src/jobs/kinds';
import { newTraceId } from '../../src/obs/trace';

/**
 * The floor for "usable extracted content".
 *
 * A real law-firm homepage extracts to thousands of characters. An error page,
 * a parked domain or a JavaScript-only shell extracts to a few dozen. 500 is
 * comfortably between the two, and stating it as a constant is what makes the
 * acceptance count reproducible rather than a judgement call.
 */
const USABLE_TEXT_CHARS = 500;

/** Lowest priority: these jobs never jump ahead of real pipeline work (§6 claim order). */
const ACCEPTANCE_PRIORITY = -10;

const siteSchema = z.object({
  canonical_domain: z
    .string()
    .min(4)
    .regex(/^[a-z0-9.-]+$/, 'a registrable domain, lowercase, no scheme and no path'),
  legal_name: z.string().min(2),
  state: z.string().min(2).max(3),
  focus: z.string().min(2),
  name_evidence: z.enum(['stated', 'domain']),
  evidence_url: z.string().url(),
  why_reserve: z.string().optional(),
});

const seedSchema = z.object({
  note: z.array(z.string()),
  sites: z.array(siteSchema).min(1),
  reserve: z.array(siteSchema),
});

type Site = z.infer<typeof siteSchema>;

interface Options {
  readonly mode: 'plan' | 'enqueue' | 'report';
  readonly only: readonly string[];
  readonly includeReserve: boolean;
  readonly staggerSeconds: number;
  readonly maxAttempts: number;
  readonly occurrence: string;
  readonly confirmed: boolean;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  const flag = (name: string): string | undefined => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const mode = positional[0] ?? 'plan';
  if (mode !== 'plan' && mode !== 'enqueue' && mode !== 'report') {
    throw new Error(`unknown mode "${mode}": expected plan, enqueue or report`);
  }

  const stagger = Number(flag('stagger-seconds') ?? '30');
  const attempts = Number(flag('max-attempts') ?? '1');
  if (!Number.isInteger(stagger) || stagger < 0 || stagger > 3600) {
    throw new Error('--stagger-seconds must be an integer between 0 and 3600');
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
    throw new Error('--max-attempts must be 1, 2 or 3 (§6 gives web.fetch 3)');
  }

  const occurrence = flag('occurrence') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrence)) {
    throw new Error('--occurrence must be YYYY-MM-DD');
  }

  return {
    mode,
    only: (flag('only') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== ''),
    includeReserve: argv.includes('--include-reserve'),
    staggerSeconds: stagger,
    maxAttempts: attempts,
    occurrence,
    confirmed: argv.includes('--yes'),
    json: argv.includes('--json'),
  };
}

function loadSites(options: Options): Site[] {
  const raw = readFileSync(join(__dirname, 'sites.json'), 'utf8');
  const seed = seedSchema.parse(JSON.parse(raw));
  const pool = options.includeReserve ? [...seed.sites, ...seed.reserve] : seed.sites;

  const selected =
    options.only.length === 0
      ? pool
      : pool.filter((site) => options.only.includes(site.canonical_domain));

  if (options.only.length > 0) {
    for (const wanted of options.only) {
      if (!selected.some((site) => site.canonical_domain === wanted)) {
        throw new Error(`--only names "${wanted}", which is not in sites.json`);
      }
    }
  }

  const domains = new Set(selected.map((site) => site.canonical_domain));
  if (domains.size !== selected.length) {
    throw new Error('sites.json contains a duplicate canonical_domain');
  }
  return selected;
}

/** The one URL per firm: its homepage. */
function homepageOf(site: Site): string {
  return `https://${site.canonical_domain}/`;
}

/**
 * The dedupe key for this run.
 *
 * §7's web.fetch key is per-occurrence — fetch:<company>:<urlhash>:<date> — so
 * re-running on the same day is idempotent (requirement 7) while a re-run
 * tomorrow is a genuinely new occurrence. The url hash is sha256 of the URL
 * list, truncated: the key has to be bounded and deterministic, and the list is
 * what identifies the work.
 */
function keyFor(companyId: string, urls: readonly string[], occurrence: string): string {
  const urlHash = createHash('sha256').update(urls.join('\n'), 'utf8').digest('hex').slice(0, 16);
  return dedupeKey.webFetch(companyId, urlHash, occurrence);
}

interface CompanyRow {
  readonly id: string;
  readonly legal_name: string | null;
  readonly created: boolean;
}

/**
 * Registers the firm, or finds the row that is already there.
 *
 * ON CONFLICT DO NOTHING rather than DO UPDATE: if this domain is already a
 * company — from an earlier acceptance run, or from real pipeline work — its
 * row is left exactly as it is. The script's job is to add what is missing, not
 * to restate what it thinks the firm is called (requirements 7 and 8).
 */
async function registerCompany(pool: Pool, site: Site): Promise<CompanyRow> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO companies (canonical_domain, legal_name, state)
     VALUES ($1, $2, $3)
     ON CONFLICT (canonical_domain) DO NOTHING
     RETURNING id`,
    [site.canonical_domain, site.legal_name, site.state],
  );

  if (inserted.rowCount === 1) {
    return { id: inserted.rows[0]!.id, legal_name: site.legal_name, created: true };
  }

  const existing = await pool.query<{ id: string; legal_name: string | null }>(
    'SELECT id, legal_name FROM companies WHERE canonical_domain = $1',
    [site.canonical_domain],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(`companies row for ${site.canonical_domain} vanished between statements`);
  }
  return { id: row.id, legal_name: row.legal_name, created: false };
}

async function runPlan(pool: Pool, sites: readonly Site[], options: Options): Promise<void> {
  console.log(`plan: ${sites.length} sites, occurrence ${options.occurrence}`);
  console.log(
    `       one homepage per firm, ${options.staggerSeconds}s apart, ` +
      `max_attempts ${options.maxAttempts}, priority ${ACCEPTANCE_PRIORITY}`,
  );
  console.log(
    `       outbound requests: ${sites.length} robots.txt + ${sites.length} pages ` +
      `= ${sites.length * 2}, one host at a time, >=2s between requests to a host`,
  );
  console.log('');

  for (const [index, site] of sites.entries()) {
    // Read-only: resolves the company if it exists, invents no row.
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM companies WHERE canonical_domain = $1',
      [site.canonical_domain],
    );
    const companyId = existing.rows[0]?.id;
    const urls = [homepageOf(site)];
    const key =
      companyId === undefined
        ? 'fetch:<new company id>:<url hash>:' + options.occurrence
        : keyFor(companyId, urls, options.occurrence);

    const already =
      companyId === undefined
        ? { rowCount: 0 }
        : await pool.query('SELECT 1 FROM jobs WHERE dedupe_key = $1', [key]);

    console.log(
      [
        String(index + 1).padStart(2),
        site.canonical_domain.padEnd(36),
        companyId === undefined ? 'company: new    ' : 'company: existing',
        (already.rowCount ?? 0) > 0 ? 'job: already queued' : 'job: would enqueue',
        `+${index * options.staggerSeconds}s`,
      ].join('  '),
    );
    console.log(`    ${urls[0]}   key ${key}`);
  }

  console.log('');
  console.log('Nothing was written. Re-run with: enqueue --yes');
}

async function runEnqueue(pool: Pool, sites: readonly Site[], options: Options): Promise<number> {
  if (!options.confirmed) {
    throw new Error('enqueue writes to the database; pass --yes to confirm');
  }

  const startedAt = Date.now();
  let enqueued = 0;
  let duplicate = 0;
  let created = 0;

  for (const [index, site] of sites.entries()) {
    const company = await registerCompany(pool, site);
    if (company.created) {
      created += 1;
    }

    const urls = [homepageOf(site)];
    const key = keyFor(company.id, urls, options.occurrence);
    const traceId = newTraceId();
    const runAfter = new Date(startedAt + index * options.staggerSeconds * 1000);

    const result = await enqueue(pool, {
      kind: 'web.fetch',
      dedupeKey: key,
      traceId,
      payload: { company_id: company.id, urls },
      priority: ACCEPTANCE_PRIORITY,
      runAfter,
      maxAttempts: options.maxAttempts,
    });

    if (result.inserted) {
      enqueued += 1;
    } else {
      duplicate += 1;
    }

    console.log(
      [
        String(index + 1).padStart(2),
        site.canonical_domain.padEnd(36),
        company.created ? 'company created ' : 'company existing',
        result.inserted ? 'job enqueued  ' : 'job deduplicated',
        `runs at ${runAfter.toISOString()}`,
        `trace ${traceId}`,
      ].join('  '),
    );
  }

  console.log('');
  console.log(
    `companies created ${created}, jobs enqueued ${enqueued}, ` +
      `already present ${duplicate} (idempotent, not an error)`,
  );
  console.log(
    `last job becomes due at ` +
      `${new Date(startedAt + (sites.length - 1) * options.staggerSeconds * 1000).toISOString()}`,
  );
  console.log('Then: report');
  return enqueued;
}

interface ReportRow {
  readonly site: Site;
  readonly company_id: string | null;
  readonly dedupe_key: string | null;
  readonly job_status: string | null;
  readonly attempts: number | null;
  readonly last_error: string | null;
  readonly http_status: number | null;
  readonly robots_allowed: boolean | null;
  readonly bytes: number | null;
  readonly text_length: number | null;
  readonly snapshot_id: string | null;
  readonly final_url: string | null;
}

/**
 * Read-only. Three SELECTs per site and not a single write.
 *
 * Snapshots are matched on the job's trace id as well as the company, so the
 * report describes this run rather than whatever else has ever been fetched for
 * the firm (§16: the trace id is the thread through the whole pipeline).
 */
async function collect(pool: Pool, sites: readonly Site[]): Promise<ReportRow[]> {
  const rows: ReportRow[] = [];

  for (const site of sites) {
    const company = await pool.query<{ id: string }>(
      'SELECT id FROM companies WHERE canonical_domain = $1',
      [site.canonical_domain],
    );
    const companyId = company.rows[0]?.id ?? null;
    if (companyId === null) {
      rows.push({
        site,
        company_id: null,
        dedupe_key: null,
        job_status: null,
        attempts: null,
        last_error: null,
        http_status: null,
        robots_allowed: null,
        bytes: null,
        text_length: null,
        snapshot_id: null,
        final_url: null,
      });
      continue;
    }

    const job = await pool.query<{
      dedupe_key: string;
      status: string;
      attempts: number;
      last_error: string | null;
      trace_id: string;
    }>(
      `SELECT dedupe_key, status, attempts, last_error, trace_id
         FROM jobs
        WHERE kind = 'web.fetch' AND dedupe_key LIKE $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [`fetch:${companyId}:%`],
    );
    const jobRow = job.rows[0];

    const snapshot = await pool.query<{
      id: string;
      url: string;
      http_status: number | null;
      robots_allowed: boolean;
      bytes: number | null;
      text_length: number | null;
    }>(
      `SELECT id, url, http_status, robots_allowed, bytes, length(text) AS text_length
         FROM web_snapshots
        WHERE company_id = $1
          AND ($2::text IS NULL OR trace_id = $2)
        ORDER BY fetched_at DESC
        LIMIT 1`,
      [companyId, jobRow?.trace_id ?? null],
    );
    const snap = snapshot.rows[0];

    rows.push({
      site,
      company_id: companyId,
      dedupe_key: jobRow?.dedupe_key ?? null,
      job_status: jobRow?.status ?? null,
      attempts: jobRow?.attempts ?? null,
      last_error: jobRow?.last_error ?? null,
      http_status: snap?.http_status ?? null,
      robots_allowed: snap?.robots_allowed ?? null,
      bytes: snap?.bytes ?? null,
      text_length: snap?.text_length ?? null,
      snapshot_id: snap?.id ?? null,
      final_url: snap?.url ?? null,
    });
  }

  return rows;
}

/** The §25 Day 3 criterion, stated as a predicate rather than as an opinion. */
function countsTowardAcceptance(row: ReportRow): boolean {
  return (
    row.snapshot_id !== null &&
    row.http_status !== null &&
    row.http_status >= 200 &&
    row.http_status < 300 &&
    row.robots_allowed === true &&
    (row.text_length ?? 0) >= USABLE_TEXT_CHARS
  );
}

function printReport(rows: readonly ReportRow[]): void {
  const header = [
    'company'.padEnd(42),
    'domain'.padEnd(36),
    'job'.padEnd(10),
    'http'.padEnd(5),
    'robots'.padEnd(7),
    'bytes'.padEnd(8),
    'text'.padEnd(7),
    'snapshot'.padEnd(9),
    'counts',
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    console.log(
      [
        (row.site.legal_name + (row.site.name_evidence === 'domain' ? ' *' : '')).padEnd(42),
        row.site.canonical_domain.padEnd(36),
        (row.job_status ?? 'none').padEnd(10),
        (row.http_status === null ? '-' : String(row.http_status)).padEnd(5),
        (row.robots_allowed === null ? '-' : row.robots_allowed ? 'yes' : 'NO').padEnd(7),
        (row.bytes === null ? '-' : String(row.bytes)).padEnd(8),
        (row.text_length === null ? '-' : String(row.text_length)).padEnd(7),
        (row.snapshot_id === null ? 'no' : 'yes').padEnd(9),
        countsTowardAcceptance(row) ? 'YES' : 'no',
      ].join(' '),
    );
    if (row.last_error !== null && row.last_error !== '') {
      console.log(`      error: ${row.last_error.slice(0, 200)}`);
    }
  }

  const counted = rows.filter(countsTowardAcceptance);
  console.log('');
  console.log(`* trading name read off the domain, not stated by a source — see sites.json`);
  console.log('');
  console.log(
    `counts toward the §25 Day 3 target: ${counted.length} of ${rows.length} ` +
      `(2xx, robots-allowed, >=${USABLE_TEXT_CHARS} chars of extracted text)`,
  );

  const stored403 = rows.filter(
    (row) => row.snapshot_id !== null && row.http_status !== null && row.http_status >= 400,
  );
  if (stored403.length > 0) {
    console.log('');
    console.log(
      `NOTE: ${stored403.length} snapshot(s) stored with a >=400 status: ` +
        stored403.map((row) => `${row.site.canonical_domain} (${row.http_status})`).join(', '),
    );
    console.log(
      'These are error pages, not evidence. They are excluded from the count above, ' +
        'and ops/day3-acceptance/findings.md explains why the fetcher should not be ' +
        'storing them as successes at all.',
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'DATABASE_URL is required. Run this inside the stack, where the ' +
        'operator_app connection string is already in the environment — never ' +
        'paste a connection string on the command line.',
    );
  }

  const sites = loadSites(options);
  const pool = createPool(databaseUrl);
  try {
    if (options.mode === 'plan') {
      await runPlan(pool, sites, options);
      return;
    }
    if (options.mode === 'enqueue') {
      await runEnqueue(pool, sites, options);
      return;
    }

    const rows = await collect(pool, sites);
    if (options.json) {
      console.log(JSON.stringify({ usable_text_chars: USABLE_TEXT_CHARS, rows }, null, 2));
    } else {
      printReport(rows);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
