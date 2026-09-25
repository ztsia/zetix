import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * Module R, phase 4 — does anything a VIEWER must not hold reach their browser?
 *
 * Signs in as the seeded VIEWER (and, for the twin, an ADMIN), loads every
 * admin screen, and greps the **raw response** (HTML + inlined RSC payload),
 * not the rendered text: spec/v3.md §28 says masking happens on the server,
 * so anything in the payload counts even if nothing paints it.
 *
 * Seed: qa/support/seed-r.mjs. Run with the stack from qa/support/start-r.sh.
 */
const OUT = 'qa-artifacts/claude-R-roles-accounts';

const C = '/admin/concerts/1';
export const PAGES = [
  '/admin',
  '/admin/concerts',
  '/admin/settings',
  '/admin/settings/people',
  C,
  `${C}/overview`,
  `${C}/activity`,
  `${C}/checkin`,
  `${C}/email`,
  `${C}/email/delivery`,
  `${C}/email/templates`,
  `${C}/exports`,
  `${C}/extras-review`,
  `${C}/forms`,
  `${C}/forms/1`,
  `${C}/forms/1/responses`,
  `${C}/forms/1/settings`,
  `${C}/import`,
  `${C}/notes`,
  `${C}/operators`,
  `${C}/players`,
  `${C}/portal`,
  `${C}/registrations`,
  `${C}/registrations/unverified`,
  `${C}/shows`,
  `${C}/tickets`,
  `${C}/tickets/templates`,
  `${C}/tickets/templates/2`,
  `${C}/tickets/templates/2?show=1`,
  `${C}/tickets/templates?show=1`,
  `${C}/email?show=1`,
  `${C}/trash`,
  '/preview/1',
];

/** Full address at the seed's domain. A masked one looks like `a•••@e•••.test`. */
const EMAIL = /[A-Za-z0-9._%+-]+@example\.test/g;
const SECRETS: Record<string, RegExp> = {
  email: EMAIL,
  operatorEmail: /[a-z-]+@operators\.invalid/g,
  phone: /\+60 1[2-9]-\d{3} \d{3,4}/g,
  qrToken: /QRSECRET\d+/g,
  updateToken: /UPDSECRET\d+/g,
  verificationToken: /VERSECRET\d+/g,
  editToken: /EDITSECRET\d+/g,
  inviteToken: /seedtoken\d+/g,
  ticketLink: /\/t\/[A-Za-z0-9_-]{8,}/g,
};

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function sweep(page: Page) {
  const results: Record<
    string,
    { status: number; location: string | null; finalStatus: number; bytes: number; masked: number; found: Record<string, string[]> }
  > = {};
  for (const path of PAGES) {
    const first = await page.request.get(path, { maxRedirects: 0 });
    const res = await page.request.get(path);
    const body = await res.text();
    const found: Record<string, string[]> = {};
    for (const [name, re] of Object.entries(SECRETS)) {
      const hits = [...new Set(body.match(re) ?? [])];
      if (hits.length) found[name] = hits.slice(0, 8);
    }
    results[path] = {
      status: first.status(),
      location: first.headers()['location'] ?? null,
      finalStatus: res.status(),
      bytes: body.length,
      masked: (body.match(/•••/g) ?? []).length,
      found,
    };
  }
  return results;
}

test.describe.configure({ mode: 'serial' });

test('VIEWER sweep: every admin page, raw payload', async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  const results = await sweep(page);
  writeFileSync(`${OUT}/viewer-sweep.json`, JSON.stringify(results, null, 2));
  // Report, do not stop at first failure: the JSON is the evidence.
  const leaks = Object.entries(results).filter(([, r]) => Object.keys(r.found).length > 0);
  const non200 = Object.entries(results).filter(([, r]) => r.finalStatus !== 200);
  console.log('viewer table:', JSON.stringify(Object.entries(results).map(([p, r]) => [p, r.status, r.location, r.finalStatus, r.bytes, r.masked])));
  console.log('viewer leaks:', JSON.stringify(leaks.map(([p, r]) => [p, r.found]), null, 1));
  expect.soft(non200.map(([p]) => p)).toEqual([]);
  expect(leaks.map(([p]) => p)).toEqual([]);
});

test('ADMIN twin: the same pages show full contacts', async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page, 'committee@example.test', 'qa-admin-pass');
  const results = await sweep(page);
  writeFileSync(`${OUT}/admin-sweep.json`, JSON.stringify(results, null, 2));
  expect(results[`${C}/registrations`].found.email ?? []).toContain('alice@example.test');
  expect(results[`${C}/players`].found.email?.length ?? 0).toBeGreaterThan(0);
});
