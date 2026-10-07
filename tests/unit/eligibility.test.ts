/**
 * The snapshot eligibility gate (Day 4 input gate).
 *
 * The rule that decides whether money is spent. Two real Day 3 sites returned
 * 200 and extracted to zero characters — sydneycriminallawyers.com.au and
 * cridlandhua.com — so "2xx" is not a licence to call a model, and these cases
 * are written against that corpus rather than against invented shapes.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_TEXT_FLOOR,
  MIN_EXTRACT_CHARS,
  MIN_EXTRACT_DISTINCT_WORDS,
  assessEligibility,
  countDistinctWords,
  isOnOwnDomain,
  normaliseForMeasurement,
  type SnapshotForEligibility,
} from '../../src/pipeline/evidence';

/** Realistic law-firm homepage prose, long enough to clear the floor. */
function realPage(): string {
  return [
    'Smith Legal is a criminal defence firm in Melbourne appearing daily in the',
    'Magistrates Court and the County Court of Victoria. Our accredited',
    'specialists defend drink driving, drug driving, careless driving, assault,',
    'theft, fraud and intervention order matters across Victoria. Principal',
    'Jane Smith has practised exclusively in criminal law for eighteen years and',
    'leads a team of six solicitors. We appear in Melbourne, Dandenong,',
    'Ringwood, Frankston and Geelong. Contact our office on 03 9000 1111 or',
    'complete the enquiry form to arrange an initial conference. Fixed fees are',
    'available for summary matters and we provide written advice before any plea',
    'is entered. Our practice areas include traffic offences, licence appeals,',
    'bail applications, committals, pleas and appeals to the Supreme Court.',
    'We also act in Commonwealth prosecutions, proceeds of crime applications,',
    'firearm prohibition orders, working with children clearances and',
    'professional disciplinary hearings. Our Melbourne office is at 300 Queen',
    'Street and appointments outside business hours can be arranged by request.',
  ].join(' ');
}

function snapshot(overrides: Partial<SnapshotForEligibility> = {}): SnapshotForEligibility {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    company_id: '00000000-0000-4000-8000-0000000000aa',
    url: 'https://smithlegal.com.au/',
    http_status: 200,
    robots_allowed: true,
    text: realPage(),
    canonical_domain: 'smithlegal.com.au',
    ...overrides,
  };
}

const fresh = { alreadyExtracted: false };

describe('a snapshot is eligible only when it could ground an extraction', () => {
  it('accepts a real law-firm homepage', () => {
    const result = assessEligibility(snapshot(), fresh);
    expect(result.eligible).toBe(true);
  });

  it('is deterministic: the same input gives the same answer every time', () => {
    const input = snapshot();
    const answers = new Set(
      Array.from({ length: 20 }, () => JSON.stringify(assessEligibility(input, fresh))),
    );
    expect(answers.size).toBe(1);
  });
});

describe('the Day 3 failures: 2xx with nothing to read', () => {
  it('refuses a snapshot whose text is empty, as two real sites produced', () => {
    const result = assessEligibility(snapshot({ text: '' }), fresh);
    expect(result).toMatchObject({ eligible: false, reason: 'text_too_short' });
  });

  it('refuses whitespace-only text, which measures as empty', () => {
    const result = assessEligibility(snapshot({ text: '   \n\t  \n ' }), fresh);
    expect(result).toMatchObject({ eligible: false, reason: 'text_too_short' });
  });

  it('refuses a near-empty JavaScript shell', () => {
    const result = assessEligibility(
      snapshot({ text: 'Enable JavaScript to view this site.' }),
      fresh,
    );
    expect(result).toMatchObject({ eligible: false, reason: 'text_too_short' });
  });

  it('refuses a page just under the floor and accepts one just over it', () => {
    const filler = 'criminal defence lawyers melbourne victoria magistrates court '.repeat(40);
    const under = normaliseForMeasurement(filler).slice(0, MIN_EXTRACT_CHARS - 1);
    expect(assessEligibility(snapshot({ text: under }), fresh)).toMatchObject({
      eligible: false,
      reason: 'text_too_short',
    });
    // Over the character floor but still one repeated phrase: caught by the
    // distinct-word test, which is the point of having two numbers.
    const over = normaliseForMeasurement(filler).slice(0, MIN_EXTRACT_CHARS + 50);
    expect(assessEligibility(snapshot({ text: over }), fresh)).toMatchObject({
      eligible: false,
      reason: 'text_too_repetitive',
    });
  });

  it('refuses a navigation block repeated to length', () => {
    const nav = 'Home About Services Contact Blog Careers Privacy Terms Sitemap ';
    const text = nav.repeat(40);
    expect(normaliseForMeasurement(text).length).toBeGreaterThan(MIN_EXTRACT_CHARS);
    expect(countDistinctWords(text)).toBeLessThan(MIN_EXTRACT_DISTINCT_WORDS);
    expect(assessEligibility(snapshot({ text }), fresh)).toMatchObject({
      eligible: false,
      reason: 'text_too_repetitive',
    });
  });

  it('is stricter than the acceptance harness, on purpose', () => {
    // The harness's 500 separates a real page from an error page. Production
    // asks whether there is enough to ground §9 and §10, which is a higher bar.
    expect(MIN_EXTRACT_CHARS).toBeGreaterThan(ACCEPTANCE_TEXT_FLOOR);
    const betweenTheTwo = normaliseForMeasurement(realPage()).slice(0, 700);
    expect(betweenTheTwo.length).toBeGreaterThan(ACCEPTANCE_TEXT_FLOOR);
    expect(assessEligibility(snapshot({ text: betweenTheTwo }), fresh)).toMatchObject({
      eligible: false,
      reason: 'text_too_short',
    });
  });
});

