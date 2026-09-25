import { test, expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

/**
 * Module R, phase 5 — the flows in qa-artifacts/claude-R-roles-accounts/02-flows.md,
 * walked in Chromium against qa/support/start-r.sh (stub GoTrue, zetix_qa).
 * Every step asserts, then screenshots.
 *
 * The stub keeps users in memory, so restart start-r.sh before re-running.
 */
const SHOTS = 'qa-artifacts/claude-R-roles-accounts/screens';
const BASE = 'http://localhost:3100';
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });

const COMMITTEE = { email: 'committee@example.test', password: 'qa-admin-pass', id: '11111111-1111-4111-8111-111111111111' };
const ANA = { email: 'ana@example.test', password: 'qa-ana-pass', id: '44444444-4444-4444-8444-444444444444' };
const MEI = { email: 'mei@example.test', password: 'qa-viewer-pass', id: '33333333-3333-4333-8333-333333333333' };
const NORA_EMAIL = `nora-${Date.now()}@example.test`;

/** Shared across the serial flows. */
const state: {
  noraPassword?: string;
  noraId?: string;
  captured: Record<string, { url: string; headers: Record<string, string>; body: Buffer }>;
} = { captured: {} };

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  execFileSync('node', ['qa/support/seed-r.mjs'], { env: { ...process.env, QA_ADMIN_EMAIL: COMMITTEE.email } });
});
test.afterAll(async () => { await sql.end(); });

let ipSeq = 10;
async function newContext(browser: Browser, opts: { ip?: string; mobile?: boolean; tz?: string } = {}) {
  return browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'x-real-ip': opts.ip ?? `198.51.100.${ipSeq++}` },
    ...(opts.mobile ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } : {}),
    ...(opts.tz ? { timezoneId: opts.tz } : {}),
  });
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function fillLogin(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
}

/** Submits and waits for the server action to answer. */
async function submitLogin(page: Page) {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST'),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.waitForLoadState('networkidle');
}

async function signIn(page: Page, email: string, password: string) {
  await fillLogin(page, email, password);
  await submitLogin(page);
  await expect(page).not.toHaveURL(/\/login/);
}

function capture(page: Page, key: string) {
  const handler = (req: Request) => {
    const h = req.headers();
    if (req.method() === 'POST' && h['next-action'] && !state.captured[key]) {
      state.captured[key] = { url: req.url(), headers: h, body: req.postDataBuffer() ?? Buffer.alloc(0) };
    }
  };
  page.on('request', handler);
  return () => page.off('request', handler);
}

async function replay(ctx: BrowserContext, key: string, body?: string | Buffer) {
  const c = state.captured[key];
  expect(c, `captured ${key}`).toBeTruthy();
  const headers: Record<string, string> = {};
  for (const name of ['next-action', 'content-type', 'next-router-state-tree', 'accept']) {
    if (c.headers[name]) headers[name] = c.headers[name];
  }
  const res = await ctx.request.post(c.url, { headers, data: body ?? c.body, maxRedirects: 0 });
  return { status: res.status(), text: (await res.text()).replace(/\s+/g, ' ').slice(0, 400) };
}

async function user(id: string) {
  const [row] = await sql`select role, is_active, display_name from app_users where id = ${id}`;
  return row;
}

test('FLOW-1 admin signs in with email and password', async ({ browser }) => {
  await sql`delete from auth_failures`;
  const page = await (await newContext(browser)).newPage();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin/);
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await shot(page, 'FLOW-1-step-1-login');
  await page.locator('input[name="email"]').fill(COMMITTEE.email);
  await page.locator('input[name="password"]').fill(COMMITTEE.password);
  await shot(page, 'FLOW-1-step-2-filled');
  await submitLogin(page);
  await expect(page).toHaveURL(/\/admin(\/concerts)?$/);
  await expect(page.getByText('Read-only access.')).toHaveCount(0);
  const [row] = await sql`select last_login_at from app_users where id = ${COMMITTEE.id}`;
  expect(row.last_login_at).not.toBeNull();
  await shot(page, 'FLOW-1-step-3-console');
});

test('FLOW-2 wrong password is refused', async ({ browser }) => {
  await sql`delete from auth_failures`;
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await fillLogin(page, COMMITTEE.email, 'wrong-password');
  await submitLogin(page);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText('That email and password were not recognised.')).toBeVisible();
  expect((await ctx.cookies()).filter((c) => c.name.startsWith('sb-'))).toHaveLength(0);
  await shot(page, 'FLOW-2-step-1-refused');
  await fillLogin(page, 'nobody@example.test', 'wrong-password');
  await submitLogin(page);
  await expect(page.getByText('That email and password were not recognised.')).toBeVisible();
  await shot(page, 'FLOW-2-step-2-unknown-address-same-message');
  await page.goto('/admin/concerts');
  await expect(page).toHaveURL(/\/login/);
});

