/**
 * The eligibility threshold, measured against the real corpus (review item 2).
 *
 * The 1,000-character floor was an argument, not a measurement. This prints the
 * comparison the decision actually needs: for each candidate threshold, how many
 * of the accepted snapshots pass, which firms are excluded, and what their
 * normalised length and distinct-word count are.
 *
 * Read-only and free. No model call, no network, no write of any kind — it runs
 * three SELECTs and does the arithmetic in TypeScript using the same functions
 * the production gate uses, so the table cannot disagree with the gate.
 *
 * Run it on the VPS:
 *
 *   docker compose run --rm --no-deps \
 *     -e SERVICE_NAME=day4-thresholds \
 *     -v /opt/stenth-operator/ops:/app/ops:ro \
 *     worker node --import tsx /app/ops/day4-extraction/thresholds.ts
 */
import type { Pool } from 'pg';

import { createPool } from '../../src/db/client';
import {
  countDistinctWords,
  isOnOwnDomain,
  normaliseForMeasurement,
} from '../../src/pipeline/evidence';

/** The candidates the review asked for, plus the one this recommends. */
const CANDIDATES: { readonly label: string; readonly chars: number; readonly words: number }[] = [
  { label: '500 / 25', chars: 500, words: 25 },
  { label: '750 / 30', chars: 750, words: 30 },
  { label: '1000 / 50', chars: 1_000, words: 50 },
  { label: '400 / 20', chars: 400, words: 20 },
];

interface Row {
  canonical_domain: string;
  legal_name: string | null;
  url: string;
  http_status: number;
  text: string;
  signals_present: boolean;
}

interface Measured {
  readonly domain: string;
  readonly name: string;
  readonly url: string;
  readonly chars: number;
  readonly words: number;
  readonly onDomain: boolean;
  readonly signals: boolean;
}

async function measure(pool: Pool): Promise<Measured[]> {
  // usable_snapshots, so a non-2xx row cannot reach the table (migration 005),
  // and the newest snapshot per firm, so a re-fetch does not double-count.
  const { rows } = await pool.query<Row>(`
    SELECT DISTINCT ON (c.canonical_domain)
           c.canonical_domain::text AS canonical_domain,
           c.legal_name,
           s.url,
           s.http_status,
           s.text,
           (w.signals IS NOT NULL) AS signals_present
      FROM usable_snapshots s
      JOIN web_snapshots w ON w.id = s.id
      JOIN companies c ON c.id = s.company_id
     ORDER BY c.canonical_domain, s.fetched_at DESC
  `);

  return rows.map((row) => {
    const normalised = normaliseForMeasurement(row.text);
    return {
      domain: row.canonical_domain,
      name: row.legal_name ?? '(no name)',
      url: row.url,
      chars: normalised.length,
      words: countDistinctWords(normalised),
      onDomain: isOnOwnDomain(row.url, row.canonical_domain),
      signals: row.signals_present,
    };
  });
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'DATABASE_URL is required. Run this inside the stack, where the ' +
        'operator_app connection string is already in the environment.',
    );
  }

  const pool = createPool(databaseUrl);
  return measure(pool)
    .then((measured) => {
      measured.sort((a, b) => a.chars - b.chars);

      console.log('');
      console.log(`Snapshots with usable 2xx evidence: ${measured.length}`);
      console.log('');
      console.log(
        `${pad('firm', 42)} ${pad('domain', 36)} ${pad('chars', 8)} ${pad('words', 7)} ${pad('on-domain', 10)} signals`,
      );
      console.log('-'.repeat(112));
      for (const row of measured) {
        console.log(
          `${pad(row.name.slice(0, 41), 42)} ${pad(row.domain, 36)} ` +
            `${pad(row.chars, 8)} ${pad(row.words, 7)} ` +
            `${pad(row.onDomain ? 'yes' : 'NO', 10)} ${row.signals ? 'yes' : 'none'}`,
        );
      }

      console.log('');
      console.log('Threshold comparison (first-party rows only; off-domain is a separate rule)');
      console.log('');
      console.log(
        `${pad('threshold', 14)} ${pad('eligible', 10)} ${pad('excluded', 10)} excluded firms`,
      );
      console.log('-'.repeat(112));

      const firstParty = measured.filter((row) => row.onDomain);
      for (const candidate of CANDIDATES) {
        const excluded = firstParty.filter(
          (row) => row.chars < candidate.chars || row.words < candidate.words,
        );
        console.log(
          `${pad(candidate.label, 14)} ${pad(firstParty.length - excluded.length, 10)} ` +
            `${pad(excluded.length, 10)} ` +
            (excluded.length === 0
              ? '(none)'
              : excluded
                  .map((row) => `${row.domain} (${row.chars}c/${row.words}w)`)
                  .join(', ')),
        );
      }

      const offDomain = measured.filter((row) => !row.onDomain);
      console.log('');
      if (offDomain.length === 0) {
        console.log('Off-domain final URLs: none.');
      } else {
        console.log(`Off-domain final URLs (refused as evidence, review item 4): ${offDomain.length}`);
        for (const row of offDomain) {
          console.log(`  ${row.domain} -> ${row.url}`);
        }
      }

      const withoutSignals = measured.filter((row) => !row.signals);
      console.log('');
      console.log(
        `Snapshots with no Tier A scan: ${withoutSignals.length} of ${measured.length}` +
          (withoutSignals.length === 0 ? '' : ' — these record Tier A as unknown until a re-fetch'),
      );
      console.log('');
      console.log('Nothing was written. No model was called.');
    })
    .finally(() => pool.end());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
