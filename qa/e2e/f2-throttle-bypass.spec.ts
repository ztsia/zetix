import { test, expect } from '@playwright/test';
import postgres from 'postgres';

const SHOTS = 'qa-artifacts/F2-app-shell-auth/screens';
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

/**
 * Regression test for the bypass an independent QA pass found.
 *
 * The throttle used to key on `x-forwarded-for`, which any caller can send: a
 * rotating header gave one attacker an unlimited supply of fresh buckets and the
 * lockout never fired. `clientIp()` now reads only headers the platform sets and
 * strips from inbound requests, so a supplied one contributes nothing.
 */
test('a rotating x-forwarded-for no longer defeats the admin lockout', async ({ browser }) => {
  test.setTimeout(180_000);
  await sql`delete from auth_failures`;
  const [{ value }] = await sql`select value from system_settings where key = 'auth.admin_max_attempts'`;
  const max = Number(value);

  let lastError = '';
  const attempts = max * 4;
  for (let i = 0; i < attempts; i++) {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${i + 1}` },
    });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByLabel('Admin code').fill(`guess-${i}`);
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.status() < 400),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    lastError = (await page.locator('#login-error').textContent()) ?? '';
    if (i === attempts - 1) {
      await page.screenshot({ path: `${SHOTS}/BYPASS-rotating-xff.png`, fullPage: true });
    }
    await ctx.close();
  }

  const rows = await sql`select bucket, count(*)::int as c from auth_failures group by bucket`;
  console.log(`attempts=${attempts} max=${max} buckets=${rows.length} lastError=${JSON.stringify(lastError)}`);
  // Every attempt lands in one bucket however the header is rotated...
  expect(rows.length).toBe(1);
  // ...and the caller is locked out well before the last of them.
  expect(lastError).toMatch(/Too many attempts/);
});

test('a crafted ?next= posted with the form cannot redirect off-origin', async ({ page }) => {
  await sql`delete from auth_failures`;
  await page.goto('/login');
  // Inject the hidden field the server action reads, exactly as an attacker
  // would when phishing with our own login form.
  await page.evaluate(() => {
    const form = document.querySelector('form')!;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'next';
    input.value = 'https://evil.example/steal';
    form.appendChild(input);
  });
  await page.getByLabel('Admin code').fill('wrong-anyway');
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.status() < 400),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  expect(page.url()).not.toContain('evil.example');
  expect(new URL(page.url()).host).toContain('localhost');
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-3-crafted-next.png`, fullPage: true });
});
