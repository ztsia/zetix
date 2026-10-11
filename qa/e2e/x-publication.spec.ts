/**
 * QA for module X (publication), spec/v3.md §31. Runs against `pnpm demo` (a seeded
 * Autumn Serenade on its own local database), not `start-v.sh`:
 *
 *   DEMO_DATABASE_URL=postgresql://postgres@localhost:55432/zetix_qa_demo node scripts/demo.mjs
 *   X_DB=postgresql://postgres@localhost:55432/zetix_qa_demo pnpm exec playwright test qa/e2e/x-publication.spec.ts
 *
 * Every step asserts first and then screenshots to qa-artifacts/claude-X-publication/screens.
 */
import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import postgres from 'postgres';

const DB = process.env.X_DB ?? 'postgresql://postgres@localhost:55432/zetix_qa_demo';
const SHOTS = 'qa-artifacts/claude-X-publication/screens';
const ADMIN = { email: 'admin@example.org', password: process.env.DEMO_ADMIN_PASSWORD ?? 'demo-admin-pass' };
const VIEWER = { email: 'visitor@example.org', password: process.env.DEMO_VIEWER_PASSWORD ?? 'demo-viewer-pass' };
const USHER_CODE = process.env.DEMO_OPERATOR_CODE ?? 'demo-usher-code';

const sql = postgres(DB, { max: 1, prepare: false, onnotice: () => {} });
test.afterAll(async () => sql.end());
test.describe.configure({ mode: 'serial' });

const evidence: Record<string, unknown> = {};
test.afterAll(() => console.log('X-EVIDENCE ' + JSON.stringify(evidence)));

async function shot(page: Page, name: string, fullPage = false) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 120_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function concertId(): Promise<number> {
  const [c] = await sql`select id from concerts order by id limit 1`;
  return Number(c.id);
}

// ── FLOW-1 ────────────────────────────────────────────────────────────────────
test('FLOW-1 visitor signs in as the viewer and reads Home', async ({ page }) => {
  test.setTimeout(240_000);
  const [role] = await sql`select role::text as role from app_users where email = 'visitor@example.org'`;
  expect(role.role).toBe('VIEWER');
  evidence['FLOW-1 role'] = role.role;

  await page.goto('/login');
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await shot(page, 'FLOW-1-step-1-login');

  await signIn(page, VIEWER);
  const id = await concertId();
  await page.goto(`/admin/concerts/${id}/home`, { waitUntil: 'networkidle', timeout: 120_000 });
  await shot(page, 'FLOW-1-step-2-signed-in');

  await expect(page.getByRole('heading', { name: 'Autumn Serenade' }).first()).toBeVisible();
  const body = await page.locator('main').innerText();
  evidence['FLOW-1 home header'] = body.split('\n').slice(0, 4).join(' | ');
  expect(body).toMatch(/scheduler ran/i);
  expect(body).not.toMatch(/never run/i);
  expect(body).toMatch(/Needs review/);
  await shot(page, 'FLOW-1-step-3-home', true);
});

