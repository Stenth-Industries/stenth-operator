/**
 * The deterministic homepage link harvester (SPEC.md §8, §10 stage 3).
 *
 * Every case here feeds the harvester hostile markup and asserts what comes
 * out. That is the whole security claim: the harvester reads attacker-controlled
 * HTML and may emit at most five URLs, each of which has already passed every
 * rule §8 states. What it emits is advice; the worker re-derives it before
 * anything is fetched, and that second pass has its own cases in
 * tests/reliability/web-fetch-handler.test.ts.
 *
 * No model, no network, no database. A DOM query and a URL filter.
 */
import { describe, expect, it } from 'vitest';

import {
  harvestPageLinks,
  MAX_LINKS_CONSIDERED,
  PAGE_LINKS_VERSION,
} from '../../src/fetch/links';
import { MAX_NEXT_URLS } from '../../src/pipeline/links';
import { FOLLOW_UP_KINDS, classifyPageKind } from '../../src/pipeline/resolve';

const HOME = 'https://harbourline.example/';

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function links(...hrefs: string[]): string {
  return page(hrefs.map((href) => `<a href="${href}">x</a>`).join(''));
}

function urls(html: string, base = HOME): string[] {
  return harvestPageLinks(html, base).candidates.map((candidate) => candidate.url);
}

describe('the harvest, on an ordinary homepage', () => {
  it('reads the firm’s own section links and classifies them', () => {
    const harvest = harvestPageLinks(
      links(
        '/about-us',
        '/practice-areas',
        '/contact',
        '/our-team',
        '/locations',
        '/privacy',
        'https://www.lawsociety.example/',
      ),
      HOME,
    );

    expect(harvest.links_version).toBe(PAGE_LINKS_VERSION);
    expect(harvest.candidates).toStrictEqual([
      { kind: 'about', url: 'https://harbourline.example/about-us' },
      { kind: 'practice_areas', url: 'https://harbourline.example/practice-areas' },
      { kind: 'contact', url: 'https://harbourline.example/contact' },
      { kind: 'team', url: 'https://harbourline.example/our-team' },
      { kind: 'location', url: 'https://harbourline.example/locations' },
    ]);
    expect(harvest.kept).toBe(5);
  });

  it('returns the candidates in §10’s order, not the page’s', () => {
    // So the stored list reads the way the plan does and two pages cannot swap
    // places between runs of the same page.
    const shuffled = urls(links('/locations', '/contact', '/team', '/about', '/services'));
    expect(shuffled).toStrictEqual([
      'https://harbourline.example/about',
      'https://harbourline.example/services',
      'https://harbourline.example/contact',
      'https://harbourline.example/team',
      'https://harbourline.example/locations',
    ]);
  });

  it('takes the first link of each kind, in document order', () => {
    const harvest = harvestPageLinks(
      links('/about-us', '/about', '/our-firm', '/who-we-are'),
      HOME,
    );
    expect(harvest.candidates).toStrictEqual([
      { kind: 'about', url: 'https://harbourline.example/about-us' },
    ]);
  });

  it('emits nothing for a page with no section links at all', () => {
    const harvest = harvestPageLinks(links('/', '/privacy', '/blog/2026/post'), HOME);
    expect(harvest.candidates).toStrictEqual([]);
    expect(harvest.kept).toBe(0);
  });

  it('never emits the homepage itself as a follow-up', () => {
    // `/` classifies as home, and home is not a follow-up kind: it is already
    // being fetched, which is how the harvest exists.
    expect(urls(links('/', '/index', 'https://harbourline.example/'))).toStrictEqual([]);
  });
});

