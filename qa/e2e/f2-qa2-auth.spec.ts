/**
 * QA pass 2 on `claude/F2-app-shell-auth` — the authorization matrix and the
 * login flows, walked in a real browser against the real application code.
 *
 * Auth provider: a stand-in GoTrue (`qa/support/gotrue-stub.mjs`), because a
 * cloud container holds no service-role key and cannot create an ADMIN in the
 * live project (docs/local.md §7). `src/` is untouched; only
 * NEXT_PUBLIC_SUPABASE_URL is repointed.
 */
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import path from 'node:path';

const SHOTS = path.resolve('qa-artifacts/F2-app-shell-auth/screens');
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });

const ADMIN_CODE = 'correct-admin-code';
const SHOW1 = 1;
const SHOW2 = 2;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

async function clearThrottle() {
  await sql`delete from auth_failures`;
}

async function signInAdmin(page: Page) {
  await clearThrottle();
  await page.goto('/login');
  await page.fill('#code', ADMIN_CODE);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/admin/);
}

async function signInOperator(page: Page, displayName: string, code: string) {
  await page.goto('/scan/login');
  await page.fill('#displayName', displayName);
  await page.fill('#code', code);
  await page.click('button[type=submit]');
}

test.afterAll(async () => { await sql.end(); });

// ---------------------------------------------------------------- FLOW-1
test('FLOW-1 admin signs in with the code alone and reaches the console', async ({ page }) => {
  await clearThrottle();
  await page.goto('/login');
  // AC-1 — the form asks for a code only.
  expect(await page.locator('input[type=email], input[name=email]').count()).toBe(0);
  await expect(page.getByText('Admin sign-in')).toBeVisible();
  expect(await page.locator('input:not([type=hidden])').count()).toBe(1);
  await shot(page, 'FLOW-1-step-1-login');

  await page.fill('#code', ADMIN_CODE);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin/**', { timeout: 20000 });
  // AC-2 / AC-26 — console renders with a sidebar shell.
  await expect(page.locator('[data-slot=sidebar]').first()).toBeVisible();
  await shot(page, 'FLOW-1-step-2-console');

  // AC-4 — a real Supabase Auth cookie, not a bespoke session.
  const cookies = await page.context().cookies();
  const sb = cookies.filter((c) => c.name.startsWith('sb-'));
  expect(sb.length).toBeGreaterThan(0);

  await page.goto('/admin/settings');
  await expect(page.getByText('Built by module', { exact: false }).first()).toBeVisible();
  await shot(page, 'FLOW-1-step-3-settings');
});

// ---------------------------------------------------------------- FLOW-2
test('FLOW-2 a wrong admin code is refused and leaves no session', async ({ page }) => {
  await clearThrottle();
  await page.goto('/login');
  await page.fill('#code', 'definitely-not-the-code');
  await page.click('button[type=submit]');
  await expect(page.locator('#login-error, #scan-login-error')).toContainText('not recognised');
  expect(new URL(page.url()).pathname).toBe('/login');
  await shot(page, 'FLOW-2-step-1-refused');

  const res = await page.goto('/admin');
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(res?.status()).toBeLessThan(400);
  await shot(page, 'FLOW-2-step-2-still-out');
});

// ---------------------------------------------------------------- FLOW-3
test('FLOW-3 brute force: the lockout fires and a rotating header cannot escape it', async ({ page }) => {
  await clearThrottle();
  const max = Number((await sql`select value from system_settings where key='auth.admin_max_attempts'`)[0].value);

  let lastError = '';
  for (let i = 0; i < max; i++) {
    await page.goto('/login');
    await page.fill('#code', `wrong-${i}`);
    await page.click('button[type=submit]');
    await expect(page.locator('#login-error, #scan-login-error')).toBeVisible();
    lastError = (await page.locator('#login-error, #scan-login-error').textContent()) ?? '';
  }
  // AC-6 — locked out on the attempt that reaches the threshold.
  expect(lastError).toMatch(/Too many attempts/i);
  await shot(page, 'FLOW-3-step-1-locked-out');

  // AC-6 — the correct code is refused while locked out.
  await page.goto('/login');
  await page.fill('#code', ADMIN_CODE);
  await page.click('button[type=submit]');
  await expect(page.locator('#login-error, #scan-login-error')).toContainText('Too many attempts');
  expect(new URL(page.url()).pathname).toBe('/login');
  await shot(page, 'FLOW-3-step-2-correct-code-still-locked');

  // AC-9 — rotate x-forwarded-for; the bucket must not multiply.
  const before = Number((await sql`select count(*) from auth_failures`)[0].count);
  for (let i = 0; i < 6; i++) {
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.113.${i}` });
    await page.goto('/login');
    await page.fill('#code', `spoof-${i}`);
    await page.click('button[type=submit]');
  }
  await page.setExtraHTTPHeaders({});
  const buckets = await sql`select bucket, count(*) from auth_failures group by bucket`;
  expect(buckets.length).toBe(1);
  expect(Number((await sql`select count(*) from auth_failures`)[0].count)).toBeGreaterThan(before);
  await expect(page.locator('#login-error, #scan-login-error')).toContainText('Too many attempts');
  await shot(page, 'FLOW-3-step-3-spoof-fails');

  // AC-7 — the lockout grows.
  const wait = (s: string) => Number(s.match(/in (\d+)/)?.[1] ?? 0);
  const now = wait((await page.locator('#login-error, #scan-login-error').textContent()) ?? '');
  expect(now).toBeGreaterThan(wait(lastError));
});

// ---------------------------------------------------------------- FLOW-4
test('FLOW-4 operator signs in at the door on a phone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('/scan');
  expect(new URL(page.url()).pathname).toBe('/scan/login');
  // AC-12 — display name + code, never an email.
  await expect(page.locator('#displayName')).toBeVisible();
  await expect(page.locator('#code')).toBeVisible();
  expect(await page.content()).not.toContain('operators.invalid');
  expect(await page.locator('input[type=email]').count()).toBe(0);
  await shot(page, 'FLOW-4-step-1-scanner-login');

  await page.fill('#displayName', 'Wei Ling');
  await page.fill('#code', 'op1-code');
  await page.click('button[type=submit]');
  await page.waitForURL('**/scan', { timeout: 20000 });
  // AC-13 — assigned show listed; AC-21 — the unassigned one is not.
  await expect(page.getByText('Show One')).toBeVisible();
  await expect(page.getByText('Show Two')).toHaveCount(0);
  // AC-31 — mobile-first: no horizontal overflow.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, 'FLOW-4-step-2-show-list');
  await context.close();
});

