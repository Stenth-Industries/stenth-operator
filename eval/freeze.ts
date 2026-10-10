/**
 * eval/freeze.ts — turning stored evidence into frozen fixtures (§21, §25 Day 5).
 *
 *   npm run eval:freeze -- --fixture-set=<set> --domains=a.com.au,b.com.au
 *   npm run eval:freeze -- --fixture-set=<set> --domains-file=./domains.txt
 *
 * Read-only against the source database, and that is a property of the SQL
 * rather than a promise: the only statement here is a SELECT. Point
 * `EVAL_SOURCE_DATABASE_URL` at the `operator_ro` role and the privilege model
 * enforces it as well (§17).
 *
 * No fetch, no model, no provider. A fixture is made out of evidence the
 * pipeline already has; if a page is not in `web_snapshots`, freezing cannot
 * invent it and does not try.
 *
 * ## Selection is always explicit
 *
 * There is no `--all`. A corpus is ground truth, and ground truth assembled by
 * "whatever was in the table that afternoon" is not reproducible — the next
 * person to run it gets a different corpus and the same command. So the domains
 * are named, on the command line or in a file, and a run with none refuses.
 *
 * ## Overwrite protection
 *
 * A fixture that exists is left alone unless `--replace` is passed, and the
 * command says which it skipped. Re-freezing unchanged evidence produces
 * identical bytes, so `--replace` on an unchanged corpus is a no-op you can see
 * in `git status` — which is the point of canonical JSON.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool } from 'pg';

import { assembleSignals } from '../src/worker/handlers/web-extract';
import { canonicalJson } from './canonical';
import { companiesDir, relativeToRepo, writeAtomic } from './paths';
import {
  SanitiserRejection,
  safeFixtureFilename,
  sanitiseToFixture,
  type SourceSnapshot,
} from './sanitise-snapshot';
import type { FixtureFile } from './schemas';

/**
 * The evidence for one firm, newest content first.
 *
 * `usable_snapshots` is deliberately **not** the source here. Migration 005
 * created that view so later analysis cannot treat a non-2xx row as evidence,
 * and a fixture needs more than that: a page that was robots-disallowed or
 * answered 404 is part of what §10 stage 3 found, and a corpus that silently
 * dropped those rows would make every firm look like it had a complete site.
 * The fixture carries the status and the text-free row; the schema's `text:
 * null` keeps it from ever reading as evidence.
 *
 * One row per URL: the most recently fetched content for that URL, so a firm
 * re-fetched twice does not produce two pages for one page.
 */
export const SELECT_SNAPSHOTS = `
  SELECT DISTINCT ON (s.url)
         s.url,
         s.http_status,
         s.robots_allowed,
         s.content_hash,
         s.bytes,
         s.text,
         s.signals,
         j.payload ->> 'page_kind' AS page_kind
    FROM web_snapshots s
    JOIN companies c ON c.id = s.company_id
    LEFT JOIN jobs j
           ON j.kind = 'web.fetch'
          AND j.payload ->> 'company_id' = c.id::text
          AND j.payload -> 'urls' ? s.url
   WHERE c.canonical_domain = $1
   ORDER BY s.url, s.fetched_at DESC
`;

export interface FrozenFixture {
  readonly domain: string;
  readonly path: string;
  readonly pages: number;
  /** Absent for a skipped fixture: nothing was read, so there is nothing to show. */
  readonly fixture: FixtureFile | undefined;
  readonly action: 'written' | 'skipped_exists' | 'replaced';
}

export interface FreezeOptions {
  readonly fixtureSet: string;
  readonly domains: readonly string[];
  readonly replace: boolean;
  readonly dryRun?: boolean;
}

/** Reads the evidence for one domain. The only database access in this file. */
export async function readSnapshots(pool: Pool, domain: string): Promise<SourceSnapshot[]> {
  const { rows } = await pool.query<SourceSnapshot>(SELECT_SNAPSHOTS, [domain]);
  return rows;
}

export async function freeze(pool: Pool, options: FreezeOptions): Promise<FrozenFixture[]> {
  if (options.domains.length === 0) {
    throw new SanitiserRejection(
      'no_selection',
      'name the domains to freeze with --domains or --domains-file. There is no --all: ' +
        'a corpus assembled from "whatever was in the table" is not reproducible',
    );
  }

  const seen = new Set<string>();
  const frozen: FrozenFixture[] = [];

  for (const raw of options.domains) {
    const domain = raw.trim().toLowerCase();
    if (domain === '') {
      continue;
    }
    if (seen.has(domain)) {
      throw new SanitiserRejection('duplicate_domain', `${domain} appears twice in the selection`);
    }
    seen.add(domain);

    // Validated before the query, so an unsafe domain never reaches the disk
    // and never reaches a parameter.
    const filename = safeFixtureFilename(domain);
    const path = join(companiesDir(options.fixtureSet), filename);
    const exists = existsSync(path);

    if (exists && !options.replace) {
      frozen.push({
        domain,
        path: relativeToRepo(path),
        pages: 0,
        fixture: undefined,
        action: 'skipped_exists',
      });
      continue;
    }

    const snapshots = await readSnapshots(pool, domain);
    const fixture = sanitiseToFixture({
      fixtureSet: options.fixtureSet,
      canonicalDomain: domain,
      snapshots,
      assembleSignals,
    });

    if (options.dryRun !== true) {
      writeAtomic(path, canonicalJson(fixture));
    }
    frozen.push({
      domain,
      path: relativeToRepo(path),
      pages: fixture.pages.length,
      fixture,
      action: exists ? 'replaced' : 'written',
    });
  }

  return frozen;
}

/** `--domains-file`: one domain per line, `#` comments and blanks ignored. */
export function readDomainsFile(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(argv: readonly string[]): Promise<void> {
  const fixtureSet = flag(argv, 'fixture-set');
  if (fixtureSet === undefined || fixtureSet === '') {
    throw new Error('--fixture-set=<name> is required');
  }

  const inline = flag(argv, 'domains');
  const fromFile = flag(argv, 'domains-file');
  const domains = [
    ...(inline === undefined ? [] : inline.split(',')),
    ...(fromFile === undefined ? [] : readDomainsFile(fromFile)),
  ];

  const databaseUrl = process.env.EVAL_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'EVAL_SOURCE_DATABASE_URL (or DATABASE_URL) is required. Point it at operator_ro: ' +
        'this command only reads, and §17 would rather the connection said so too.',
    );
  }

  const { createPool } = await import('../src/db/client');
  const pool = createPool(databaseUrl);
  try {
    const frozen = await freeze(pool, {
      fixtureSet,
      domains,
      replace: argv.includes('--replace'),
      dryRun: argv.includes('--dry-run'),
    });

    console.log('');
    for (const entry of frozen) {
      console.log(
        entry.action === 'skipped_exists'
          ? `  skipped   ${entry.domain}  (${entry.path} exists; pass --replace)`
          : `  ${entry.action === 'replaced' ? 'replaced ' : 'froze    '} ${entry.domain}  ` +
            `${entry.pages} page(s) -> ${entry.path}`,
      );
    }
    console.log('');
    const written = frozen.filter((entry) => entry.action !== 'skipped_exists').length;
    console.log(
      `${written} fixture(s) ${argv.includes('--dry-run') ? 'would be written' : 'written'}, ` +
        `${frozen.length - written} skipped.`,
    );
  } finally {
    await pool.end();
  }
}

if (process.env.VITEST === undefined && /eval[\\/]freeze\.ts$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