// ── FLOW-2 ────────────────────────────────────────────────────────────────────
test('FLOW-2 the viewer can change nothing and sees no address or token', async ({ page, request }) => {
  test.setTimeout(240_000);
  await signIn(page, VIEWER);
  const id = await concertId();
  const [party] = await sql`
    select r.id, r.contact_email from registrations r
     where exists (select 1 from attendees a where a.registration_id = r.id and a.qr_token is not null and a.ticket_sent_at is not null)
     order by r.id limit 1`;
  const tokens = (await sql`select qr_token from attendees where registration_id = ${party.id} and qr_token is not null`).map((r) => r.qr_token as string);

  await page.goto(`/admin/concerts/${id}/audience`, { waitUntil: 'networkidle', timeout: 120_000 });
  await shot(page, 'FLOW-2-step-1-audience');
  await expect(page.getByRole('button', { name: /New party/ })).toHaveCount(0);

  const res = await page.goto(`/admin/concerts/${id}/audience/${party.id}`, { waitUntil: 'networkidle', timeout: 120_000 });
  expect(res?.status()).toBe(200);
  const html = await page.content();
  const raw = await (await page.request.get(page.url())).text();
  const leaks = {
    emailInDom: html.includes(party.contact_email),
    emailInRaw: raw.includes(party.contact_email),
    tokenInRaw: tokens.some((t) => raw.includes(t) || html.includes(t)),
    copyLinkButtons: await page.getByRole('button', { name: /Copy link/ }).count(),
    editButtons: await page.getByRole('button', { name: /^Edit$/ }).count(),
  };
  evidence['FLOW-2 party leaks'] = leaks;
  await shot(page, 'FLOW-2-step-2-party-record', true);
  expect(leaks).toEqual({ emailInDom: false, emailInRaw: false, tokenInRaw: false, copyLinkButtons: 0, editButtons: 0 });

  // Settings › Email: the sender name is visible and not editable.
  const [before] = await sql`select value from system_settings where key = 'email.from_name'`;
  await page.goto('/admin/settings', { waitUntil: 'networkidle', timeout: 120_000 });
  const row = page.getByRole('textbox', { name: 'Sender name', exact: true }).locator('xpath=ancestor::div[contains(@class,"border-b")][1]');
  await expect(row).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Sender name', exact: true });
  const editable = (await input.count()) ? await input.first().isEditable() : false;
  evidence['FLOW-2 sender name editable by viewer'] = editable;
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'FLOW-2-step-3-settings-sender-name');
  expect(editable).toBe(false);
  const [after] = await sql`select value from system_settings where key = 'email.from_name'`;
  expect(after.value).toEqual(before.value);
  void request;
});

// ── FLOW-3 ────────────────────────────────────────────────────────────────────
test('FLOW-3 an admin sets the sender name', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, ADMIN);
  await page.goto('/admin/settings', { waitUntil: 'networkidle', timeout: 120_000 });
  const row = page.getByRole('textbox', { name: 'Sender name', exact: true }).locator('xpath=ancestor::div[contains(@class,"border-b")][1]');
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'FLOW-3-step-1-settings');
  const input = page.getByRole('textbox', { name: 'Sender name', exact: true });
  await expect(input).toHaveValue('Lakeside Community Orchestra');
  await input.fill('Lakeside Orchestra (QA)');
  await row.getByRole('button', { name: /Save/ }).click();
  await expect(row.getByText(/Saved|saved/).or(row.locator('svg.lucide-check')).first()).toBeVisible({ timeout: 30_000 });
  const [v] = await sql`select value from system_settings where key = 'email.from_name'`;
  evidence['FLOW-3 db value'] = v.value;
  expect(v.value).toBe('Lakeside Orchestra (QA)');
  await shot(page, 'FLOW-3-step-2-saved');
  // put it back
  await input.fill('Lakeside Community Orchestra');
  await row.getByRole('button', { name: /Save/ }).click();
  await expect.poll(async () => (await sql`select value from system_settings where key = 'email.from_name'`)[0].value).toBe('Lakeside Community Orchestra');
});

// ── FLOW-4 ────────────────────────────────────────────────────────────────────
test('FLOW-4 renamed theme labels, and a stored brand id still applies', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('zetix.console.theme', 'claude'));
  const page = await ctx.newPage();
  await signIn(page, ADMIN);
  const id = await concertId();
  await page.goto(`/admin/concerts/${id}/home`, { waitUntil: 'networkidle', timeout: 120_000 });
  const theme = await page.locator('html').getAttribute('data-theme');
  evidence['FLOW-4 data-theme with stored claude'] = theme;
  expect(theme).toBe('claude');
  await shot(page, 'FLOW-4-step-1-stored-claude');

  await page.getByRole('button', { name: /Appearance/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const text = await menu.innerText();
  evidence['FLOW-4 menu'] = text.replace(/\s+/g, ' ');
  for (const label of ['Terracotta', 'Emerald', 'Mono']) expect(text).toContain(label);
  for (const brand of ['Claude', 'Supabase', 'Vercel']) expect(text).not.toContain(brand);
  // The stored id shows as the renamed label, checked.
  const current = menu.getByRole('menuitemradio', { name: 'Terracotta' }).or(menu.getByRole('menuitemcheckbox', { name: 'Terracotta' })).or(menu.getByRole('menuitem', { name: 'Terracotta' }));
  evidence['FLOW-4 terracotta checked'] = await current.first().getAttribute('aria-checked');
  await shot(page, 'FLOW-4-step-2-appearance-menu');
  await ctx.close();
});

