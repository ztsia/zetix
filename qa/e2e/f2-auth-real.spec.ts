import { test, expect } from '@playwright/test';
import postgres from 'postgres';

/**
 * Pass A — against the REAL Supabase Auth project.
 * Covers FLOW-1 (entry), FLOW-2, FLOW-3, FLOW-9, FLOW-12 (partial).
 */
const SHOTS = 'qa-artifacts/F2-app-shell-auth/screens';
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });

/**
 * Submits a login form and waits for the Server Action round trip to land,
 * rather than for an alert that may still be the previous attempt's. Without
 * this the loop races ahead and half the attempts are never sent.
 */
async function submit(page: import('@playwright/test').Page) {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.status() < 400),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

test.afterAll(async () => { await sql.end(); });

test('FLOW-1 step 1-2: anonymous /admin redirects to a code-only login', async ({ page }) => {
  const res = await page.goto('/admin');
  expect(page.url()).toContain('/login?next=%2Fadmin');
  expect(res?.status()).toBe(200);
  await expect(page.getByText('Admin sign-in')).toBeVisible();
  await expect(page.getByLabel('Admin code')).toBeVisible();
  // No email field anywhere: the address is a server-side constant.
  expect(await page.locator('input[type="email"], input[name="email"]').count()).toBe(0);
  const html = await page.content();
  expect(html).not.toContain('committee@example.org');
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-1-admin-login.png`, fullPage: true });
});

test('FLOW-2: wrong admin code is refused with an error, no session', async ({ page }) => {
  await sql`delete from auth_failures`;
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('definitely-not-the-code');
  await page.screenshot({ path: `${SHOTS}/FLOW-2-step-1-before-submit.png`, fullPage: true });
  await submit(page);
  await expect(page.locator('#login-error')).toBeVisible();
  await expect(page.locator('#login-error')).toContainText('That code was not recognised.');
  expect(page.url()).toContain('/login');
  const cookies = await page.context().cookies();
  expect(cookies.filter((c) => c.name.startsWith('sb-'))).toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-2-step-2-refused.png`, fullPage: true });
  // and the failure was recorded
  const [{ count }] = await sql`select count(*)::int as count from auth_failures`;
  expect(count).toBe(1);
});

test('FLOW-3: the admin login locks out after auth.admin_max_attempts', async ({ page }) => {
  await sql`delete from auth_failures`;
  const [{ value }] = await sql`select value from system_settings where key = 'auth.admin_max_attempts'`;
  const max = Number(value);
  expect(max).toBeGreaterThan(0);

  await page.goto('/login');
  for (let i = 0; i < max; i++) {
    await page.getByLabel('Admin code').fill(`wrong-${i}`);
    await submit(page);
    await expect(page.locator('#login-error')).toBeVisible();
  }
  expect((await sql`select count(*)::int as c from auth_failures`)[0].c).toBe(max);
  const text = await page.locator('#login-error').textContent();
  expect(text).toMatch(/Too many attempts/);
  await page.screenshot({ path: `${SHOTS}/FLOW-3-step-1-locked-out.png`, fullPage: true });

  // Locked out means locked out even for the right code — we cannot know the
  // real code, but we can prove the route refuses BEFORE Supabase is consulted:
  // the failure count keeps rising and the message stays a lockout.
  const before = (await sql`select count(*)::int as c from auth_failures`)[0].c;
  await page.getByLabel('Admin code').fill('another-guess');
  await submit(page);
  await expect(page.locator('#login-error')).toContainText('Too many attempts');
  const after = (await sql`select count(*)::int as c from auth_failures`)[0].c;
  expect(after).toBe(before + 1);
  await page.screenshot({ path: `${SHOTS}/FLOW-3-step-2-still-locked.png`, fullPage: true });
});

test('FLOW-3b: a lockout on one IP does not lock another IP', async ({ browser }) => {
  await sql`delete from auth_failures`;
  const a = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.1' } });
  const b = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.2' } });
  const [{ value }] = await sql`select value from system_settings where key = 'auth.admin_max_attempts'`;
  const max = Number(value);

  const pa = await a.newPage();
  await pa.goto('/login');
  for (let i = 0; i < max; i++) {
    await pa.getByLabel('Admin code').fill(`wrong-${i}`);
    await submit(pa);
    await expect(pa.locator('#login-error')).toBeVisible();
  }
  await expect(pa.locator('#login-error')).toContainText('Too many attempts');

  const pb = await b.newPage();
  await pb.goto('/login');
  await pb.getByLabel('Admin code').fill('wrong-from-elsewhere');
  await submit(pb);
  await expect(pb.locator('#login-error')).toContainText('That code was not recognised.');
  await pb.screenshot({ path: `${SHOTS}/FLOW-3b-second-ip-not-locked.png`, fullPage: true });
  const buckets = await sql`select bucket, count(*)::int as c from auth_failures group by bucket order by bucket`;
  expect(buckets.map((r) => r.bucket).sort()).toEqual(['admin:198.51.100.1', 'admin:203.0.113.2']);
  await a.close(); await b.close();
});

test('FLOW-4 step 1 + FLOW-9: scanner login is mobile-first, name+code, no email', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto('/scan');
  expect(page.url()).toContain('/scan/login?next=%2Fscan');
  await expect(page.getByLabel('Display name')).toBeVisible();
  await expect(page.getByLabel('Access code')).toBeVisible();
  expect(await page.locator('input[type="email"]').count()).toBe(0);
  expect(await page.content()).not.toContain('operators.invalid');
  await page.screenshot({ path: `${SHOTS}/FLOW-4-step-1-scanner-login-mobile.png`, fullPage: true });

  // FLOW-9: wrong code and unknown name give the same message.
  await page.getByLabel('Display name').fill('Wei Ling');
  await page.getByLabel('Access code').fill('not-the-code');
  await submit(page);
  await expect(page.locator('#scan-login-error')).toContainText('That code was not recognised.');
  const first = await page.locator('#scan-login-error').textContent();
  await page.screenshot({ path: `${SHOTS}/FLOW-9-step-1-wrong-code.png`, fullPage: true });

  await page.getByLabel('Display name').fill('Nobody At All');
  await page.getByLabel('Access code').fill('not-the-code');
  await submit(page);
  await expect(page.locator('#scan-login-error')).toContainText('That code was not recognised.');
  expect(await page.locator('#scan-login-error').textContent()).toBe(first);
  await page.screenshot({ path: `${SHOTS}/FLOW-9-step-2-unknown-name.png`, fullPage: true });
  await ctx.close();
});

test('FLOW-12b: ?next= cannot be turned into an open redirect', async ({ page }) => {
  await sql`delete from auth_failures`;
  await page.goto('/login?next=https://evil.example/steal');
  const hidden = page.locator('input[name="next"]');
  // Either the field is absent or it holds a same-site path — never the URL.
  if (await hidden.count()) {
    expect(await hidden.inputValue()).not.toContain('evil.example');
  }
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-1-next-sanitised.png`, fullPage: true });
  expect(page.url()).toContain('localhost');
});

test('scanner surface: a signed-out visitor never sees attendee data at a show URL', async ({ page }) => {
  const res = await page.goto('/scan/1');
  expect(page.url()).toContain('/scan/login');
  const body = await page.content();
  expect(body).not.toContain('Evening Show');
  expect(res?.status()).toBe(200);
  await page.screenshot({ path: `${SHOTS}/FLOW-6-step-0-anon-show-url.png`, fullPage: true });
});