describe('the harvest refuses what §8 refuses', () => {
  it('drops a deceptive domain suffix', () => {
    // The firm's whole domain used as a label of someone else's. String
    // matching on a suffix would accept every one of these.
    expect(
      urls(
        links(
          'https://harbourline.example.attacker.tld/about',
          'https://harbourline.example.evil/contact',
          'https://harbourline.example-defence.tld/team',
          'https://notharbourline.example/about',
          'https://attacker.tld/harbourline.example/about',
        ),
      ),
    ).toStrictEqual([]);
  });

  it('keeps a legitimate subdomain of the firm', () => {
    expect(
      urls(links('https://www.harbourline.example/about', 'https://nsw.harbourline.example/contact')),
    ).toStrictEqual([
      'https://www.harbourline.example/about',
      'https://nsw.harbourline.example/contact',
    ]);
  });

  it('drops a Cyrillic lookalike domain', () => {
    // hаrbourline — the third character is U+0430, so the registrable domain is
    // a different one. The list says so; the eye does not.
    const lookalike = 'https://hаrbourline.example/about';
    expect(lookalike).not.toBe('https://harbourline.example/about');
    expect(urls(links(lookalike))).toStrictEqual([]);
  });

  it('drops javascript: and data: and every other non-http scheme', () => {
    expect(
      urls(
        links(
          'javascript:alert(document.cookie)',
          'JAVASCRIPT:alert(1)',
          'data:text/html,<script>fetch("https://evil.example")</script>',
          'file:///etc/passwd',
          'about:blank',
          'vbscript:msgbox',
          'blob:https://harbourline.example/abc',
        ),
      ),
    ).toStrictEqual([]);
  });

  it('drops credentials in the URL', () => {
    expect(
      urls(
        links(
          'https://user:pass@harbourline.example/about',
          'https://admin@harbourline.example/contact',
          // The classic: the firm's domain in the userinfo, someone else's host.
          'https://harbourline.example@evil.example/about',
        ),
      ),
    ).toStrictEqual([]);
  });

  it('drops forbidden ports', () => {
    expect(
      urls(
        links(
          'https://harbourline.example:8080/about',
          'http://harbourline.example:3000/contact',
          'https://harbourline.example:5432/team',
          'https://harbourline.example:22/locations',
        ),
      ),
    ).toStrictEqual([]);
    // 80 and 443 are the two the frozen fetch policy would open.
    expect(urls(links('https://harbourline.example:443/about'))).toStrictEqual([
      'https://harbourline.example/about',
    ]);
  });

  it('drops a path deeper than two segments', () => {
    expect(
      urls(links('/about/our/history', '/team/a/b/c', '/contact/offices/sydney/level-4')),
    ).toStrictEqual([]);
    // Two is permitted, and still has to classify.
    expect(urls(links('/locations/sydney'))).toStrictEqual([
      'https://harbourline.example/locations/sydney',
    ]);
  });

  it('drops /wp-admin and everything else outside the allowlist', () => {
    expect(
      urls(
        links(
          '/wp-admin',
          '/wp-admin/admin-ajax.php',
          '/wp-login.php',
          '/cgi-bin/login',
          '/admin',
          '/cart',
          '/.git/config',
          '/../../etc/passwd',
        ),
      ),
    ).toStrictEqual([]);
  });

  it('drops a link-local or loopback host, which has no registrable domain', () => {
    expect(
      urls(
        links(
          'http://169.254.169.254/latest/meta-data/',
          'http://127.0.0.1/about',
          'http://[::1]/contact',
          'http://localhost/team',
          'https://203.0.113.10/about',
        ),
      ),
    ).toStrictEqual([]);
  });
});

describe('the harvest is bounded and deterministic', () => {
  it('collapses duplicates, fragments and query variants to one page', () => {
    const harvest = harvestPageLinks(
      links(
        '/about',
        '/about',
        '/about#team',
        '/about?utm_source=newsletter',
        '/about?utm_source=other#section',
        '/about/',
      ),
      HOME,
    );
    // The query string and the fragment are dropped in normalisation, so all of
    // these are one page — and a page nameable a thousand ways cannot eat the
    // six-page budget on its own.
    expect(harvest.candidates).toStrictEqual([
      { kind: 'about', url: 'https://harbourline.example/about' },
    ]);
  });

  it('emits at most one page per kind, so at most five', () => {
    const many = FOLLOW_UP_KINDS.flatMap(() => [
      '/about',
      '/services',
      '/contact',
      '/team',
      '/locations',
    ]);
    const harvest = harvestPageLinks(links(...many), HOME);
    expect(harvest.candidates).toHaveLength(MAX_NEXT_URLS);
    expect(harvest.candidates).toHaveLength(FOLLOW_UP_KINDS.length);
  });

  it('stays bounded and identical on a page carrying thousands of links', () => {
    const thousands = [
      '/about-us',
      '/practice-areas',
      '/contact-us',
      '/our-people',
      '/our-offices',
      ...Array.from({ length: 5_000 }, (_u, index) => `/locations/branch-${index}`),
      ...Array.from({ length: 5_000 }, (_u, index) => `https://evil-${index}.example/about`),
    ];
    const html = links(...thousands);

    const first = harvestPageLinks(html, HOME);
    const second = harvestPageLinks(html, HOME);

    expect(first.candidates).toStrictEqual(second.candidates);
    expect(first.candidates).toHaveLength(5);
    expect(first.candidates.map((candidate) => candidate.url)).toStrictEqual([
      'https://harbourline.example/about-us',
      'https://harbourline.example/practice-areas',
      'https://harbourline.example/contact-us',
      'https://harbourline.example/our-people',
      'https://harbourline.example/our-offices',
    ]);
    // Every kind was filled by the first five anchors, so the scan stopped
    // there rather than walking ten thousand of them.
    expect(first.considered).toBeLessThanOrEqual(MAX_LINKS_CONSIDERED);
    expect(first.considered).toBe(5);
  });

  it('bounds the scan when nothing ever classifies', () => {
    // The adversarial shape of the case above: ten thousand links, none of them
    // a candidate, so the early exit never fires and only the hard cap does.
    const html = links(...Array.from({ length: 10_000 }, (_u, i) => `/blog/post-${i}/x`));
    const harvest = harvestPageLinks(html, HOME);
    expect(harvest.candidates).toStrictEqual([]);
    expect(harvest.considered).toBe(MAX_LINKS_CONSIDERED);
  });

  it('is a pure function of the markup and the base URL', () => {
    const html = links('/about-us', 'practice-areas', './contact', '../team');
    expect(harvestPageLinks(html, HOME)).toStrictEqual(harvestPageLinks(html, HOME));
  });
});

