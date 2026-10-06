import { describe, expect, it } from 'vitest';

import {
  backoffSeconds,
  baseBackoffSeconds,
  MAX_BACKOFF_SECONDS,
} from '../../src/jobs/backoff';

/** SPEC.md §6: min(60 * 2^attempts, 3600) seconds with ±20% jitter. */
describe('retry backoff (SPEC.md §6)', () => {
  const noJitter = () => 0.5;

  it('doubles per attempt from 120 seconds', () => {
    expect(backoffSeconds(1, noJitter)).toBe(120);
    expect(backoffSeconds(2, noJitter)).toBe(240);
    expect(backoffSeconds(3, noJitter)).toBe(480);
    expect(backoffSeconds(4, noJitter)).toBe(960);
    expect(backoffSeconds(5, noJitter)).toBe(1920);
  });

  it('caps at one hour', () => {
    expect(backoffSeconds(6, noJitter)).toBe(MAX_BACKOFF_SECONDS);
    expect(backoffSeconds(20, noJitter)).toBe(MAX_BACKOFF_SECONDS);
    expect(baseBackoffSeconds(6)).toBe(3600);
  });

  it('applies ±20% jitter at the extremes of the random source', () => {
    expect(backoffSeconds(1, () => 0)).toBeCloseTo(96, 6); // 120 * 0.8
    expect(backoffSeconds(1, () => 0.999999)).toBeCloseTo(144, 3); // 120 * 1.2
  });

  it('keeps every jittered value inside the band, over the whole range', () => {
    for (let attempts = 1; attempts <= 12; attempts += 1) {
      const base = baseBackoffSeconds(attempts);
      for (let i = 0; i < 200; i += 1) {
        const value = backoffSeconds(attempts, Math.random);
        expect(value).toBeGreaterThanOrEqual(base * 0.8);
        expect(value).toBeLessThanOrEqual(base * 1.2);
      }
    }
  });

  it('spreads retries, which is the reason jitter exists', () => {
    const values = new Set(Array.from({ length: 50 }, () => backoffSeconds(3)));
    expect(values.size).toBeGreaterThan(40);
  });

  it('rejects an attempt number that cannot have failed yet', () => {
    expect(() => backoffSeconds(0)).toThrowError(/positive integer/);
    expect(() => backoffSeconds(-1)).toThrowError(/positive integer/);
    expect(() => backoffSeconds(1.5)).toThrowError(/positive integer/);
  });
});
