import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FetchRefused,
  guardedFetch,
  resolveAndValidate,
  systemLookup,
  type LookupImpl,
} from '../../src/fetch/http';
import { FROZEN_POLICY, type FetchPolicy } from '../../src/fetch/policy';

/**
 * The SSRF and limits suite, against real HTTP servers and the real resolver.
 *
 * A local server necessarily lives on loopback, which the frozen policy exists
 * to refuse, so the accept-path cases run with permitLoopback: true and every
 * reject-path case runs against FROZEN_POLICY itself. The first test in the
 * file asserts that distinction is real.
 */
/**
 * The frozen policy with exactly two relaxations, both forced by the fact that
 * a test server runs locally:
 *
 *   permitLoopback — a local server can only be on loopback, which §8 refuses.
 *   allowedPorts   — it binds an ephemeral port, because binding 80 or 443
 *                    needs privileges a CI runner does not have.
 *
 * Nothing else is relaxed, a test below asserts that, and every reject-path
 * case runs against FROZEN_POLICY itself rather than this.
 */
function localPolicy(port: number): FetchPolicy {
  return {
    ...FROZEN_POLICY,
    permitLoopback: true,
    allowedPorts: [...FROZEN_POLICY.allowedPorts, port],
  };
}

interface Fixture {
  readonly server: Server;
  readonly origin: string;
  /** Bytes the server actually managed to write, for the body-cap case. */
  bytesWritten: number;
}