test('FLOW-3 admin provisions a VIEWER; password shown once', async ({ browser }) => {
  const page = await (await newContext(browser)).newPage();
  await signIn(page, COMMITTEE.email, COMMITTEE.password);
  await page.goto('/admin/settings/people');
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
  await expect(page.getByText(ANA.email)).toBeVisible();
  await shot(page, 'FLOW-3-step-1-people');
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.locator('#person-name').fill('Nora Newview');
  await page.locator('#person-email').fill(NORA_EMAIL);
  await page.locator('select[name="role"]').selectOption('VIEWER');
  await shot(page, 'FLOW-3-step-2-add-form');
  const stop = capture(page, 'createAccount');
  await page.getByRole('button', { name: 'Create and show password' }).click();
  const pw = page.locator('#issued-password');
  await expect(pw).toBeVisible();
  state.noraPassword = await pw.inputValue();
  stop();
  expect(state.noraPassword.replaceAll('-', '').length).toBeGreaterThanOrEqual(16);
  await shot(page, 'FLOW-3-step-3-password-shown-once');
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await page.reload();
  const html = await page.content();
  expect(html).not.toContain(state.noraPassword);
  await expect(page.getByText(NORA_EMAIL)).toBeVisible();
  const [row] = await sql`select id, role, is_active from app_users where email = ${NORA_EMAIL}`;
  expect(row.role).toBe('VIEWER');
  expect(row.is_active).toBe(true);
  state.noraId = row.id;
  // Not stored anywhere in the app database in plain text.
  const [{ n }] = await sql`select count(*)::int as n from audit_log where before::text like ${'%' + state.noraPassword + '%'} or after::text like ${'%' + state.noraPassword + '%'}`;
  expect(n).toBe(0);
  await shot(page, 'FLOW-3-step-4-after-reload-no-password');
});

test('FLOW-4 viewer signs in and reads the console, masked', async ({ browser }) => {
  const page = await (await newContext(browser)).newPage();
  await fillLogin(page, NORA_EMAIL, state.noraPassword!);
  await shot(page, 'FLOW-4-step-1-login');
  await submitLogin(page);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText('Read-only access.')).toBeVisible();
  await shot(page, 'FLOW-4-step-2-console-banner');

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const screens: Array<[string, string]> = [
    ['/admin/concerts/1/registrations', 'registrations'],
    ['/admin/concerts/1/players', 'players'],
    ['/admin/concerts/1/activity', 'activity'],
    ['/admin/concerts/1/email/delivery', 'email-delivery'],
    ['/admin/concerts/1/email/templates', 'email-templates'],
    ['/admin/settings/people', 'people'],
    ['/admin/concerts/1/trash', 'trash'],
  ];
  let step = 3;
  for (const [path, name] of screens) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const text = await page.locator('body').innerText();
    expect(text, path).not.toMatch(/[A-Za-z0-9._%+-]+@example\.test/);
    expect(text, path).not.toMatch(/\+60 1[2-9]-\d{3} \d{3,4}/);
    expect(text, path).not.toMatch(/Something went wrong|Application error/);
    await shot(page, `FLOW-4-step-${step++}-${name}`);
  }
  // A registration row opens its sheet, masked.
  await page.goto('/admin/concerts/1/registrations');
  await page.getByText('Alice Tan').first().click();
  await page.waitForTimeout(800);
  const sheet = await page.locator('body').innerText();
  expect(sheet).not.toContain('alice@example.test');
  expect(sheet).toMatch(/a•••@e•••\.test/);
  await shot(page, `FLOW-4-step-${step++}-registration-sheet`);
  expect(errors).toEqual([]);
});

