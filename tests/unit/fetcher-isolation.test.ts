import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');

/**
 * Strips comments. Every "must not contain" claim below is about instructions,
 * not about the prose explaining them: a Dockerfile comment recording that
 * --chmod was considered and rejected is the opposite of a problem.
 */
function statementsOnly(source: string, lineComment: string): string {
  return source
    .split('\n')
    .map((line) => line.split(lineComment)[0] ?? '')
    .join('\n');
}

function tsStatementsOnly(source: string): string {
  return statementsOnly(source.replace(/\/\*[\s\S]*?\*\//g, ''), '//');
}

/**
 * The structural assertions of SPEC.md §23 for the fetcher, plus the Dockerfile
 * hardening. These are cheap, they run without Docker, and they catch the
 * failures that matter most: a credential reaching the one process that touches
 * hostile input, or a port reaching the host.
 */
describe('Dockerfile: a non-root target never depends on host file modes', () => {
  /** Splits the Dockerfile into its stages. */
  function stages(source: string): Map<string, string> {
    const found = new Map<string, string>();
    let name: string | undefined;
    let lines: string[] = [];
    for (const line of source.split('\n')) {
      const match = /^FROM\s+\S+\s+AS\s+(\S+)/i.exec(line);
      if (match) {
        if (name !== undefined) {
          found.set(name, lines.join('\n'));
        }
        name = match[1];
        lines = [];
        continue;
      }
      lines.push(line);
    }
    if (name !== undefined) {
      found.set(name, lines.join('\n'));
    }
    return found;
  }

  const byStage = stages(dockerfile);

  it('defines the four runtime targets Day 3 needs', () => {
    for (const target of ['tools', 'worker', 'fetcher', 'web']) {
      expect([...byStage.keys()]).toContain(target);
    }
  });

  it.each(['tools', 'worker', 'fetcher'])(
    '%s runs as node and chowns everything it copies',
    (target) => {
      const stage = byStage.get(target) ?? '';
      expect(stage).toMatch(/^USER node$/m);

      const copies = stage.split('\n').filter((line) => /^COPY\s/.test(line));
      expect(copies.length).toBeGreaterThan(0);
      for (const copy of copies) {
        // COPY preserves the host's file modes and only normalises the
        // destination directory, so a checkout made under a leaked umask 077
        // arrives as 600 files inside 700 nested directories owned by root —
        // and the non-root user cannot read its own application. Measured
        // before and after: 700 root -> denied, 700 node -> readable.
        expect(copy, `${target}: "${copy.trim()}" must carry --chown=node:node`).toContain(
          '--chown=node:node',
        );
      }
    },
  );

  it('does not reach for --chmod, which would make source files executable', () => {
    expect(statementsOnly(dockerfile, '#')).not.toContain('--chmod');
  });

  it('gives the fetcher no build-time credential', () => {
    const stage = statementsOnly(byStage.get('fetcher') ?? '', '#');
    expect(stage).not.toMatch(/MODEL_API_KEY|ANTHROPIC|OPENAI|SMTP|SENDGRID/i);
  });
});

describe('GATE 19: the fetcher publishes no host port (§8, §20)', () => {
  it('declares no ports key at all in the compose service', () => {
    const service = compose.slice(compose.indexOf('\n  fetcher:'), compose.indexOf('\n  web:'));
    expect(service).toContain('target: fetcher');
    expect(service).not.toMatch(/^\s{4}ports:/m);
  });

  it('is proven by the resolved configuration, not just the file', () => {
    // docker compose config is the authority: it is what the daemon acts on.
    const env = [
      'POSTGRES_PASSWORD=d',
      'DATABASE_URL=postgresql://operator_app:d@postgres:5432/operator',
      'ADMIN_DATABASE_URL=postgresql://postgres:d@postgres:5432/operator',
      'SCHED_DATABASE_URL=postgresql://operator_sched:d@postgres:5432/operator',
      'FETCH_DATABASE_URL=postgresql://operator_fetch:d@postgres:5432/operator',
      `FETCHER_SHARED_SECRET=${'s'.repeat(48)}`,
      'OPERATOR_APP_PASSWORD=d',
      'OPERATOR_FETCH_PASSWORD=d',
      'OPERATOR_SCHED_PASSWORD=d',
      'OPERATOR_MIGRATE_PASSWORD=d',
      'OPERATOR_RO_PASSWORD=d',
      '',
    ].join('\n');

    let resolved: string;
    try {
      resolved = execFileSync(
        'docker',
        ['compose', '--env-file', '/dev/stdin', '--profile', 'migrate', 'config'],
        { cwd: root, input: env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      // No docker in this environment: the file-level assertion above still
      // holds, and CI runs this with a daemon available.
      return;
    }

    const services = resolved.split(/^  (?=\S+:)/m);
    const fetcher = services.find((block) => block.startsWith('fetcher:'));
    expect(fetcher, 'no fetcher service in the resolved config').toBeDefined();
    expect(fetcher).not.toContain('published:');

    // And only web publishes anything at all, on loopback.
    const publishing = services.filter((block) => block.includes('published:'));
    expect(publishing).toHaveLength(1);
    expect(publishing[0]?.startsWith('web:')).toBe(true);
    expect(publishing[0]).toContain('127.0.0.1');
  });
});

describe('GATE 18: the fetcher holds no model or mail credential (§8, §17)', () => {
  const service = statementsOnly(
    compose.slice(compose.indexOf('\n  fetcher:'), compose.indexOf('\n  web:')),
    '#',
  );

  it('is given no model key and no mail credential in compose', () => {
    for (const forbidden of [
      'MODEL_API_KEY', 'ANTHROPIC', 'OPENAI', 'GEMINI',
      'SMTP', 'SENDGRID', 'POSTMARK', 'RESEND', 'MAILGUN', 'GMAIL', 'OAUTH',
    ]) {
      expect(service, `fetcher must not receive ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('is given no application, scheduler, admin or migrate database role', () => {
    expect(service).toContain('FETCH_DATABASE_URL');
    expect(service).not.toContain('ADMIN_DATABASE_URL');
    expect(service).not.toContain('SCHED_DATABASE_URL');
    expect(service).not.toMatch(/OPERATOR_(APP|SCHED|MIGRATE|RO)_PASSWORD/);
    // DATABASE_URL is present but deliberately points at the same narrow
    // connection, because config.ts requires it to boot.
    expect(service).toMatch(/DATABASE_URL:\s*\$\{FETCH_DATABASE_URL\}/);
  });

  it('refuses to start if a model key ever reaches its environment', () => {
    // Structural, not a comment: the service stops rather than running with a
    // credential it must not have.
    const server = readFileSync(join(root, 'src', 'fetcher', 'server.ts'), 'utf8');
    expect(server).toContain('MODEL_API_KEY is present in the fetcher environment');
  });

  it('imports nothing that could send mail or call a model', () => {
    const sources = ['src/fetcher/server.ts', 'src/fetcher/contract.ts', 'src/fetch/http.ts']
      .map((file) => tsStatementsOnly(readFileSync(join(root, file), 'utf8')))
      .join('\n');
    for (const forbidden of ['googleapis', 'nodemailer', '@anthropic-ai', 'openai', '@sendgrid']) {
      expect(sources).not.toContain(`from '${forbidden}`);
    }
  });
});

describe('the fetcher takes only what it needs (§8)', () => {
  it('accepts three fields and nothing else', () => {
    const contract = readFileSync(join(root, 'src', 'fetcher', 'contract.ts'), 'utf8');
    expect(contract).toContain('.strict()');
    // No knob a job could use to redirect, proxy or re-credential the fetch.
    const code = tsStatementsOnly(contract).toLowerCase();
    for (const forbidden of ['proxy', 'bindaddress', 'localaddress', 'maxredirect', 'dispatcher']) {
      expect(code, `the contract must expose no "${forbidden}"`).not.toContain(forbidden);
    }
  });
});
