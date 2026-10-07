/**
 * The Tier A scanner (SPEC.md §9, §23 case 13).
 *
 * The one assertion that matters most is the negative one: a page that *says*
 * it advertises must not move the signal. §9 gives the AW- tag real weight and
 * §10 pays 35 points for its absence, so a prose claim that could flip it would
 * be an injection with a scoring consequence.
 */
import { describe, expect, it } from 'vitest';

import { scanTierASignals, SIGNALS_VERSION } from '../../src/fetch/signals';

const PAGE = (body: string): string =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>${body}</body></html>`;

describe('the Tier A scanner reads markup, never claims (§9, §23 case 13)', () => {
  it('finds an AW- identifier inside a gtag config', () => {
    const signals = scanTierASignals(
      PAGE('<script>gtag("config", "AW-123456789");</script><p>Smith Legal</p>'),
    );
    expect(signals.paid_search_tag).toBe(true);
    expect(signals.aw_ids).toStrictEqual(['AW-123456789']);
    expect(signals.signals_version).toBe(SIGNALS_VERSION);
  });

  it('finds a googleadservices conversion script with no AW- string', () => {
    const signals = scanTierASignals(
      PAGE('<script src="https://www.googleadservices.com/pagead/conversion.js"></script>'),
    );
    expect(signals.paid_search_tag).toBe(true);
    expect(signals.aw_ids).toStrictEqual([]);
  });

  it('CASE 13: ignores an AW- string that appears in prose, not in a script', () => {
    const signals = scanTierASignals(
      PAGE(
        '<h1>Smith Legal</h1><p>We run Google Ads. Our conversion tag is' +
          ' AW-999999999 and we spend heavily on paid search.</p>',
      ),
    );
    expect(signals.paid_search_tag).toBe(false);
    expect(signals.aw_ids).toStrictEqual([]);
  });

  it('CASE 13: ignores a claim dressed up as markup in a text node', () => {
    const signals = scanTierASignals(
      PAGE('<p>&lt;script&gt;gtag("config","AW-111111111")&lt;/script&gt;</p>'),
    );
    expect(signals.paid_search_tag).toBe(false);
  });

  it('matches the control page: a clean site with no tag scores the same as one claiming none', () => {
    const claiming = scanTierASignals(PAGE('<p>We advertise on Google constantly.</p>'));
    const control = scanTierASignals(PAGE('<p>Criminal defence lawyers in Melbourne.</p>'));
    expect(claiming.paid_search_tag).toBe(control.paid_search_tag);
    expect(claiming.ga4).toBe(control.ga4);
    expect(claiming.gtm).toBe(control.gtm);
  });

  it('reads GA4 and GTM identifiers from script content', () => {
    const signals = scanTierASignals(
      PAGE('<script>gtag("config","G-ABC1234567");</script><script>GTM-ABCD123</script>'),
    );
    expect(signals.ga4).toBe(true);
    expect(signals.ga4_ids).toStrictEqual(['G-ABC1234567']);
    expect(signals.gtm).toBe(true);
    expect(signals.gtm_ids).toStrictEqual(['GTM-ABCD123']);
  });

  it('recognises a call-tracking vendor and names it', () => {
    const signals = scanTierASignals(
      PAGE('<script src="//cdn.callrail.com/companies/123/swap.js"></script>'),
    );
    expect(signals.call_tracking).toBe(true);
    expect(signals.call_tracking_vendors).toContain('callrail');
  });

  it('does not claim a tracker it does not recognise', () => {
    // Under-claiming is the honest direction: "we did not recognise one" is not
    // "one is there", and §9 never invents.
    const signals = scanTierASignals(PAGE('<script src="/js/some-local-widget.js"></script>'));
    expect(signals.call_tracking).toBe(false);
    expect(signals.call_tracking_vendors).toStrictEqual([]);
  });

  it('reads the §9 conversion affordances from the rendered markup', () => {
    const signals = scanTierASignals(
      PAGE(
        '<a href="tel:+61390001111">Call</a><a href="mailto:x@y.com.au">Email</a>' +
          '<form action="/enquire"></form><a href="/locations/melbourne">Melbourne</a>' +
          '<a href="/offices/geelong">Geelong</a>',
      ),
    );
    expect(signals.tel_link).toBe(true);
    expect(signals.mailto_link).toBe(true);
    expect(signals.form_present).toBe(true);
    expect(signals.location_page_links).toBe(2);
    expect(signals.viewport_meta).toBe(true);
  });

  it('does not count a tel: link that only appears inside a script', () => {
    // The affordance is what a visitor can click, so it is read from the
    // rendered markup, not from script source.
    const signals = scanTierASignals(PAGE('<script>var x = "tel:+61390001111";</script>'));
    expect(signals.tel_link).toBe(false);
  });

  it('takes the most recent year from a copyright line and ignores other years', () => {
    const signals = scanTierASignals(
      PAGE(
        '<p>Practising since 1987. The Crimes Act 1958 applies.</p>' +
          '<footer>&copy; 2019-2026 Smith Legal Pty Ltd</footer>',
      ),
    );
    expect(signals.copyright_year).toBe(2026);
  });

  it('returns no copyright year when the page has no copyright line', () => {
    const signals = scanTierASignals(PAGE('<p>Sentenced under the Crimes Act 1958.</p>'));
    expect(signals.copyright_year).toBeNull();
  });

  it('is deterministic and total: malformed markup still returns every field', () => {
    // A page that breaks a parser must not come back with everything absent and
    // no indication that the scan was unreliable, so the scanner does not parse.
    const signals = scanTierASignals('<html><body><script>gtag("AW-123456789"<p>broken');
    expect(signals.paid_search_tag).toBe(false); // unterminated script: no content read
    expect(Object.keys(signals).sort()).toStrictEqual([
      'aw_ids', 'breakpoints', 'call_tracking', 'call_tracking_vendors',
      'copyright_year', 'form_present', 'ga4', 'ga4_ids', 'gtm', 'gtm_ids',
      'location_page_links', 'mailto_link', 'paid_search_tag', 'signals_version',
      'tel_link', 'viewport_meta',
    ]);
  });

  it('runs on a large page without pathological cost', () => {
    const big = PAGE('<p>Criminal defence. </p>'.repeat(20_000));
    const started = Date.now();
    scanTierASignals(big);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
