/**
 * Resolving docker-compose configuration in tests.
 *
 * `docker compose config` is the authority for every claim about the deployed
 * topology: it is what the daemon acts on, after interpolation and after the
 * production override has merged. Asserting on the YAML alone cannot see
 * `!override`, and cannot see a mapping inherited from the base file.
 *
 * The env file is a real temporary file rather than /dev/stdin: compose does not
 * read a piped --env-file, and it fails *closed* on `${POSTGRES_PASSWORD:?}`,
 * so the whole resolution silently fell through the catch and every assertion
 * below it skipped.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

/**
 * Placeholder values, enough for interpolation and nothing more. No real
 * secret belongs in a test: production .env lives only on the VPS (§17).
 */
const PLACEHOLDER_ENV = [
  'POSTGRES_PASSWORD=placeholder',
  'DATABASE_URL=postgresql://operator_app:placeholder@postgres:5432/operator',
  'ADMIN_DATABASE_URL=postgresql://postgres:placeholder@postgres:5432/operator',
  'SCHED_DATABASE_URL=postgresql://operator_sched:placeholder@postgres:5432/operator',
  'FETCH_DATABASE_URL=postgresql://operator_fetch:placeholder@postgres:5432/operator',
  `FETCHER_SHARED_SECRET=${'s'.repeat(48)}`,
  'OPERATOR_APP_PASSWORD=placeholder',
  'OPERATOR_FETCH_PASSWORD=placeholder',
  'OPERATOR_SCHED_PASSWORD=placeholder',
  'OPERATOR_MIGRATE_PASSWORD=placeholder',
  'OPERATOR_RO_PASSWORD=placeholder',
  '',
].join('\n');

/**
 * The fully resolved configuration for the given compose files, or undefined
 * when no Docker daemon is reachable — CI runs these with one.
 */
export function resolveCompose(files: string[]): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'operator-compose-'));
  const envFile = join(dir, 'env');
  try {
    writeFileSync(envFile, PLACEHOLDER_ENV, { mode: 0o600 });
    return execFileSync(
      'docker',
      [
        'compose',
        ...files.flatMap((file) => ['-f', file]),
        '--env-file',
        envFile,
        '--profile',
        'migrate',
        'config',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Splits a resolved configuration into its per-service blocks, by name. */
export function composeServices(resolved: string): Map<string, string> {
  const blocks = resolved
    .slice(resolved.indexOf('\nservices:'))
    .split(/^  (?=\S+:)/m)
    .slice(1);

  const found = new Map<string, string>();
  for (const block of blocks) {
    const name = block.slice(0, block.indexOf(':'));
    // Stop at the next top-level key, so networks:/volumes: do not leak into
    // the last service's block and satisfy an assertion by accident. The search
    // starts after the service's own name line, which is itself unindented
    // relative to the block and would otherwise match at offset zero and
    // truncate every block to the empty string — an assertion that passes
    // because it is looking at nothing.
    const bodyAt = block.indexOf('\n') + 1;
    const end = block.slice(bodyAt).search(/^\S/m);
    found.set(name, end === -1 ? block : block.slice(0, bodyAt + end));
  }
  return found;
}
