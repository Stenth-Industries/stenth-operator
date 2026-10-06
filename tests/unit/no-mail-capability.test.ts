import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — the lint rule is plain ESM JavaScript, by design: it must
// run in CI without a TypeScript step.
import { FORBIDDEN_PACKAGES, check } from '../../scripts/lint-no-mail.mjs';

const root = join(__dirname, '..', '..');

/**
 * SPEC.md §23, structural assertion 1: "No mail capability exists. The
 * dependency tree contains no mail client, no googleapis, no SMTP library; no
 * source file imports one; the string gmail.compose appears nowhere in src/."
 *
 * §23 also says these are the tests that keep the project from becoming an
 * incident, and that if the build runs late they are not what gets cut.
 */
describe('no mail capability exists (SPEC.md §14, §19 rule 5, §23)', () => {
  it('reports no violation across the dependency tree and src/', () => {
    expect(check()).toStrictEqual([]);
  });

  it('checks for the mail clients a future commit might reach for', () => {
    for (const name of ['googleapis', 'nodemailer', '@sendgrid/mail', 'resend', 'postmark']) {
      expect(FORBIDDEN_PACKAGES).toContain(name);
    }
  });

  it('has no mail-capable direct dependency in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    for (const name of declared) {
      expect(FORBIDDEN_PACKAGES).not.toContain(name);
      expect(name).not.toMatch(/mail|smtp|sendgrid|postmark|gmail/i);
    }
  });
});
