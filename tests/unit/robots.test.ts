import { describe, expect, it } from 'vitest';

import { decide, parseRobots } from '../../src/fetch/robots';
import { USER_AGENT } from '../../src/fetch/policy';

const allowed = (body: string, path: string) =>
  decide(parseRobots(body), path, USER_AGENT).allowed;

describe('robots.txt parsing and matching (SPEC.md §8, §15)', () => {
  it('allows everything when the file is empty or absent', () => {
    expect(allowed('', '/about')).toBe(true);
    expect(allowed('# just a comment\n', '/about')).toBe(true);
  });

  it('honours a wildcard Disallow', () => {
    const body = 'User-agent: *\nDisallow: /private\n';
    expect(allowed(body, '/private')).toBe(false);
    expect(allowed(body, '/private/deep')).toBe(false);
    expect(allowed(body, '/about')).toBe(true);
  });

  it('treats an empty Disallow as allow-all, as the standard does', () => {
    expect(allowed('User-agent: *\nDisallow:\n', '/anything')).toBe(true);
  });

  it('refuses everything under Disallow: /', () => {
    expect(allowed('User-agent: *\nDisallow: /\n', '/')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /\n', '/about')).toBe(false);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    const body = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public\n';
    expect(allowed(body, '/docs/private')).toBe(false);
    expect(allowed(body, '/docs/public/x')).toBe(true);
  });

  it('supports the * and $ wildcards', () => {
    expect(allowed('User-agent: *\nDisallow: /*.pdf$\n', '/files/report.pdf')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /*.pdf$\n', '/files/report.pdf.html')).toBe(true);
    expect(allowed('User-agent: *\nDisallow: /a/*/c\n', '/a/b/c')).toBe(false);
  });

  it('prefers a group naming our agent over the wildcard', () => {
    const body = [
      'User-agent: *', 'Disallow: /', '',
      'User-agent: StenthOperator', 'Disallow: /members', '',
    ].join('\n');
    expect(allowed(body, '/about')).toBe(true);
    expect(allowed(body, '/members')).toBe(false);
  });

  it('shares one group across consecutive User-agent lines', () => {
    const body = 'User-agent: a\nUser-agent: *\nDisallow: /x\n';
    expect(allowed(body, '/x')).toBe(false);
  });

  it('reads Crawl-delay, which politeness then honours (§6)', () => {
    const decision = decide(parseRobots('User-agent: *\nCrawl-delay: 7\n'), '/', USER_AGENT);
    expect(decision.crawlDelaySeconds).toBe(7);
  });

  it('ignores a nonsensical Crawl-delay rather than trusting it', () => {
    expect(
      decide(parseRobots('User-agent: *\nCrawl-delay: later\n'), '/', USER_AGENT)
        .crawlDelaySeconds,
    ).toBeUndefined();
    expect(
      decide(parseRobots('User-agent: *\nCrawl-delay: -5\n'), '/', USER_AGENT)
        .crawlDelaySeconds,
    ).toBeUndefined();
  });

  it('ignores comments, blank lines, case and stray whitespace', () => {
    const body = '  USER-AGENT:  *  \n  disallow:  /Private  # trailing\n';
    expect(allowed(body, '/Private')).toBe(false);
  });

  it('survives a hostile or malformed file without throwing', () => {
    for (const body of [
      'Disallow: /x',                       // a rule with no group
      'User-agent:\nDisallow: /x',          // an empty agent
      'x'.repeat(100_000),                  // junk
      'User-agent: *\nDisallow: /[(*+',     // regex metacharacters in a path
      '\u0000\u0001User-agent: *',
    ]) {
      expect(() => parseRobots(body)).not.toThrow();
      expect(() => decide(parseRobots(body), '/about', USER_AGENT)).not.toThrow();
    }
  });

  it('does not let a path pattern become a regex injection', () => {
    // "/[(*+" is not a valid expression; escaping means it matches literally.
    const body = 'User-agent: *\nDisallow: /[(*+\n';
    expect(allowed(body, '/about')).toBe(true);
  });

  it('matches against the path with its query string', () => {
    const body = 'User-agent: *\nDisallow: /search?\n';
    expect(allowed(body, '/search?q=x')).toBe(false);
    expect(allowed(body, '/searching')).toBe(true);
  });

  it('reports which rule decided, for the fetch log', () => {
    const decision = decide(parseRobots('User-agent: *\nDisallow: /private\n'), '/private', USER_AGENT);
    expect(decision.matchedRule).toBe('Disallow: /private');
  });
});
