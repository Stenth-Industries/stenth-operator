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
 *   enqueue   does it, for the sixteen primary firms. Requires --yes.
 *   reserve   enqueues a small batch of reserve firms, and refuses to do so at
 *             all once the accepted count has reached 20. The reserves exist to
 *             close a shortfall, not to be fetched as a matter of course.
 *   report    read-only; prints the acceptance table and the accepted count.
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

/** §25 Day 3: "20 real law-firm sites fetched and stored". */
const ACCEPTANCE_TARGET = 20;

/** Reserves per `reserve` run unless --batch says otherwise. */
const DEFAULT_RESERVE_BATCH = 4;

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
  readonly mode: 'plan' | 'enqueue' | 'reserve' | 'report' | 'refetch-signals';
  readonly only: readonly string[];
  readonly batch: number;
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
  if (
    mode !== 'plan' &&
    mode !== 'enqueue' &&
    mode !== 'reserve' &&
    mode !== 'report' &&
    mode !== 'refetch-signals'
  ) {
    throw new Error(
      `unknown mode "${mode}": expected plan, enqueue, reserve, report or refetch-signals`,
    );
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

  const batch = Number(flag('batch') ?? String(DEFAULT_RESERVE_BATCH));
  if (!Number.isInteger(batch) || batch < 1 || batch > 9) {
    throw new Error('--batch must be between 1 and 9: reserves go out in small batches');
  }

  return {
    mode,
    only: (flag('only') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== ''),
    batch,
    staggerSeconds: stagger,
    maxAttempts: attempts,
    occurrence,
    confirmed: argv.includes('--yes'),
    json: argv.includes('--json'),
  };
}

interface Seed {
  readonly sites: Site[];
  readonly reserve: Site[];
}

function loadSeed(): Seed {
  const raw = readFileSync(join(__dirname, 'sites.json'), 'utf8');
  const seed = seedSchema.parse(JSON.parse(raw));

  const all = [...seed.sites, ...seed.reserve];
  const domains = new Set(all.map((site) => site.canonical_domain));
  if (domains.size !== all.length) {
    throw new Error('sites.json contains a duplicate canonical_domain');
  }
  return { sites: seed.sites, reserve: seed.reserve };
}

/** Applies --only to a list, and complains about a name that is not in it. */
function select(pool: readonly Site[], only: readonly string[]): Site[] {
  if (only.length === 0) {
    return [...pool];
  }
  const selected = pool.filter((site) => only.includes(site.canonical_domain));
  for (const wanted of only) {
    if (!selected.some((site) => site.canonical_domain === wanted)) {
      throw new Error(`--only names "${wanted}", which is not in this list in sites.json`);
    }
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

/**
 * How many distinct firms currently have usable evidence, database-wide.
 *
 * Read from the usable_snapshots view (migration 005), not from web_snapshots
 * with a hand-written predicate: the view is the single definition of "this is
 * the firm's own page, fetched with permission, and it answered 2xx", and it
 * excludes the one pre-correction 403 row that a `text IS NOT NULL` filter
 * would still let through.
 *
 * Deliberately not scoped to sites.json. The four firms accepted before this
 * harness existed count toward §25's twenty just as much as these do, and the
 * gate on the reserves has to be the real total or it is not a gate.
 */
async function acceptedCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ firms: string }>(
    `SELECT count(DISTINCT company_id) AS firms
       FROM usable_snapshots
      WHERE length(text) >= $1`,
    [USABLE_TEXT_CHARS],
  );
  return Number(rows[0]?.firms ?? 0);
}

async function acceptedDomains(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ canonical_domain: string }>(
    `SELECT DISTINCT c.canonical_domain
       FROM usable_snapshots s
       JOIN companies c ON c.id = s.company_id
      WHERE length(s.text) >= $1
      ORDER BY c.canonical_domain`,
    [USABLE_TEXT_CHARS],
  );
  return rows.map((row) => row.canonical_domain);
}

/** Reserve firms that have never been enqueued by this harness. */
async function untouchedReserves(pool: Pool, reserve: readonly Site[]): Promise<Site[]> {
  const untouched: Site[] = [];
  for (const site of reserve) {
    const { rows } = await pool.query<{ hits: string }>(
      `SELECT count(*) AS hits
         FROM jobs j
         JOIN companies c ON c.id = (j.payload->>'company_id')::uuid
        WHERE j.kind = 'web.fetch' AND c.canonical_domain = $1`,
      [site.canonical_domain],
    );
    if (rows[0]?.hits === '0') {
      untouched.push(site);
    }
  }
  return untouched;
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
  return enqueueAll(pool, sites, options);
}

