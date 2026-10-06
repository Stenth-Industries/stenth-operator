import { describe, expect, it } from 'vitest';

import { REDACTED, scrubString, scrubValue } from '../../src/obs/log';

describe('log redaction (SPEC.md §17)', () => {
  it('redacts a Bearer header', () => {
    const scrubbed = scrubString(
      'authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
    );
    expect(scrubbed).toBe(`authorization: Bearer ${REDACTED}`);
  });

  it('redacts credentials inside a connection string', () => {
    expect(
      scrubString('connecting to postgresql://operator_app:s3cr3t-pw@postgres:5432/operator'),
    ).toBe(`connecting to postgresql://operator_app:${REDACTED}@postgres:5432/operator`);
  });

  it('redacts provider-prefixed keys', () => {
    expect(scrubString('key sk-ant-api03-AAAAbbbbCCCCdddd1234')).toContain(REDACTED);
    expect(scrubString('key AIzaSyA1234567890abcdefg')).toContain(REDACTED);
    expect(scrubString('key tskey-auth-abcdef1234567890')).toContain(REDACTED);
  });

  it('redacts secret-shaped assignments whatever the value looks like', () => {
    expect(scrubString('password=hunter2')).toBe(`password=${REDACTED}`);
    expect(scrubString('FETCHER_SHARED_SECRET: abc')).toContain(REDACTED);
    expect(scrubString('api_key="short"')).toContain(REDACTED);
  });

  it('redacts a long mixed-case token', () => {
    const token = 'aB3'.repeat(20);
    expect(scrubString(`value ${token}`)).toBe(`value ${REDACTED}`);
  });

  it('spares the identifiers that legitimately appear in logs', () => {
    // A lower-case hex content hash (§4) and an upper-case ULID trace id (§16).
    const contentHash = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
    const traceId = '01JA2BCDEFGHJKMNPQRSTVWXYZ';
    expect(scrubString(contentHash)).toBe(contentHash);
    expect(scrubString(traceId)).toBe(traceId);
    expect(scrubString('fetching https://example.com.au/about')).toBe(
      'fetching https://example.com.au/about',
    );
  });

  it('replaces secret-named object keys outright', () => {
    const scrubbed = scrubValue({
      DATABASE_URL: 'postgresql://u:p@h/db',
      authorization: 'Bearer abc',
      password_hash: '$argon2id$v=19$m=65536,t=3,p=4$abc',
      company: 'Example Legal',
    }) as Record<string, unknown>;

    expect(scrubbed.DATABASE_URL).toBe(REDACTED);
    expect(scrubbed.authorization).toBe(REDACTED);
    expect(scrubbed.password_hash).toBe(REDACTED);
    expect(scrubbed.company).toBe('Example Legal');
  });

  it('scrubs nested values and survives a cycle', () => {
    const node: Record<string, unknown> = { token: 'abc' };
    node.self = node;
    const scrubbed = scrubValue({ outer: node }) as Record<string, Record<string, unknown>>;
    expect(scrubbed.outer?.token).toBe(REDACTED);
    expect(scrubbed.outer?.self).toBe('[circular]');
  });

  it('scrubs an error message and keeps the shape', () => {
    const scrubbed = scrubValue(
      new Error('connect failed for postgresql://operator_app:pw123@db/operator'),
    ) as Record<string, unknown>;
    expect(String(scrubbed.message)).toContain(REDACTED);
    expect(scrubbed.type).toBe('Error');
  });
});

describe('trace_id appears exactly once per line (SPEC.md §16)', () => {
  function capture(): { lines: string[]; stream: { write(chunk: string): void } } {
    const lines: string[] = [];
    return {
      lines,
      stream: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    };
  }

  it('emits one trace_id, the request’s, on a child line', async () => {
    const { createTestLogger } = await import('../../src/obs/log');
    const sink = capture();
    const base = createTestLogger(sink.stream);
    base.level = 'info';

    base.child({ trace_id: '01JA2BCDEFGHJKMNPQRSTVWXYZ' }).info({ queue_depth: 0 }, 'health ok');

    const line = sink.lines[0] ?? '';
    // JSON.parse would hide a duplicate by keeping the last value, so the
    // assertion is on the raw line: grep by trace id has to be unambiguous.
    expect(line.match(/"trace_id"/g)).toHaveLength(1);
    expect(line).toContain('"trace_id":"01JA2BCDEFGHJKMNPQRSTVWXYZ"');
    expect(line).toContain('"service":"test"');
  });

  it('still scrubs secrets when writing through a child', async () => {
    const { createTestLogger } = await import('../../src/obs/log');
    const sink = capture();
    const base = createTestLogger(sink.stream);
    base.level = 'info';

    base
      .child({ trace_id: '01JA2BCDEFGHJKMNPQRSTVWXYZ' })
      .info({ DATABASE_URL: 'postgresql://u:p@h/db' }, 'connected with Bearer abc123TOKENvalue');

    const line = sink.lines[0] ?? '';
    expect(line).toContain(REDACTED);
    expect(line).not.toContain('postgresql://u:p@h/db');
  });
});
