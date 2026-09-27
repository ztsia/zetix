import { test, expect, type Browser, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { inspect } from 'node:util';
import postgres from 'postgres';

/**
 * QA for module U — one message the database cannot store, delivered over real
 * IMAP. Run after u-inbox.spec.ts with the IMAP server restarted as
 * `QA_U_POISON=long node qa/support/imap-u.mjs` (see the report's repro).
 */
const DB = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(DB, { prepare: false, max: 2 });
const SHOTS = 'qa-artifacts/claude-U-inbox-scheduler/screens';
const LOG = 'qa-artifacts/claude-U-inbox-scheduler/phase5-e2e.log';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const log = (...a: unknown[]) =>
  appendFileSync(LOG, `QA ${a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 5, breakLength: 160 }))).join(' ')}\n`);
const INBOX = '/admin/concerts/1/inbox';

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || !!isMobile, 'admin is desktop');

async function login(browser: Browser, who: 'admin' | 'viewer') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(who === 'admin' ? 'committee@example.test' : 'mei@example.test');
  await page.locator('input[name="password"]').fill(who === 'admin' ? 'qa-admin-pass' : 'qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await page.close();
  return ctx;
}

test('FLOW-12 one unstorable message wedges the inbox: later replies never arrive', async ({ browser, request }) => {
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  await page.goto(INBOX);
  await shot(page, 'FLOW-12-step-1-before');
  const outcomes: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole('button', { name: 'Check now' }).click();
    const said = page.getByText(/new\.|Nothing new\.|Could not read|not configured/).first();
    await expect(said).toBeVisible({ timeout: 30_000 });
    outcomes.push((await said.innerText()).slice(0, 200));
    await page.waitForTimeout(1000);
  }
  const tick = await request.post('/api/scheduler/tick', { headers: { authorization: 'Bearer qa-cron-secret' }, data: { source: 'manual' } });
  const tickBody = await tick.json().catch(() => null);
  await page.reload();
  await shot(page, 'FLOW-12-step-2-after-two-checks-and-a-tick');
  const after = await sql`select message_id, text from email_messages where message_id = '<qa-alice-q3@guest.example>'`;
  const state = await sql`select folder, last_uid, left(last_error, 160) as last_error from mail_sync_state order by folder`;
  const alertText = await page.getByText('The mailbox could not be read').count();
  log('FLOW-12', { outcomes, tickStatus: tick.status(), tickInbox: tickBody?.inbox?.result?.status, afterPoisonStored: after.length, state, alertShown: alertText });
  expect(after.length).toBe(1);
  await ctx.close();
});

test('FLOW-13 the mailbox error shown to a viewer must not carry a guest\'s contact details', async ({ browser }) => {
  const ctx = await login(browser, 'viewer');
  const page = await ctx.newPage();
  await page.goto(INBOX);
  await shot(page, 'FLOW-13-step-1-viewer-error-alert');
  const html = await page.content();
  const leaks = ['888 7777', '19-888', 'poison.leak@example.test', 'POISON-BODY', 'insert into email_messages'].filter((x) => html.includes(x));
  log('FLOW-13', { leaks });
  expect(leaks.filter((l) => /888|poison\.leak/.test(l))).toEqual([]);
  await ctx.close();
});