/** The write loop. Shared by `enqueue` and `reserve`, which differ only in gating. */
async function enqueueAll(
  pool: Pool,
  sites: readonly Site[],
  options: Options,
): Promise<number> {
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

/**
 * Enqueues a small batch of reserves, and only while there is a shortfall.
 *
 * Three separate brakes, because the instruction was not "fetch more sites" but
 * "do not hammer the reserves":
 *
 *   1. Nothing goes out at all once the accepted count has reached 20. The
 *      reserves close a gap; they are not a second round.
 *   2. The batch is capped at the size of the gap, so reaching 19 of 20 sends
 *      one request, not nine.
 *   3. A reserve this harness has already enqueued is never enqueued again,
 *      whatever its outcome was. A site that answered 403 is not asked twice.
 */
async function runReserve(pool: Pool, reserve: readonly Site[], options: Options): Promise<void> {
  const accepted = await acceptedCount(pool);
  console.log(`accepted so far: ${accepted} of ${ACCEPTANCE_TARGET}`);

  if (accepted >= ACCEPTANCE_TARGET) {
    console.log(
      'The target is met, so no reserve is enqueued. Run `report` for the table; ' +
        'nothing further needs to be fetched.',
    );
    return;
  }

  const shortfall = ACCEPTANCE_TARGET - accepted;
  const candidates = await untouchedReserves(pool, select(reserve, options.only));
  if (candidates.length === 0) {
    console.log(
      `Short by ${shortfall}, but every reserve in sites.json has already been ` +
        'enqueued. Verify a further real firm, add it with its evidence_url, and ' +
        'run this again — do not re-ask a site that already answered.',
    );
    return;
  }

  const take = Math.min(options.batch, shortfall, candidates.length);
  const batch = candidates.slice(0, take);

  console.log(
    `short by ${shortfall}; taking ${take} of ${candidates.length} untouched reserves ` +
      `(batch cap ${options.batch})`,
  );
  console.log('');

  if (options.mode === 'reserve' && !options.confirmed) {
    for (const [index, site] of batch.entries()) {
      console.log(` ${index + 1}  ${site.canonical_domain.padEnd(36)} would enqueue`);
    }
    console.log('');
    console.log('Nothing was written. Re-run with: reserve --yes');
    return;
  }

  await enqueueAll(pool, batch, options);
  console.log(
    `remaining untouched reserves: ${candidates.length - take}. ` +
      'Run `report`, and only come back here if there is still a shortfall.',
  );
}

/**
 * The controlled Tier A re-fetch (review item 3).
 *
 * The 20 accepted snapshots predate the scanner, so their `signals` is NULL and
 * extraction records Tier A as `unknown`. This asks the fetcher for each firm's
 * homepage once more, so migration 006's deterministic scan lands.
 *
 * Scoped from the database, not from a list: the firms with usable 2xx evidence
 * and no scan. A firm that was never accepted is not touched, and a firm that
 * already has a scan is not asked again.
 *
 * Everything else is the Day 3 path unchanged — the same worker, the same
 * fetcher, the same robots, politeness and SSRF controls, one homepage per
 * firm, 30 seconds apart, one attempt. No model is called: the scan is regular
 * expressions over markup. A refusal is a refusal; nothing is retried around.
 *
 * Re-fetching unchanged bytes used to be a no-op that left the NULL in place.
 * Migration 008 makes the conflict fill `signals` in when it is missing, with a
 * column-level UPDATE grant and only from NULL — so this run works whether or
 * not a firm has touched its website since Day 3.
 */
async function runRefetchSignals(pool: Pool, options: Options): Promise<void> {
  const { rows } = await pool.query<{
    id: string;
    canonical_domain: string;
    legal_name: string | null;
    url: string;
  }>(
    `SELECT DISTINCT ON (c.canonical_domain)
            c.id, c.canonical_domain::text AS canonical_domain, c.legal_name, s.url
       FROM usable_snapshots s
       JOIN web_snapshots w ON w.id = s.id
       JOIN companies c ON c.id = s.company_id
      WHERE length(s.text) >= $1
        AND w.signals IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM web_snapshots w
           WHERE w.company_id = c.id AND w.signals IS NOT NULL
        )
      ORDER BY c.canonical_domain, s.fetched_at DESC`,
    [USABLE_TEXT_CHARS],
  );

  if (rows.length === 0) {
    console.log('Every accepted firm already has a Tier A scan. Nothing to re-fetch.');
    return;
  }

  console.log(`accepted firms with no Tier A scan: ${rows.length}`);
  console.log(
    `       one homepage each, ${options.staggerSeconds}s apart, ` +
      `max_attempts ${options.maxAttempts}, priority ${ACCEPTANCE_PRIORITY}`,
  );
  console.log(
    `       outbound: ${rows.length} robots.txt + ${rows.length} pages = ` +
      `${rows.length * 2} requests, one host at a time. No model calls.`,
  );
  console.log('');

  if (!options.confirmed) {
    for (const [index, row] of rows.entries()) {
      console.log(
        ` ${String(index + 1).padStart(2)}  ${row.canonical_domain.padEnd(36)} would re-fetch ` +
          `${`https://${row.canonical_domain}/`}`,
      );
    }
    console.log('');
    console.log('Nothing was written. Re-run with: refetch-signals --yes');
    return;
  }

  const startedAt = Date.now();
  let enqueued = 0;
  for (const [index, row] of rows.entries()) {
    const urls = [`https://${row.canonical_domain}/`];
    // A fresh occurrence, so §7's per-occurrence key does not collide with the
    // original acceptance run's job for the same page.
    const key = keyFor(row.id, urls, `${options.occurrence}-signals`);
    const traceId = newTraceId();
    const runAfter = new Date(startedAt + index * options.staggerSeconds * 1000);

    const result = await enqueue(pool, {
      kind: 'web.fetch',
      dedupeKey: key,
      traceId,
      payload: { company_id: row.id, urls },
      priority: ACCEPTANCE_PRIORITY,
      runAfter,
      maxAttempts: options.maxAttempts,
    });
    if (result.inserted) {
      enqueued += 1;
    }
    console.log(
      ` ${String(index + 1).padStart(2)}  ${row.canonical_domain.padEnd(36)} ` +
        `${result.inserted ? 'enqueued      ' : 'deduplicated  '} ` +
        `runs at ${runAfter.toISOString()}  trace ${traceId}`,
    );
  }

  console.log('');
  console.log(`jobs enqueued ${enqueued} of ${rows.length}`);
  console.log('Then: report --signals');
}

/** The Tier A table, read-only, after a re-fetch. */
async function printSignalsReport(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{
    canonical_domain: string;
    legal_name: string | null;
    signals: Record<string, unknown> | null;
  }>(
    `SELECT DISTINCT ON (c.canonical_domain)
            c.canonical_domain::text AS canonical_domain, c.legal_name, w.signals
       FROM usable_snapshots s
       JOIN web_snapshots w ON w.id = s.id
       JOIN companies c ON c.id = s.company_id
      WHERE length(s.text) >= $1
      ORDER BY c.canonical_domain, (w.signals IS NULL), s.fetched_at DESC`,
    [USABLE_TEXT_CHARS],
  );

  const header = [
    'domain'.padEnd(36),
    'AW'.padEnd(5),
    'GA4'.padEnd(5),
    'GTM'.padEnd(5),
    'call'.padEnd(6),
    'tel'.padEnd(5),
    'form'.padEnd(6),
    'vport'.padEnd(7),
    'locs'.padEnd(6),
    'year',
  ].join(' ');
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length));

  const mark = (value: unknown): string =>
    value === true ? 'yes' : value === false ? 'no' : '-';

  let scanned = 0;
  for (const row of rows) {
    const signals = row.signals;
    if (signals !== null) {
      scanned += 1;
    }
    console.log(
      [
        row.canonical_domain.padEnd(36),
        mark(signals?.paid_search_tag).padEnd(5),
        mark(signals?.ga4).padEnd(5),
        mark(signals?.gtm).padEnd(5),
        mark(signals?.call_tracking).padEnd(6),
        mark(signals?.tel_link).padEnd(5),
        mark(signals?.form_present).padEnd(6),
        mark(signals?.viewport_meta).padEnd(7),
        String(signals?.location_page_links ?? '-').padEnd(6),
        String(signals?.copyright_year ?? '-'),
      ].join(' '),
    );
  }

  console.log('');
  console.log(`scanned: ${scanned} of ${rows.length} accepted firms`);
  console.log(
    'A dash means no scanner has looked, which extraction records as unknown — ' +
      'never as absent, because §10 pays for absence.',
  );
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