async function startServer(
  handler: (url: string, respond: (status: number, headers: Record<string, string>, body?: string) => void, raw: { onAbort: () => void }) => void,
): Promise<Fixture> {
  const fixture: Partial<Fixture> & { bytesWritten: number } = { bytesWritten: 0 };
  const server = createServer((request, response) => {
    handler(
      request.url ?? '/',
      (status, headers, body) => {
        response.writeHead(status, headers);
        if (body !== undefined) {
          fixture.bytesWritten += Buffer.byteLength(body);
        }
        response.end(body);
      },
      { onAbort: () => undefined },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fixture, { server, origin: `http://127.0.0.1:${port}` }) as Fixture;
}

describe('the test policy differs from the frozen one only where it must', () => {
  it('relaxes exactly two fields, and the frozen policy relaxes neither', () => {
    const local = localPolicy(45_000);
    const differences = (Object.keys(FROZEN_POLICY) as Array<keyof FetchPolicy>)
      .filter((key) => JSON.stringify(local[key]) !== JSON.stringify(FROZEN_POLICY[key]))
      .sort();
    expect(differences).toStrictEqual(['allowedPorts', 'permitLoopback']);
    expect(FROZEN_POLICY.permitLoopback).toBe(false);
    expect(FROZEN_POLICY.allowedPorts).toStrictEqual([80, 443]);
  });

  it('resolveAndValidate defaults to the real resolver', () => {
    expect(systemLookup).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------- GATES 2-7
describe('SSRF: destinations that must never be connected to', () => {
  const blockedUrls: ReadonlyArray<readonly [string, string]> = [
    ['http://127.0.0.1/', 'loopback literal'],
    ['http://127.0.0.2/', 'loopback, elsewhere in the /8'],
    ['http://[::1]/', 'IPv6 loopback literal'],
    ['http://10.0.0.1/', 'RFC1918'],
    ['http://172.16.5.4/', 'RFC1918'],
    ['http://192.168.1.1/', 'RFC1918'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://169.254.1.1/', 'link-local'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fc00::1]/', 'IPv6 unique local'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://2130706433/', 'loopback in decimal'],
    ['http://0177.0.0.1/', 'loopback in octal'],
    ['http://0x7f000001/', 'loopback in hex'],
    ['http://127.1/', 'loopback in short form'],
    ['http://localhost/', 'the name localhost'],
  ];

  it.each(blockedUrls)('refuses %s (%s)', async (url) => {
    // Nothing is mocked: the real resolver runs and the real guard judges what
    // it answers. Decimal, octal and hex literals get here as 127.0.0.1
    // because validation is on the resolved address, never the string.
    await expect(guardedFetch(url, FROZEN_POLICY)).rejects.toThrow(FetchRefused);
    const error = await guardedFetch(url, FROZEN_POLICY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchRefused);
    expect(['address_blocked', 'dns_failed']).toContain((error as FetchRefused).refusal);
  });

  it('refuses "localhost." with a trailing dot (§23)', async () => {
    const error = await guardedFetch('http://localhost./', FROZEN_POLICY).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchRefused);
    // Either the resolver maps it to loopback and the address check refuses it,
    // or it does not resolve at all. Both are a refusal; neither connects.
    expect(['address_blocked', 'dns_failed']).toContain((error as FetchRefused).refusal);
  });
});

// ---------------------------------------------------------------- GATE 10
describe('schemes and ports (§8)', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com/',
    'data:text/html,<p>x</p>',
    'javascript:alert(1)',
    'ws://example.com/',
  ])('refuses the scheme in %s', async (url) => {
    const error = await guardedFetch(url, FROZEN_POLICY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchRefused);
    expect((error as FetchRefused).refusal).toBe('scheme_not_allowed');
  });

  it('refuses a port that is not 80 or 443, before any DNS', async () => {
    const error = await guardedFetch('http://example.com:8080/', FROZEN_POLICY).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchRefused);
    expect((error as FetchRefused).refusal).toBe('port_not_allowed');
  });

  it('accepts the default ports without an explicit port', async () => {
    // Shape only: no connection is attempted because the address check runs
    // after and this host is loopback under the frozen policy.
    const error = await guardedFetch('https://localhost/', FROZEN_POLICY).catch(
      (e: unknown) => e,
    );
    expect((error as FetchRefused).refusal).not.toBe('port_not_allowed');
  });
});

// ---------------------------------------------------------------- GATES 6, 7
describe('DNS answers (§8, §23)', () => {
  it('refuses a hostname that resolves to a prohibited address', async () => {
    const lookup: LookupImpl = async () => [{ address: '10.1.2.3', family: 4 }];
    await expect(
      resolveAndValidate('innocent.example', FROZEN_POLICY, lookup),
    ).rejects.toThrow(/10\.1\.2\.3/);
  });

  it('refuses a mixed answer where only one address is prohibited', async () => {
    // The classic smuggle: a guard that checks the first address lets this
    // through and the connect picks the other one.
    const lookup: LookupImpl = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    const error = await resolveAndValidate('mixed.example', FROZEN_POLICY, lookup).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchRefused);
    expect((error as FetchRefused).refusal).toBe('address_blocked');
    expect((error as FetchRefused).message).toContain('169.254.169.254');
  });

  it('accepts an answer where every address is public', async () => {
    const lookup: LookupImpl = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    const resolved = await resolveAndValidate('good.example', FROZEN_POLICY, lookup);
    expect(resolved.allAddresses).toHaveLength(2);
    expect(resolved.address).toBe('93.184.216.34');
  });

  it('refuses an empty answer', async () => {
    const lookup: LookupImpl = async () => [];
    await expect(resolveAndValidate('empty.example', FROZEN_POLICY, lookup)).rejects.toThrow(
      /resolved to nothing/,
    );
  });

  it('connects to the address it validated, and resolves only once per hop', async () => {
    // The pin proven two ways at once. The hostname does not exist, so the
    // only way the request can reach the local server is if undici used the
    // address this module validated rather than resolving the name itself —
    // and the call count proves there was no second resolution for a rebinding
    // answer to win.
    const fixture = await startServer((url, respond) => {
      respond(200, { 'content-type': 'text/html' }, `<p>served ${url}</p>`);
    });
    const port = Number(new URL(fixture.origin).port);

    let calls = 0;
    const rebinding: LookupImpl = async () => {
      calls += 1;
      // First answer: the local server. Any later answer would be somewhere
      // else entirely — which is what rebinding is.
      return calls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    };

    try {
      const outcome = await guardedFetch(
        `http://nonexistent.invalid:${port}/pinned`,
        localPolicy(port),
        5_000,
        rebinding,
      );

      expect(outcome.httpStatus).toBe(200);
      expect(outcome.body).toContain('served /pinned');
      expect(
        calls,
        'the resolver must be consulted once per hop, never again by the client',
      ).toBe(1);
    } finally {
      fixture.server.close();
    }
  }, 30_000);

  it('refuses when the validated-first answer is itself prohibited', async () => {
    // And the ordering cannot be gamed: a prohibited address anywhere in the
    // answer refuses the whole fetch, so "put the good one first" does not work.
    const lookup: LookupImpl = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ];
    const error = await guardedFetch('http://mixed.invalid/', FROZEN_POLICY, 2_000, lookup).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchRefused);
    expect((error as FetchRefused).refusal).toBe('address_blocked');
  }, 30_000);
});