// ---------------------------------------------------------------- FLOW-5
test('FLOW-5 operator with the wrong code is refused', async ({ page }) => {
  await signInOperator(page, 'Wei Ling', 'not-my-code');
  await expect(page.locator('#login-error, #scan-login-error')).toContainText('not recognised');
  expect(new URL(page.url()).pathname).toBe('/scan/login');
  await shot(page, 'FLOW-5-step-1-refused');
  await page.goto('/scan');
  expect(new URL(page.url()).pathname).toBe('/scan/login');
});

// ---------------------------------------------------------------- FLOW-6
test('FLOW-6 operator opening an unassigned show is refused before any data', async ({ page }) => {
  await signInOperator(page, 'Wei Ling', 'op1-code');
  await page.waitForURL('**/scan');

  const assigned = await page.goto(`/scan/${SHOW1}`);
  expect(assigned?.status()).toBe(200);
  await expect(page.getByText('Show One')).toBeVisible();
  await shot(page, 'FLOW-6-step-1-assigned-show');

  const refused = await page.goto(`/scan/${SHOW2}`);
  // AC-21 — refused, and no attendee/show data leaks in the body.
  expect(refused?.status()).toBe(404);
  const body = await page.content();
  expect(body).not.toContain('Show Two');
  expect(body).not.toContain('Victoria');
  await shot(page, 'FLOW-6-step-2-refused');

  // The same for an operator with zero assignments (AC-20 sad half).
  await page.goto('/scan/login');
  await page.context().clearCookies();
  await signInOperator(page, 'Bob Tan', 'op2-code');
  await page.waitForURL('**/scan');
  await expect(page.getByText('Show One')).toHaveCount(0);
  await shot(page, 'FLOW-6-step-3-no-assignments');
  expect((await page.goto(`/scan/${SHOW1}`))?.status()).toBe(404);
});

