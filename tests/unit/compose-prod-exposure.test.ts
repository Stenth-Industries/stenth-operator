/**
 * The production topology publishes nothing to the host (SPEC.md §20).
 *
 * The VPS is shared production: an existing Caddy already owns 80 and 443, and
 * a published Docker port bypasses ufw entirely, so a mapping that leaks into
 * the production configuration is not a development inconvenience — it is a
 * port open to the internet on a box serving a paying client.
 *
 * The invariant is about the *resolved* configuration, because that is what the
 * daemon acts on: docker-compose.yml maps web to 127.0.0.1:3000 for local work
 * and docker-compose.prod.yml removes it with `!override []`. A Day 3 smoke run
 * that omitted the override published 3000 on the development box, which is
 * exactly the drift this locks down.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { composeServices, resolveCompose } from '../helpers/compose';

const root = join(__dirname, '..', '..');

describe('the production override publishes no host port at all (§20)', () => {
  const prod = resolveCompose(['docker-compose.yml', 'docker-compose.prod.yml']);

  it('states the override in the file, so the intent survives without a daemon', () => {
    const override = readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8');
    // A plain `ports: []` would be merged with the base list, not replace it.
    expect(override).toMatch(/ports:\s*!override\s*\[\]/);
  });

  it.runIf(prod !== undefined)('resolves to zero published ports across every service', () => {
    const resolved = prod as string;
    for (const [name, block] of composeServices(resolved)) {
      expect(block, `${name} must publish nothing in production`).not.toContain('published:');
      expect(block, `${name} must bind no host address in production`).not.toContain('host_ip:');
    }
    expect(resolved).not.toMatch(/^\s+ports:/m);
  });

  it.runIf(prod !== undefined)('keeps web and fetcher specifically unexposed', () => {
    const byName = composeServices(prod as string);
    for (const name of ['web', 'fetcher']) {
      const block = byName.get(name);
      expect(block, `no ${name} service in the resolved production config`).toBeDefined();
      expect(block).not.toContain('published:');
    }
  });

  it.runIf(prod !== undefined)('does not reach that state by deleting the services', () => {
    // A zero-port configuration is worthless if it is also zero-service. The
    // services must still be there, built from the same targets.
    const byName = composeServices(prod as string);
    for (const name of ['postgres', 'worker', 'fetcher', 'web']) {
      expect([...byName.keys()], `${name} must survive the override`).toContain(name);
    }
    expect(byName.get('fetcher')).toContain('target: fetcher');
    expect(byName.get('web')).toContain('target: web');
  });

  it.runIf(prod !== undefined)('leaves the project name and network to Operator alone', () => {
    // Shared box: the stack must not join or rename anything already running.
    const resolved = prod as string;
    expect(resolved).toMatch(/^name:\s*stenth-operator$/m);
    expect(resolved).not.toContain('external: true');
  });
});

describe('development publishes only the dashboard, only on loopback', () => {
  const dev = resolveCompose(['docker-compose.yml']);

  it.runIf(dev !== undefined)('publishes 3000 on 127.0.0.1 and nothing else', () => {
    const publishing = [...composeServices(dev as string)].filter(([, block]) =>
      block.includes('published:'),
    );
    expect(publishing.map(([name]) => name)).toEqual(['web']);
    expect(publishing[0]?.[1]).toContain('127.0.0.1');
    expect(publishing[0]?.[1]).toContain('"3000"');
  });
});
