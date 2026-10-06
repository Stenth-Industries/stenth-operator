#!/usr/bin/env node
/**
 * The no-mail-capability lint rule (SPEC.md §23, §19 rule 5).
 *
 * "No mail capability exists. The dependency tree contains no mail client, no
 * googleapis, no SMTP library; no source file imports one; the string
 * gmail.compose appears nowhere in src/. This is a lint rule as well as a test."
 *
 * The dependency list is itself a control: a reviewer can confirm the system
 * cannot send mail by reading it. This script is how that stays true after the
 * reviewer looks away.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages that can send, draft or read mail, or authorise doing so. */
export const FORBIDDEN_PACKAGES = [
  'googleapis',
  'google-auth-library',
  '@googleapis/gmail',
  'gmail-api-parse-message',
  'nodemailer',
  'nodemailer-smtp-transport',
  'emailjs',
  'emailjs-smtp-client',
  'smtp-client',
  'smtp-connection',
  'sendmail',
  '@sendgrid/mail',
  '@sendgrid/client',
  'postmark',
  'resend',
  'mailgun.js',
  'mailgun-js',
  'mailersend',
  'mailchimp',
  '@mailchimp/mailchimp_transactional',
  '@aws-sdk/client-ses',
  '@aws-sdk/client-sesv2',
  'aws-ses',
  'mandrill-api',
  'sparkpost',
  'mailjet',
  'node-ses',
];

/** Strings that must not appear in src/ at all. */
export const FORBIDDEN_STRINGS = ['gmail.compose'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') {
        walk(path, files);
      }
    } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
      files.push(path);
    }
  }
  return files;
}

/** Every package name in the resolved dependency tree, not just the direct ones. */
function lockfilePackages() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const names = new Set();
  for (const path of Object.keys(lock.packages ?? {})) {
    if (path === '') continue;
    const marker = 'node_modules/';
    const index = path.lastIndexOf(marker);
    if (index !== -1) {
      names.add(path.slice(index + marker.length));
    }
  }
  for (const name of Object.keys(lock.dependencies ?? {})) {
    names.add(name);
  }
  return names;
}

export function check() {
  const violations = [];

  // 1. The dependency tree.
  const installed = lockfilePackages();
  for (const name of FORBIDDEN_PACKAGES) {
    if (installed.has(name)) {
      violations.push(
        `package-lock.json: "${name}" is in the dependency tree. ` +
          'Nothing in package.json can send mail (SPEC.md §19 rule 5).',
      );
    }
  }

  // 2. Imports, and forbidden strings, in src/.
  const sources = walk(join(root, 'src'));
  for (const file of sources) {
    const contents = readFileSync(file, 'utf8');
    const where = relative(root, file);

    for (const name of FORBIDDEN_PACKAGES) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `(?:from|require\\s*\\(|import\\s*\\()\\s*['"\`]${escaped}(?:/[^'"\`]*)?['"\`]`,
      );
      if (pattern.test(contents)) {
        violations.push(`${where}: imports "${name}" (SPEC.md §23).`);
      }
    }

    for (const needle of FORBIDDEN_STRINGS) {
      if (contents.includes(needle)) {
        violations.push(
          `${where}: contains the string "${needle}", which must appear ` +
            'nowhere in src/ (SPEC.md §23).',
        );
      }
    }
  }

  return violations;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const violations = check();
  if (violations.length > 0) {
    console.error('no-mail-capability: FAILED\n');
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    console.error(
      '\nA mail-capable dependency is a blocker, not a convenience (SPEC.md §19 rule 5).',
    );
    process.exit(1);
  }
  console.log(
    `no-mail-capability: ok (${FORBIDDEN_PACKAGES.length} packages and ` +
      `${FORBIDDEN_STRINGS.length} strings checked)`,
  );
}
