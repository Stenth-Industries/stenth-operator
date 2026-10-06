import { describe, expect, it } from 'vitest';

import { adoptTraceId, isTraceId, newTraceId } from '../../src/obs/trace';

describe('trace ids (SPEC.md §16)', () => {
  it('mints a 26-character ULID', () => {
    const id = newTraceId();
    expect(id).toHaveLength(26);
    expect(isTraceId(id)).toBe(true);
  });

  it('mints distinct ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTraceId()));
    expect(ids.size).toBe(500);
  });

  it('adopts a well-formed inbound id', () => {
    const inbound = newTraceId();
    expect(adoptTraceId(inbound)).toBe(inbound);
  });

  it('mints a fresh id rather than trusting arbitrary inbound text', () => {
    for (const hostile of ['', '../../etc/passwd', 'not-a-ulid', null, undefined]) {
      const adopted = adoptTraceId(hostile);
      expect(isTraceId(adopted)).toBe(true);
      expect(adopted).not.toBe(hostile);
    }
  });
});