describe('a non-2xx snapshot is never eligible, including the historical one', () => {
  it.each([403, 404, 429, 500, 503, 301])('refuses http_status %i', (status) => {
    expect(assessEligibility(snapshot({ http_status: status, text: null }), fresh)).toMatchObject({
      eligible: false,
      reason: 'http_status_not_2xx',
    });
  });

  it('refuses the pre-correction 403 row, which still carries text', () => {
    // The one production row kept as history (migration 005 is NOT VALID). It
    // satisfies `text IS NOT NULL`, so the status test is what excludes it.
    const result = assessEligibility(
      snapshot({ http_status: 403, text: 'Access Denied'.repeat(200) }),
      fresh,
    );
    expect(result).toMatchObject({ eligible: false, reason: 'http_status_not_2xx' });
  });

  it('refuses a null status, which is the robots-disallowed row', () => {
    expect(
      assessEligibility(snapshot({ http_status: null, text: null }), fresh),
    ).toMatchObject({ eligible: false, reason: 'http_status_not_2xx' });
  });
});

describe('permission and provenance', () => {
  it('refuses a snapshot we were not allowed to fetch', () => {
    expect(
      assessEligibility(snapshot({ robots_allowed: false }), fresh),
    ).toMatchObject({ eligible: false, reason: 'robots_not_allowed' });
  });

  it('refuses a pruned snapshot, whose text §15 has removed', () => {
    expect(assessEligibility(snapshot({ text: null }), fresh)).toMatchObject({
      eligible: false,
      reason: 'text_null',
    });
  });

  it('refuses an off-domain final URL while the policy is unresolved', () => {
    // Finding 2: §8 re-validates every redirect hop for scheme, port and
    // address but not for host. Until the registrable-domain policy is decided,
    // another site's content is not this firm's evidence.
    expect(
      assessEligibility(snapshot({ url: 'https://parked-example.net/' }), fresh),
    ).toMatchObject({ eligible: false, reason: 'off_domain_final_url' });
  });

  it('accepts the www form and the apex, which is the benign redirect', () => {
    expect(isOnOwnDomain('https://www.smithlegal.com.au/', 'smithlegal.com.au')).toBe(true);
    expect(isOnOwnDomain('https://smithlegal.com.au/about', 'smithlegal.com.au')).toBe(true);
    expect(isOnOwnDomain('http://smithlegal.com.au/', 'smithlegal.com.au')).toBe(true);
  });

  it('is not fooled by a lookalike host', () => {
    for (const url of [
      'https://smithlegal.com.au.evil.test/',
      'https://notsmithlegal.com.au/',
      'https://smithlegal.com/',
      'https://sub.www.smithlegal.com.au/',
    ]) {
      expect(isOnOwnDomain(url, 'smithlegal.com.au'), url).toBe(false);
    }
  });

  it('refuses a snapshot with no row behind it', () => {
    expect(assessEligibility(undefined, fresh)).toMatchObject({
      eligible: false,
      reason: 'missing_snapshot',
    });
  });
});

describe('an existing extraction is the last word', () => {
  it('reports already_extracted rather than spending again', () => {
    expect(assessEligibility(snapshot(), { alreadyExtracted: true })).toMatchObject({
      eligible: false,
      reason: 'already_extracted',
    });
  });

  it('still reports the page problem first when there is one', () => {
    // Order matters for the audit trail: "this page was never usable" is a
    // different fact from "we already did this one".
    expect(
      assessEligibility(snapshot({ text: '' }), { alreadyExtracted: true }),
    ).toMatchObject({ eligible: false, reason: 'text_too_short' });
  });
});