test('FLOW-5 viewer tries to act — controls absent, server refuses replayed actions', async ({ browser }) => {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await signIn(page, MEI.email, MEI.password);
  await page.goto('/admin/settings/people');
  await expect(page.getByRole('button', { name: 'Add person' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Actions for/ })).toHaveCount(0);
  await shot(page, 'FLOW-5-step-1-people-no-controls');
  await page.goto('/admin/concerts/1/players');
  await expect(page.getByRole('button', { name: 'New player' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import CSV' })).toHaveCount(0);
  await shot(page, 'FLOW-5-step-2-players-no-controls');
  await page.goto('/admin/concerts/1/tickets');
  await expect(page.getByRole('button', { name: /Issue/ })).toHaveCount(0);
  await shot(page, 'FLOW-5-step-3-tickets-no-controls');

  // Replay the admin's own createAccount request with the viewer's cookies.
  const before = await sql`select count(*)::int as n from app_users`;
  const body = state.captured.createAccount.body.toString('latin1').replace(NORA_EMAIL, 'viewer-made@example.test');
  const res = await replay(ctx, 'createAccount', Buffer.from(body, 'latin1'));
  console.log('viewer replay createAccountAction:', res.status, res.text.slice(0, 200));
  const after = await sql`select count(*)::int as n from app_users`;
  expect(after[0].n).toBe(before[0].n);
  const [{ n: made }] = await sql`select count(*)::int as n from app_users where email = 'viewer-made@example.test'`;
  expect(made).toBe(0);
  expect(res.text).toContain('READ_ONLY_ACCOUNT');
});

test('FLOW-9 issue a new password: old stops, new works', async ({ browser }) => {
  const admin = await (await newContext(browser)).newPage();
  await signIn(admin, COMMITTEE.email, COMMITTEE.password);
  await admin.goto('/admin/settings/people');
  await admin.getByRole('button', { name: 'Actions for Nora Newview' }).click();
  await shot(admin, 'FLOW-9-step-1-row-menu');
  await admin.getByRole('menuitem', { name: 'Issue a new password' }).click();
  await admin.getByRole('button', { name: 'Issue new password' }).click();
  const pw = admin.locator('#issued-password');
  await expect(pw).toBeVisible();
  const fresh = await pw.inputValue();
  expect(fresh).not.toBe(state.noraPassword);
  await shot(admin, 'FLOW-9-step-2-new-password');
  await admin.getByRole('button', { name: 'I have saved it' }).click();

  const nora = await (await newContext(browser)).newPage();
  await fillLogin(nora, NORA_EMAIL, state.noraPassword!);
  await submitLogin(nora);
  await expect(nora.getByText('That email and password were not recognised.')).toBeVisible();
  await shot(nora, 'FLOW-9-step-3-old-password-refused');
  await signIn(nora, NORA_EMAIL, fresh);
  await expect(nora.getByText('Read-only access.')).toBeVisible();
  await shot(nora, 'FLOW-9-step-4-new-password-works');
  state.noraPassword = fresh;
});

test('FLOW-10 deactivating a signed-in viewer ends their session at the next request', async ({ browser }) => {
  const noraCtx = await newContext(browser);
  const nora = await noraCtx.newPage();
  await signIn(nora, NORA_EMAIL, state.noraPassword!);
  await nora.goto('/admin/concerts/1/registrations');
  await expect(nora.getByText('Read-only access.')).toBeVisible();
  await shot(nora, 'FLOW-10-step-1-viewer-signed-in');

  const admin = await (await newContext(browser)).newPage();
  await signIn(admin, COMMITTEE.email, COMMITTEE.password);
  await admin.goto('/admin/settings/people');
  const stop = capture(admin, 'setActive');
  await admin.getByRole('button', { name: 'Actions for Nora Newview' }).click();
  await admin.getByRole('menuitem', { name: 'Deactivate' }).click();
  await shot(admin, 'FLOW-10-step-2-confirm-deactivate');
  await admin.getByRole('button', { name: 'Deactivate' }).click();
  await expect.poll(async () => (await user(state.noraId!)).is_active).toBe(false);
  stop();
  await shot(admin, 'FLOW-10-step-3-deactivated');

  await nora.reload();
  await expect(nora).toHaveURL(/\/login/);
  await shot(nora, 'FLOW-10-step-4-viewer-bounced');
  await fillLogin(nora, NORA_EMAIL, state.noraPassword!);
  await submitLogin(nora);
  await expect(nora.getByText('That email and password were not recognised.')).toBeVisible();
  await shot(nora, 'FLOW-10-step-5-sign-in-refused');
});

test('FLOW-7 admin cannot deactivate or demote themselves', async ({ browser }) => {
  const ctx = await newContext(browser);
  const admin = await ctx.newPage();
  await signIn(admin, COMMITTEE.email, COMMITTEE.password);
  await admin.goto('/admin/settings/people');
  await admin.getByRole('button', { name: 'Actions for Committee' }).click();
  await expect(admin.getByRole('menuitem', { name: 'Deactivate' })).toHaveCount(0);
  await expect(admin.getByRole('menuitem', { name: /Make viewer/ })).toHaveCount(0);
  await shot(admin, 'FLOW-7-step-1-own-menu-no-deactivate');
  await admin.keyboard.press('Escape');

  // Hand-made request: setActiveAction(<self>, false) with the admin's cookies.
  const body = JSON.stringify([COMMITTEE.id, false]);
  const res = await replay(ctx, 'setActive', body);
  console.log('self-deactivate replay:', res.status, res.text.slice(0, 300));
  expect(res.text).toContain('You cannot deactivate your own account.');
  expect((await user(COMMITTEE.id)).is_active).toBe(true);
});

test('FLOW-8 two admins demote each other at the same instant — one admin always remains', async ({ browser }) => {
  const committeeCtx = await newContext(browser);
  const anaCtx = await newContext(browser);
  const c = await committeeCtx.newPage();
  const a = await anaCtx.newPage();
  await signIn(c, COMMITTEE.email, COMMITTEE.password);
  await signIn(a, ANA.email, ANA.password);

  // Capture setRoleAction's id from a real click (promote Nora's row is not
  // needed — capture on a harmless round trip: make Mei an admin, then back).
  await c.goto('/admin/settings/people');
  const stop = capture(c, 'setRole');
  await c.getByRole('button', { name: 'Actions for Mei Viewer' }).click();
  await c.getByRole('menuitem', { name: 'Make admin' }).click();
  await c.getByRole('button', { name: 'Make admin' }).click();
  await expect.poll(async () => (await user(MEI.id)).role).toBe('ADMIN');
  stop();
  await sql`update app_users set role = 'VIEWER' where id = ${MEI.id}`;
  await shot(c, 'FLOW-8-step-1-two-admins');

  const [r1, r2] = await Promise.all([
    replay(committeeCtx, 'setRole', JSON.stringify([ANA.id, 'VIEWER'])),
    replay(anaCtx, 'setRole', JSON.stringify([COMMITTEE.id, 'VIEWER'])),
  ]);
  console.log('race committee→ana:', r1.status, r1.text.slice(0, 200));
  console.log('race ana→committee:', r2.status, r2.text.slice(0, 200));
  const admins = await sql`select email from app_users where role = 'ADMIN' and is_active and deleted_at is null`;
  console.log('active admins after race:', admins.map((x) => x.email));
  expect(admins.length).toBe(1);
  await c.goto('/admin/settings/people');
  await shot(c, 'FLOW-8-step-2-after-race');
  // Restore both for later flows.
  await sql`update app_users set role = 'ADMIN' where id in (${COMMITTEE.id}, ${ANA.id})`;
});

test('FLOW-13 Activity says who', async ({ browser }) => {
  const page = await (await newContext(browser)).newPage();
  await signIn(page, ANA.email, ANA.password);
  await page.goto('/admin/concerts/1/players');
  await page.getByRole('button', { name: 'New player' }).click();
  await page.locator('input[name="fullName"]').fill('Rhea Recorder');
  await page.locator('input[name="email"]').fill('rhea@example.test');
  await page.getByRole('button', { name: 'Add player' }).click();
  await expect.poll(async () => (await sql`select count(*)::int as n from players where full_name = 'Rhea Recorder'`)[0].n).toBe(1);
  const [row] = await sql`select actor_id, action from audit_log where after::text like '%Rhea Recorder%' order by id desc limit 1`;
  console.log('audit row for new player:', row);
  expect(row?.actor_id).toBe(ANA.id);
  await page.goto('/admin/concerts/1/activity');
  await expect(page.getByText('Ana Admin').first()).toBeVisible();
  await shot(page, 'FLOW-13-step-1-activity-names-ana');
});

test('FLOW-6 viewer is not admitted to the door scanner (phone)', async ({ browser }) => {
  const ctx = await newContext(browser, { mobile: true });
  const page = await ctx.newPage();
  await signIn(page, MEI.email, MEI.password);
  await page.goto('/scan');
  await expect(page).toHaveURL(/\/admin/);
  await shot(page, 'FLOW-6-step-1-scan-bounced-to-console');
  await page.goto('/scan/1');
  await expect(page).toHaveURL(/\/admin/);
  const res = await ctx.request.get('/api/checkin/manifest?showId=1');
  expect(res.status()).toBe(404);
  await shot(page, 'FLOW-6-step-2-scan-show-bounced');
});

test('FLOW-12 operator sign-in unchanged; operator refused from console', async ({ browser }) => {
  const ctx = await newContext(browser, { mobile: true });
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.locator('input[name="displayName"]').fill('Wei Ling');
  await page.locator('input[name="code"]').fill('qa-op-code');
  await shot(page, 'FLOW-12-step-1-operator-login');
  await Promise.all([page.waitForURL(/\/scan(\/\d+)?$/), page.locator('button[type="submit"]').click()]);
  await shot(page, 'FLOW-12-step-2-scanner');
  await page.goto('/admin/concerts/1/registrations');
  await expect(page).toHaveURL(/\/scan/);
  await shot(page, 'FLOW-12-step-3-console-refused');
  // Operator's synthetic address on the console form is refused.
  const p2 = await (await newContext(browser)).newPage();
  await fillLogin(p2, 'wei-ling@operators.invalid', 'qa-op-code');
  await submitLogin(p2);
  await expect(p2.getByText('That email and password were not recognised.')).toBeVisible();
  await shot(p2, 'FLOW-12-step-4-operator-on-console-form-refused');
});

test('FLOW-11 throttle: per account across IPs, and what it does to a colleague on the same IP', async ({ browser }) => {
  await sql`delete from auth_failures`;
  const [{ value: max }] = await sql`select value from system_settings where key = 'auth.admin_max_attempts'`;
  const attempts = Number(max);
  // Attacker: wrong passwords at ana's address, each from a different IP.
  for (let i = 0; i < attempts; i++) {
    const p = await (await newContext(browser, { ip: `203.0.113.${i + 1}` })).newPage();
    await fillLogin(p, ANA.email, `guess-${i}`);
    await submitLogin(p);
    await p.context().close();
  }
  // Ana, from the office, with the right password.
  const office = '192.0.2.50';
  const anaPage = await (await newContext(browser, { ip: office })).newPage();
  await fillLogin(anaPage, ANA.email, ANA.password);
  await submitLogin(anaPage);
  await expect(anaPage.getByText(/Too many attempts/)).toBeVisible();
  await shot(anaPage, 'FLOW-11-step-1-account-locked-from-new-ip');
  // Ana retries a few more times, as a person would.
  for (let i = 1; i < attempts; i++) {
    await fillLogin(anaPage, ANA.email, ANA.password);
    await submitLogin(anaPage);
  }
  const buckets = await sql`select bucket, count(*)::int as n from auth_failures group by bucket order by bucket`;
  console.log('auth_failures after ana retries:', buckets);
  // Committee, a different admin at the same office IP, correct password.
  const cPage = await (await newContext(browser, { ip: office })).newPage();
  await fillLogin(cPage, COMMITTEE.email, COMMITTEE.password);
  await submitLogin(cPage);
  const colleagueLocked = await cPage.getByText(/Too many attempts/).isVisible();
  console.log('colleague on the same IP locked out:', colleagueLocked, 'url', cPage.url());
  await shot(cPage, 'FLOW-11-step-2-colleague-same-ip');
  // From a clean IP the colleague still gets in.
  const cPage2 = await (await newContext(browser, { ip: '192.0.2.99' })).newPage();
  await signIn(cPage2, COMMITTEE.email, COMMITTEE.password);
  await shot(cPage2, 'FLOW-11-step-3-colleague-other-ip');

  // Recovery: bootstrap-admin for ana while ana's account bucket is locked.
  const out = execFileSync('pnpm', ['exec', 'tsx', 'scripts/bootstrap-admin.ts'], {
    env: {
      ...process.env,
      ADMIN_EMAIL: ANA.email,
      BOOTSTRAP_ADMIN_PASSWORD: 'qa-ana-restored-pass-0001',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'qa-service-role-key',
      DATABASE_URL: process.env.QA_DATABASE_URL,
      DIRECT_URL: process.env.QA_DATABASE_URL,
    },
    encoding: 'utf8',
  });
  console.log('bootstrap output:', out);
  const p3 = await (await newContext(browser, { ip: '192.0.2.77' })).newPage();
  await fillLogin(p3, ANA.email, 'qa-ana-restored-pass-0001');
  await submitLogin(p3);
  const stillLocked = await p3.getByText(/Too many attempts/).isVisible();
  console.log('after bootstrap, ana still locked:', stillLocked, p3.url());
  await shot(p3, 'FLOW-11-step-4-after-bootstrap');
  expect.soft(colleagueLocked, 'a colleague at the same IP is locked out by the victim retrying').toBe(false);
  expect.soft(stillLocked, 'bootstrap-admin restores a throttled admin').toBe(false);
});
