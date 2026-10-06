import { describe, expect, it } from 'vitest';

import {
  BLOCKED_IPV4,
  BLOCKED_IPV6,
  classifyAddress,
} from '../../src/fetch/ssrf';
import { FROZEN_POLICY } from '../../src/fetch/policy';

/**
 * SPEC.md §23: "A separate SSRF suite is table-driven over private ranges,
 * redirect-to-private, double-resolution rebinding, IPv6 forms, 0.0.0.0,
 * decimal and octal IP encodings, and localhost. with a trailing dot."
 *
 * The encodings and the trailing dot are resolver behaviour, so they are
 * exercised in tests/reliability/fetch.test.ts against a real resolver. This
 * file is the address table.
 */
describe('the §8 ranges are all present and attributed', () => {
  it('blocks every IPv4 range §8 names', () => {
    const spec = BLOCKED_IPV4.filter((r) => r.source === 'spec').map((r) => r.cidr);
    expect(spec).toContain('10.0.0.0/8');
    expect(spec).toContain('172.16.0.0/12');
    expect(spec).toContain('192.168.0.0/16');
    expect(spec).toContain('127.0.0.0/8');
    expect(spec).toContain('169.254.0.0/16');
  });

  it('blocks every IPv6 range §8 names', () => {
    const spec = BLOCKED_IPV6.filter((r) => r.source === 'spec').map((r) => r.cidr);
    expect(spec).toContain('::1/128');
    expect(spec).toContain('fc00::/7');
  });

  it('marks every range beyond §8 as an addition, with a reason', () => {
    for (const range of [...BLOCKED_IPV4, ...BLOCKED_IPV6]) {
      expect(range.why.length).toBeGreaterThan(5);
      expect(['spec', 'same-class']).toContain(range.source);
    }
    // fe80::/10 is the one the spec omits and the threat model demands.
    const v6 = BLOCKED_IPV6.find((r) => r.cidr === 'fe80::/10');
    expect(v6?.source).toBe('same-class');
  });
});

describe('addresses that must be refused', () => {
  const blocked: ReadonlyArray<readonly [string, string]> = [
    // loopback
    ['127.0.0.1', 'loopback'],
    ['127.0.0.2', 'loopback, the whole /8'],
    ['127.1.2.3', 'loopback, the whole /8'],
    // RFC1918
    ['10.0.0.1', 'RFC1918'],
    ['10.255.255.255', 'RFC1918 upper bound'],
    ['172.16.0.1', 'RFC1918'],
    ['172.31.255.255', 'RFC1918 upper bound'],
    ['192.168.0.1', 'RFC1918'],
    ['192.168.255.255', 'RFC1918 upper bound'],
    // link-local and cloud metadata
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'the cloud metadata service'],
    // unspecified / broadcast / multicast / reserved
    ['0.0.0.0', 'unspecified, named in §23'],
    ['0.1.2.3', '0.0.0.0/8'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['100.64.0.1', 'carrier NAT'],
    ['198.18.0.1', 'benchmarking'],
    // IPv6
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fc00::1', 'unique local'],
    ['fd12:3456:789a::1', 'unique local, the fd half of fc00::/7'],
    ['fe80::1', 'IPv6 link-local'],
    ['fe80::1%eth0', 'IPv6 link-local with a zone index'],
    ['ff02::1', 'IPv6 multicast'],
    // IPv4 smuggled inside IPv6
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped RFC1918'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['64:ff9b::127.0.0.1', 'NAT64-embedded loopback'],
    ['0:0:0:0:0:ffff:7f00:1', 'IPv4-mapped loopback written in full'],
  ];

  it.each(blocked)('refuses %s (%s)', (address) => {
    const verdict = classifyAddress(address);
    expect(verdict.allowed, `${address} should be blocked`).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });
});

describe('addresses that must be allowed', () => {
  const allowed: readonly string[] = [
    '1.1.1.1',
    '8.8.8.8',
    '203.0.113.9',
    '13.237.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:1.1.1.1',
  ];

  it.each(allowed)('allows %s', (address) => {
    const verdict = classifyAddress(address);
    expect(verdict.allowed, `${address} should be allowed: ${verdict.reason ?? ''}`).toBe(true);
  });
});

describe('malformed input is refused, never waved through', () => {
  it.each([
    'not-an-ip',
    'localhost',
    'example.com',
    '',
    '999.999.999.999',
    '10.0.0',
    '1.2.3.4.5',
    'fe80:::1',
  ])('refuses %s', (value) => {
    expect(classifyAddress(value).allowed).toBe(false);
  });
});

describe('the frozen policy carries the §8 numbers', () => {
  it('matches §8 exactly', () => {
    expect(FROZEN_POLICY.allowedSchemes).toStrictEqual(['http:', 'https:']);
    expect(FROZEN_POLICY.allowedPorts).toStrictEqual([80, 443]);
    expect(FROZEN_POLICY.maxRedirects).toBe(3);
    expect(FROZEN_POLICY.maxBodyBytes).toBe(2 * 1024 * 1024);
    expect(FROZEN_POLICY.timeoutMs).toBe(20_000);
    expect(FROZEN_POLICY.allowedContentTypes).toStrictEqual(['text/html', 'text/plain']);
    expect(FROZEN_POLICY.minHostIntervalMs).toBe(2_000);
    expect(FROZEN_POLICY.robotsTtlMs).toBe(24 * 60 * 60 * 1_000);
  });

  it('identifies itself with a contact URL (§8)', () => {
    expect(FROZEN_POLICY.userAgent).toMatch(/https?:\/\//);
    expect(FROZEN_POLICY.userAgent).toContain('Stenth');
  });

  it('never permits loopback, which is the one switch tests may flip', () => {
    expect(FROZEN_POLICY.permitLoopback).toBe(false);
  });

  it('is frozen, so nothing can relax it at runtime', () => {
    expect(Object.isFrozen(FROZEN_POLICY)).toBe(true);
    expect(() => {
      (FROZEN_POLICY as { maxRedirects: number }).maxRedirects = 99;
    }).toThrow();
  });
});