// ---------------------------------------------------------------- FLOW-7
test('FLOW-7 operator cannot reach the admin console or the export endpoint', async ({ page }) => {
  await signInOperator(page, 'Wei Ling', 'op1-code');
  await page.waitForURL('**/scan');

  await page.goto('/admin/concerts');
  // AC-17 — bounced out of the console entirely.
  expect(new URL(page.url()).pathname).toBe('/scan');
  // no admin chrome, no admin data: the console never rendered.
  expect(await page.locator('[data-slot=sidebar]').count()).toBe(0);
  expect(await page.content()).not.toContain('Extras review');
  await shot(page, 'FLOW-7-step-1-console-refused');

  // AC-18 — the Route Handler, which the proxy does not cover.
  const res = await page.request.post('/api/export/xlsx', {
    data: { filename: 'x', headers: ['A'], rows: [['1']], timeZone: 'Asia/Singapore' },
  });
  expect(res.status()).toBe(403);
  expect(await res.text()).toContain('Admins only');
});

// ---------------------------------------------------------------- FLOW-8
test('FLOW-8 an admin is allowed at the door', async ({ page }) => {
  await signInAdmin(page);
  const res = await page.goto('/scan');
  expect(res?.status()).toBe(200);
  // AC-19 — admin sees every show, assignments ignored.
  await expect(page.getByText('Show One')).toBeVisible();
  await expect(page.getByText('Show Two')).toBeVisible();
  await shot(page, 'FLOW-8-step-1-admin-at-the-door');
  expect((await page.goto(`/scan/${SHOW2}`))?.status()).toBe(200);
});

// ---------------------------------------------------------------- FLOW-9
test('FLOW-9 a deactivated operator loses access on the next request', async ({ page }) => {
  await signInOperator(page, 'Wei Ling', 'op1-code');
  await page.waitForURL('**/scan');
  await expect(page.getByText('Show One')).toBeVisible();
  await shot(page, 'FLOW-9-step-1-signed-in');

  await sql`update app_users set is_active = false where email = 'wei-ling@operators.invalid'`;
  try {
    await page.goto('/scan/1');
    // AC-23 — the very next request refuses.
    expect(new URL(page.url()).pathname).toBe('/scan/login');
    await shot(page, 'FLOW-9-step-2-deactivated');
  } finally {
    await sql`update app_users set is_active = true where email = 'wei-ling@operators.invalid'`;
  }
});

// ---------------------------------------------------------------- FLOW-9b
test('FLOW-9b an authenticated identity with no app_users row reaches nothing', async ({ page }) => {
  // AC-24 — Supabase authenticated, but we never authorised them.
  await signInOperator(page, 'Ghost', 'ghost-code');
  await expect(page.locator('#login-error, #scan-login-error')).toContainText('not recognised');
  await shot(page, 'FLOW-9b-step-1-orphan-refused');
  await page.goto('/scan');
  expect(new URL(page.url()).pathname).toBe('/scan/login');
  await page.goto('/admin');
  expect(new URL(page.url()).pathname).toBe('/login');
});

// ---------------------------------------------------------------- FLOW-12
test('FLOW-12 deep link into a concert, and a garbage concert id', async ({ page }) => {
  await signInAdmin(page);
  const good = await page.goto('/admin/concerts/1/registrations');
  expect(good?.status()).toBe(200);
  await expect(page.getByText('QA Concert')).toBeVisible();
  await shot(page, 'FLOW-12-step-1-deep-link');

  for (const bad of ['999999', 'abc', "1'or'1", '../../etc/passwd']) {
    const res = await page.goto(`/admin/concerts/${encodeURIComponent(bad)}/overview`);
    expect.soft(res?.status(), `concert id ${bad}`).toBe(404);
  }
  await shot(page, 'FLOW-12-step-2-bad-concert-id');
});

// ---------------------------------------------------------------- FLOW-14
test('FLOW-14 the login form is not an open redirect', async ({ page }) => {
  await clearThrottle();
  await page.goto('/login?next=https://evil.example/');
  await page.fill('#code', ADMIN_CODE);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin**', { timeout: 20000 });
  expect(page.url()).toContain('localhost:3100');
  expect(page.url()).not.toContain('evil.example');
  await shot(page, 'FLOW-14-step-1-no-open-redirect');
});

// ---------------------------------------------------------------- AC-25
test('AC-25 every route in admin.md §14.1 resolves for an admin', async ({ page }) => {
  await signInAdmin(page);
  const paths = [
    '/admin/concerts', '/admin/settings',
    ...['overview','shows','players','forms','registrations','extras-review','import',
        'tickets','email','checkin','operators','portal','notes','exports']
      .map((s) => `/admin/concerts/1/${s}`),
  ];
  for (const p of paths) {
    const res = await page.goto(p);
    expect.soft(res?.status(), p).toBe(200);
  }
  await shot(page, 'AC-25-route-skeleton');
});