// ── FLOW-7 ────────────────────────────────────────────────────────────────────
test('FLOW-7 no Zetix mark in this repository', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/login');
  const icons = await page.locator('link[rel~="icon"], link[rel="apple-touch-icon"]').evaluateAll((ls) => ls.map((l) => (l as HTMLLinkElement).getAttribute('href')));
  const markOnLogin = await page.locator('svg[aria-label="Zetix"]').count();
  const glyph = await page.locator('svg.lucide-music-4, svg.lucide-music4').count();
  const brandIconStatus = (await page.request.get('/brand/zetix-favicon.svg')).status();
  evidence['FLOW-7'] = { icons, markOnLogin, glyph, brandIconStatus };
  await shot(page, 'FLOW-7-step-1-login-brand');
  expect(icons.some((h) => h?.includes('/brand/'))).toBe(false);
  expect(markOnLogin).toBe(0);
  expect(glyph).toBeGreaterThan(0);
});

// ── FLOW-8 ────────────────────────────────────────────────────────────────────
test('FLOW-8 the console does not scroll sideways with the queue banner', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, ADMIN);
  const id = await concertId();
  const result: Record<string, unknown> = {};
  for (const path of [`/admin/concerts/${id}/home`, `/admin/concerts/${id}/audience`, `/admin/concerts/${id}/checkin`]) {
    await page.goto(path, { waitUntil: 'networkidle', timeout: 120_000 });
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, banner: /failed|queued|waiting/i.test(document.body.innerText.slice(0, 2000)) }));
    result[path] = m;
  }
  evidence['FLOW-8'] = result;
  await page.goto(`/admin/concerts/${id}/home`, { waitUntil: 'networkidle' });
  await shot(page, 'FLOW-8-step-1-home-1280');
  for (const m of Object.values(result) as { sw: number; iw: number }[]) expect(m.sw).toBeLessThanOrEqual(m.iw);
  await ctx.close();
});

// ── FLOW-9 ────────────────────────────────────────────────────────────────────
test('FLOW-9 the demo sends nothing: Resume on a queued message fails closed', async ({ page }) => {
  test.setTimeout(240_000);
  const [row] = await sql`
    insert into email_outbox (registration_id, template_key, purpose, to_email, to_name, subject, body_md, context, status)
    select r.id, 'public_ticket', 'TICKETS', 'qa-flow9@example.net', 'QA', 'qa flow 9', 'hello', '{}'::jsonb, 'QUEUED'
      from registrations r
     where r.status = 'CONFIRMED'
       and not exists (select 1 from email_outbox o where o.registration_id = r.id and o.status in ('QUEUED','SENDING'))
     order by r.id desc limit 1
    returning id`;
  try {
    await signIn(page, ADMIN);
    const id = await concertId();
    await page.goto(`/admin/concerts/${id}/home`, { waitUntil: 'networkidle', timeout: 120_000 });
    const resume = page.getByRole('button', { name: 'Resume' });
    await expect(resume).toBeVisible({ timeout: 30_000 });
    await shot(page, 'FLOW-9-step-1-queued-banner');
    await resume.click();
    await page.waitForTimeout(6000);
    const banner = await page.locator('[data-slot="item"]').first().innerText().catch(() => '');
    const [after] = await sql`select status, attempts, last_error from email_outbox where id = ${row.id}`;
    evidence['FLOW-9'] = { banner: banner.replace(/\s+/g, ' ').slice(0, 300), after };
    await shot(page, 'FLOW-9-step-2-after-resume');
    expect(after.status).not.toBe('SENT');
  } finally {
    await sql`delete from email_outbox where id = ${row.id}`;
  }
});
