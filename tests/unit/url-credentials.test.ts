import { describe, expect, it } from 'vitest';

import { assertAllowedUrl, FetchRefused } from '../../src/fetch/http';
import { FROZEN_POLICY } from '../../src/fetch/policy';

/**
 * A job-controlled URL must not be able to introduce credentials.
 *
 * Refused before any network request: assertAllowedUrl runs before DNS, before
 * robots.txt and before any connection, and it runs again on every redirect
 * hop.
 */
describe('URLs carrying userinfo credentials are refused (security addendum item 1)', () => {
  const refused: readonly string[] = [
    'http://user:pass@example.com/',
    'https://user@example.com/',
    'https://user:pass@example.com.au/about',
    'http://:pass@example.com/',
    'http://admin:admin@example.com:80/',
    'https://token%40here:secret@example.com/',
    // On a redirect target too, which re-enters the same check.
    'https://user:pass@example.com/redirected',
  ];

  it.each(refused)('refuses %s', (url) => {
    const error = (() => {
      try {
        assertAllowedUrl(new URL(url), FROZEN_POLICY);
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(error, `${url} was accepted`).toBeInstanceOf(FetchRefused);
    expect((error as FetchRefused).refusal).toBe('url_has_credentials');
  });

  it('is refused before the scheme and port checks, so order cannot hide it', () => {
    // A forbidden port AND credentials: credentials win, which proves the
    // check is not reachable only on an otherwise-valid URL.
    const error = (() => {
      try {
        assertAllowedUrl(new URL('http://user:pass@example.com:8080/'), FROZEN_POLICY);
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();
    expect((error as FetchRefused).refusal).toBe('url_has_credentials');
  });

  it('does not put the credential in the error it reports', () => {
    // The refusal is logged, so it must not be the thing that leaks the secret.
    const error = (() => {
      try {
        assertAllowedUrl(new URL('http://user:sup3rs3cret@example.com/x'), FROZEN_POLICY);
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();
    const refusal = error as FetchRefused;
    expect(refusal.message).not.toContain('sup3rs3cret');
    expect(refusal.url ?? '').not.toContain('sup3rs3cret');
    expect(refusal.url ?? '').not.toContain('user');
    expect(refusal.url).toBe('http://example.com/x');
  });

  it('still accepts an ordinary URL with no userinfo', () => {
    expect(() => assertAllowedUrl(new URL('https://example.com.au/about'), FROZEN_POLICY)).not.toThrow();
    // A colon in the path or query is not userinfo.
    expect(() =>
      assertAllowedUrl(new URL('https://example.com.au/a:b?q=x:y'), FROZEN_POLICY),
    ).not.toThrow();
  });
});