interface AcceptanceTotals {
  readonly accepted: number;
  readonly domains: readonly string[];
}

function printReport(rows: readonly ReportRow[], totals: AcceptanceTotals): void {
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
    `accepted from this harness: ${counted.length} of ${rows.length} ` +
      `(unique, 2xx, robots-allowed, >=${USABLE_TEXT_CHARS} chars of extracted text)`,
  );

  // The number §25 is actually measured against, which includes the firms
  // accepted before this harness existed. Read from usable_snapshots, so a
  // non-2xx row cannot reach it.
  console.log(
    `accepted across the whole database: ${totals.accepted} of ${ACCEPTANCE_TARGET}` +
      (totals.accepted >= ACCEPTANCE_TARGET ? ' — target met' : ''),
  );
  const outside = totals.domains.filter(
    (domain) => !rows.some((row) => row.site.canonical_domain === domain),
  );
  if (outside.length > 0) {
    console.log(`  of which not in sites.json: ${outside.join(', ')}`);
  }
  if (totals.accepted < ACCEPTANCE_TARGET) {
    console.log(
      `  short by ${ACCEPTANCE_TARGET - totals.accepted}. ` +
        'To close it: `reserve --yes`, which enqueues at most the shortfall and ' +
        'refuses to run once the target is met.',
    );
  }

  const errored = rows.filter(
    (row) => row.snapshot_id !== null && row.http_status !== null && row.http_status >= 400,
  );
  if (errored.length > 0) {
    console.log('');
    console.log(
      `${errored.length} site(s) answered with an error status: ` +
        errored.map((row) => `${row.site.canonical_domain} (${row.http_status})`).join(', '),
    );
    console.log(
      'Each is a diagnostic row with text NULL — status, bytes and URL only. It is ' +
        'not evidence, it is excluded from usable_snapshots by construction, and the ' +
        'site was asked once and not retried.',
    );
  }

  // Finding 2, still an open policy question: §8 re-validates every redirect
  // hop for scheme, port and address but not for host, so a snapshot can end up
  // on a domain that is not the firm's. apex -> www is normal; anything else
  // must be looked at by a person before Day 4 treats it as company evidence.
  const offDomain = rows.filter((row) => {
    if (row.final_url === null) {
      return false;
    }
    const host = row.final_url.replace(/^https?:\/\//, '').split('/')[0] ?? '';
    const domain = row.site.canonical_domain;
    return host !== domain && host !== `www.${domain}`;
  });
  if (offDomain.length > 0) {
    console.log('');
    console.log(`OFF-DOMAIN FINAL URL on ${offDomain.length} site(s):`);
    for (const row of offDomain) {
      console.log(`  ${row.site.canonical_domain} -> ${row.final_url}`);
    }
    console.log(
      'Flagged, not filtered: the registrable-domain policy is undecided ' +
        '(findings.md, finding 2). Day 4 must not consume these as company ' +
        'evidence until it is resolved.',
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

  const seed = loadSeed();
  const pool = createPool(databaseUrl);
  try {
    if (options.mode === 'plan') {
      await runPlan(pool, select(seed.sites, options.only), options);
      return;
    }
    if (options.mode === 'enqueue') {
      await runEnqueue(pool, select(seed.sites, options.only), options);
      return;
    }
    if (options.mode === 'reserve') {
      await runReserve(pool, seed.reserve, options);
      return;
    }
    if (options.mode === 'refetch-signals') {
      await runRefetchSignals(pool, options);
      return;
    }
    if (process.argv.includes('--signals')) {
      await printSignalsReport(pool);
      return;
    }

    // The report covers the primaries always, and a reserve once it has been
    // registered — an untouched reserve is not part of the run.
    const touched = new Set(
      (
        await pool.query<{ canonical_domain: string }>(
          'SELECT canonical_domain FROM companies WHERE canonical_domain = ANY($1::citext[])',
          [seed.reserve.map((site) => site.canonical_domain)],
        )
      ).rows.map((row) => row.canonical_domain),
    );
    const rows = await collect(pool, [
      ...seed.sites,
      ...seed.reserve.filter((site) => touched.has(site.canonical_domain)),
    ]);
    const totals: AcceptanceTotals = {
      accepted: await acceptedCount(pool),
      domains: await acceptedDomains(pool),
    };
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            usable_text_chars: USABLE_TEXT_CHARS,
            acceptance_target: ACCEPTANCE_TARGET,
            accepted_total: totals.accepted,
            accepted_domains: totals.domains,
            rows,
          },
          null,
          2,
        ),
      );
    } else {
      printReport(rows, totals);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