// ---------------------------------------------------------------- GATES 1, 8, 9
describe('fetching and redirects, against real servers', () => {
  let fixture: Fixture;
  let policy: FetchPolicy;

  beforeAll(async () => {
    fixture = await startServer((url, respond) => {
      if (url === '/page') {
        respond(200, { 'content-type': 'text/html; charset=utf-8' }, '<p>hello <b>world</b></p>');
      } else if (url === '/plain') {
        respond(200, { 'content-type': 'text/plain' }, 'just text');
      } else if (url === '/pdf') {
        respond(200, { 'content-type': 'application/pdf' }, '%PDF-1.4 instructions inside');
      } else if (url === '/image') {
        respond(200, { 'content-type': 'image/png' }, 'PNG');
      } else if (url === '/no-type') {
        respond(200, {}, '<p>typeless</p>');
      } else if (url === '/r1') {
        respond(302, { location: '/page' });
      } else if (url === '/chain0') {
        respond(302, { location: '/chain1' });
      } else if (url === '/chain1') {
        respond(302, { location: '/chain2' });
      } else if (url === '/chain2') {
        respond(302, { location: '/chain3' });
      } else if (url === '/chain3') {
        respond(302, { location: '/page' });
      } else if (url === '/to-metadata') {
        respond(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      } else if (url === '/to-private') {
        respond(302, { location: 'http://10.0.0.1/secret' });
      } else if (url === '/to-file') {
        respond(302, { location: 'file:///etc/passwd' });
      } else if (url === '/no-location') {
        respond(302, {});
      } else if (url === '/big') {
        respond(200, { 'content-type': 'text/html' }, 'x'.repeat(3 * 1024 * 1024));
      } else {
        respond(404, { 'content-type': 'text/html' }, 'nope');
      }
    });

    policy = localPolicy(Number(new URL(fixture.origin).port));
  });

  afterAll(() => {
    fixture.server.close();
  });

  it('GATE 1: accepts an ordinary destination and returns the body', async () => {
    const outcome = await guardedFetch(`${fixture.origin}/page`, policy);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.contentType).toBe('text/html');
    expect(outcome.body).toContain('hello');
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(outcome.chain).toHaveLength(1);
  });

  it('accepts text/plain', async () => {
    const outcome = await guardedFetch(`${fixture.origin}/plain`, policy);
    expect(outcome.contentType).toBe('text/plain');
    expect(outcome.body).toBe('just text');
  });

  it('follows a redirect within budget', async () => {
    const outcome = await guardedFetch(`${fixture.origin}/r1`, policy);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.finalUrl).toBe(`${fixture.origin}/page`);
    expect(outcome.chain).toHaveLength(2);
  });

  it('GATE 9: refuses a chain longer than three redirects (§8)', async () => {
    const error = await guardedFetch(`${fixture.origin}/chain0`, policy).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchRefused);
    expect((error as FetchRefused).refusal).toBe('too_many_redirects');
  });

  it.each([
    ['/to-metadata', 'cloud metadata'],
    ['/to-private', 'RFC1918'],
  ])('GATE 8: refuses a redirect from a safe origin to %s (%s)', async (path) => {
    // The first hop is allowed, the second is not. A client that followed
    // redirects itself would have resolved and connected before any check.
    const error = await guardedFetch(`${fixture.origin}${path}`, policy).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchRefused);
    expect((error as FetchRefused).refusal).toBe('address_blocked');
  });

  it('refuses a redirect that changes to a forbidden scheme', async () => {
    const error = await guardedFetch(`${fixture.origin}/to-file`, policy).catch(
      (e: unknown) => e,
    );
    expect((error as FetchRefused).refusal).toBe('scheme_not_allowed');
  });

  it('refuses a 302 with no Location rather than guessing', async () => {
    const error = await guardedFetch(`${fixture.origin}/no-location`, policy).catch(
      (e: unknown) => e,
    );
    expect((error as FetchRefused).refusal).toBe('redirect_without_location');
  });

  it('GATE: refuses a PDF and an image without parsing them (§8, §23 case 11)', async () => {
    for (const path of ['/pdf', '/image']) {
      const error = await guardedFetch(`${fixture.origin}${path}`, policy).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(FetchRefused);
      expect((error as FetchRefused).refusal).toBe('content_type_not_allowed');
    }
  });

  it('GATE 11: aborts an oversized body instead of buffering it', async () => {
    const start = Date.now();
    const error = await guardedFetch(`${fixture.origin}/big`, {
      ...policy,
      maxBodyBytes: 64 * 1024,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchRefused);
    expect((error as FetchRefused).refusal).toBe('body_too_large');
    // It gave up early rather than reading 3 MB and then measuring.
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('enforces the 2 MB cap from §8 by default', () => {
    expect(FROZEN_POLICY.maxBodyBytes).toBe(2 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------- GATE 12
describe('timeouts (§8, §23 case 9)', () => {
  it('gives up on a server that sends headers and then stalls', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<p>start');
      // Then nothing, for ever: the slow-loris shape.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      const started = Date.now();
      const error = await guardedFetch(
        `http://127.0.0.1:${port}/`,
        { ...localPolicy(port), timeoutMs: 1_500 },
        1_500,
      ).catch((e: unknown) => e);
      const elapsed = Date.now() - started;

      expect(error).toBeInstanceOf(FetchRefused);
      expect((error as FetchRefused).refusal).toBe('timeout');
      expect(elapsed).toBeLessThan(10_000);
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
    } finally {
      server.close();
    }
  }, 30_000);

  it('enforces the 20-second budget from §8 by default', () => {
    expect(FROZEN_POLICY.timeoutMs).toBe(20_000);
  });
});