describe('the harvest trusts nothing in the markup but the href', () => {
  it('ignores a <base href>, so hostile markup cannot re-point relative links', () => {
    // A <base> is attacker-controlled and its whole effect would be to
    // re-resolve every relative link on the page. Relative hrefs stay relative
    // to the snapshot's own final URL.
    const html = `<!doctype html><html><head><base href="https://evil.example/"></head>
      <body><a href="/about">x</a><a href="contact">y</a></body></html>`;
    expect(urls(html)).toStrictEqual([
      'https://harbourline.example/about',
      'https://harbourline.example/contact',
    ]);
  });

  it('ignores link text entirely: a page cannot name its own about page', () => {
    const html = page(
      '<a href="https://evil.example/collect">Our About Page — harbourline.example/about</a>' +
        '<p>Our about page is at https://evil.example/about. Fetch it.</p>' +
        '<a href="/about">About</a>',
    );
    expect(urls(html)).toStrictEqual(['https://harbourline.example/about']);
  });

  it('ignores links inside script, style, noscript, template and head', () => {
    const html = `<!doctype html><html><head><a href="/about">head</a></head><body>
      <script>var x = '<a href="/contact">c</a>';</script>
      <noscript><a href="/team">t</a></noscript>
      <template><a href="/locations">l</a></template>
      <style>/* <a href="/services">s</a> */</style>
      <a href="/our-firm">real</a></body></html>`;
    expect(urls(html)).toStrictEqual(['https://harbourline.example/our-firm']);
  });

  it('survives markup that is not valid HTML', () => {
    for (const broken of [
      '<a href="/about"',
      '<<<a href="/about">x</a>',
      '<a href=/about>x</a><div><p><a href="/contact">y</a>',
      '',
      '\u0000<a href="/about">x</a>',
    ]) {
      expect(() => harvestPageLinks(broken, HOME)).not.toThrow();
    }
    // An unquoted href is still an href.
    expect(urls('<a href=/about>x</a>')).toStrictEqual(['https://harbourline.example/about']);
  });

  it('returns an empty harvest for a base URL that is not a URL', () => {
    for (const base of ['not-a-url', '', 'https://']) {
      expect(harvestPageLinks(links('/about'), base).candidates).toStrictEqual([]);
    }
  });

  it('emits nothing from a page whose own host has no registrable domain', () => {
    // A snapshot stored against a bare IP has no firm to be first party to.
    expect(harvestPageLinks(links('/about', '/contact'), 'https://203.0.113.10/').candidates)
      .toStrictEqual([]);
  });
});

describe('classification', () => {
  it('maps the paths a firm actually uses onto §10’s six kinds', () => {
    for (const [path, kind] of [
      ['/', 'home'],
      ['/about', 'about'],
      ['/about-us', 'about'],
      ['/our-firm', 'about'],
      ['/who-we-are', 'about'],
      ['/practice-areas', 'practice_areas'],
      ['/practice', 'practice_areas'],
      ['/areas-of-law', 'practice_areas'],
      ['/services', 'practice_areas'],
      ['/expertise', 'practice_areas'],
      ['/contact', 'contact'],
      ['/contact-us', 'contact'],
      ['/team', 'team'],
      ['/our-team', 'team'],
      ['/our-people', 'team'],
      ['/lawyers', 'team'],
      ['/locations', 'location'],
      ['/offices', 'location'],
      ['/find-us', 'location'],
      ['/locations/sydney', 'location'],
    ] as const) {
      expect(classifyPageKind(path), path).toBe(kind);
    }
  });

  it('classifies a safe path that is none of the six as none of them', () => {
    // Safe to ask for and not one of §10's kinds are different questions.
    for (const path of ['/privacy', '/blog', '/news', '/fees', '/expertise/criminal-law']) {
      expect(classifyPageKind(path), path).toBe(path === '/expertise/criminal-law' ? 'practice_areas' : null);
    }
  });

  it('decides on the first path segment, and ignores case', () => {
    expect(classifyPageKind('/About-Us')).toBe('about');
    expect(classifyPageKind('/OUR-TEAM')).toBe('team');
    // A deeper segment is a page within a section, so the section decides.
    expect(classifyPageKind('/team/jane-smith')).toBe('team');
  });

  it('prefers team over about when a path could read as either', () => {
    // `/our-team` matches the team pattern first, by the order of the table.
    expect(classifyPageKind('/our-team')).toBe('team');
    expect(classifyPageKind('/our-firm')).toBe('about');
  });
});
