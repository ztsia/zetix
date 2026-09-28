import { test, expect, type Browser, type Page } from '@playwright/test';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import postgres from 'postgres';

/**
 * QA for module U — the Inbox and the scheduler tick. Flows from
 * qa-artifacts/claude-U-inbox-scheduler/02-flows.md (written from the spec
 * before src/ was read). Seed: qa/support/seed-u.mjs; stack: qa/support/start-u.sh
 * (SMTP sink :2526, real IMAP server :1143, stub GoTrue, next dev :3100).
 * Admin is web-first: Desktop Chrome. Runs serially: the flows share one seed.
 */
const DB = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(DB, { prepare: false, max: 2 });
const SHOTS = 'qa-artifacts/claude-U-inbox-scheduler/screens';
const LOG = 'qa-artifacts/claude-U-inbox-scheduler/phase5-e2e.log';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const log = (...a: unknown[]) =>
  appendFileSync(LOG, `QA ${a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 5, breakLength: 160 }))).join(' ')}\n`);
const seed = () => JSON.parse(readFileSync('/tmp/qa-u-seed.json', 'utf8'));
const C = 1;
const INBOX = `/admin/concerts/${C}/inbox`;

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || !!isMobile, 'admin is desktop');

async function login(browser: Browser, who: 'admin' | 'viewer', opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(who === 'admin' ? 'committee@example.test' : 'mei@example.test');
  await page.locator('input[name="password"]').fill(who === 'admin' ? 'qa-admin-pass' : 'qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await page.close();
  return ctx;
}
async function operator(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.locator('input[name="displayName"]').fill('Wei Ling');
  await page.locator('input[name="code"]').fill('qa-op-code');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/scan/login')), page.locator('button[type="submit"]').click()]);
  await page.close();
  return ctx;
}
const sink = (to: string) =>
  existsSync('/tmp/qa-u-sink.jsonl') ? readFileSync('/tmp/qa-u-sink.jsonl', 'utf8').split('\n').filter((l) => l.includes(to)) : [];
const flag = async (rid: number) =>
  (await sql<{ w: boolean }[]>`select flag_reply_waiting w from party_pipeline where registration_id = ${rid}`)[0]?.w;

test('FLOW-1 admin opens the Inbox: waiting threads for this concert only, newest first', async ({ browser }) => {
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  await page.goto(INBOX);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await shot(page, 'FLOW-1-step-1-inbox-waiting');
  const items = page.locator('a[data-slot="item"]');
  const titles = await items.allInnerTexts();
  log('FLOW-1 items', titles.map((t) => t.replace(/\s+/g, ' ').slice(0, 140)));
  expect(titles.length).toBe(2);
  expect(titles[0]).toContain('Alice Tan');
  expect(titles.join('\n')).not.toContain('FOREIGN-CONCERT-REPLY');
  expect(titles.join('\n')).not.toContain('Foreign Family');
  await ctx.close();
});

test('FLOW-8 timestamps render in the concert timezone, not the browser zone', async ({ browser }) => {
  const ctx = await login(browser, 'admin', { timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  await page.goto(INBOX);
  const alice = page.locator('a[data-slot="item"]').filter({ hasText: 'Alice Tan' });
  const text = (await alice.innerText()).replace(/\s+/g, ' ');
  // 2026-09-26T01:30Z = 09:30 in Asia/Kuala_Lumpur, 21:30 on 25 Sep in New York.
  log('FLOW-8', { text });
  await shot(page, 'FLOW-8-step-1-timezone');
  expect(text).toMatch(/9:30/);
  expect(text).not.toMatch(/21:30|9:30\s*PM/i);
  await ctx.close();
});

test('FLOW-1b Check now reads the real IMAP mailbox: the plus-tagged follow-up is stored, the stranger is not', async ({ browser }) => {
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  await page.goto(INBOX);
  await shot(page, 'FLOW-1b-step-1-before-check');
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText(/new\.|Nothing new\.|Could not read|not configured/)).toBeVisible({ timeout: 30_000 });
  const said = await page.getByText(/new\.|Nothing new\.|Could not read|not configured/).first().innerText();
  await page.waitForTimeout(1500);
  await shot(page, 'FLOW-1b-step-2-after-check');
  const rows = await sql`select message_id, text from email_messages where message_id in ('<qa-alice-q2@guest.example>', '<qa-spam@spam.example>', '<qa-old@else.example>')`;
  const state = await sql`select folder, uid_validity, last_uid, last_error from mail_sync_state order by folder`;
  log('FLOW-1b', { said, rows, state });
  expect(said).toContain('1 new');
  expect(rows.map((r) => r.message_id)).toEqual(['<qa-alice-q2@guest.example>']);
  await ctx.close();
});

test('FLOW-2 admin replies from the party record: sent at once, threaded; a later question stays waiting', async ({ browser }) => {
  const s = seed();
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${C}/audience/${s.alice}`);
  await page.getByRole('tab', { name: /Conversation/ }).click();
  await shot(page, 'FLOW-2-step-1-record-conversation');
  const q1 = page.locator('li').filter({ hasText: 'Can my mother use seat 2' });
  await expect(q1).toBeVisible();
  await q1.getByRole('button', { name: 'Reply' }).click();
  await q1.getByRole('textbox', { name: 'Reply' }).fill('Yes — seat 2 can be used by your mother. QA-REPLY-BODY');
  await shot(page, 'FLOW-2-step-2-reply-written');
  await q1.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByText('Reply sent.')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot(page, 'FLOW-2-step-3-reply-sent');
  const [row] = await sql`select id, purpose, status, registration_id, in_reply_to_message_id, message_id from email_outbox where purpose = 'REPLY' order by id desc limit 1`;
  const handled = await sql`select message_id, handled_at from email_messages where message_id in ('<qa-alice-q1@guest.example>', '<qa-alice-q2@guest.example>') order by message_at`;
  const wire = sink('alice@example.test').map((l) => JSON.parse(l).raw as string).filter((r) => r.includes('QA-REPLY-BODY'));
  const raw = wire[0] ?? '';
  const hdr = (n: string) => new RegExp(`^${n}:\\s*(.*)$`, 'im').exec(raw.replace(/\r\n[ \t]+/g, ' '))?.[1]?.trim();
  log('FLOW-2', { row, handled, wireCount: wire.length, messageId: hdr('Message-ID'), inReplyTo: hdr('In-Reply-To'), references: hdr('References'), replyTo: hdr('Reply-To'), flag: await flag(Number(s.alice)) });
  expect(row.status).toBe('SENT');
  expect(Number(row.registration_id)).toBe(Number(s.alice));
  expect(wire.length).toBe(1);
  expect(raw).toContain('qa-alice-q1@guest.example');
  expect(handled.find((h) => h.message_id === '<qa-alice-q1@guest.example>')?.handled_at).not.toBeNull();
  expect(handled.find((h) => h.message_id === '<qa-alice-q2@guest.example>')?.handled_at ?? null).toBeNull();
  await ctx.close();
});

test('FLOW-3 an empty reply cannot be sent', async ({ browser }) => {
  const s = seed();
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${C}/audience/${s.alice}`);
  await page.getByRole('tab', { name: /Conversation/ }).click();
  const q2 = page.locator('li').filter({ hasText: 'IMAP-FOLLOWUP' });
  await q2.getByRole('button', { name: 'Reply' }).click();
  await q2.getByRole('textbox', { name: 'Reply' }).fill('    ');
  const disabled = await q2.getByRole('button', { name: 'Send reply' }).isDisabled();
  await shot(page, 'FLOW-3-step-1-empty-reply-disabled');
  const [{ c }] = await sql`select count(*)::int c from email_outbox where purpose = 'REPLY'`;
  log('FLOW-3', { disabled, replyRows: c });
  expect(disabled).toBe(true);
  expect(c).toBe(1);
  await ctx.close();
});

test('FLOW-4 mark a player reply handled: it leaves Waiting', async ({ browser }) => {
  const s = seed();
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  await page.goto(`${INBOX}/${s.playerThread}`);
  await expect(page.getByRole('button', { name: 'Mark handled' })).toBeVisible();
  await shot(page, 'FLOW-4-step-1-waiting');
  await page.getByRole('button', { name: 'Mark handled' }).click();
  await expect(page.getByRole('button', { name: 'Mark handled' })).toHaveCount(0, { timeout: 15_000 });
  await shot(page, 'FLOW-4-step-2-handled');
  await page.goto(INBOX);
  const titles = await page.locator('a[data-slot="item"]').allInnerTexts();
  await shot(page, 'FLOW-4-step-3-inbox-after');
  const [m] = await sql`select handled_at, handled_by from email_messages where id = ${s.playerQ}`;
  log('FLOW-4', { waitingTitles: titles.map((t) => t.replace(/\s+/g, ' ').slice(0, 80)), handled: m });
  expect(titles.join('\n')).not.toContain('Which door');
  expect(m.handled_at).not.toBeNull();
  expect(m.handled_by).toBe('11111111-1111-4111-8111-111111111111');
  await ctx.close();
});

test('FLOW-5 Bounced view lists the party whose ticket message bounced', async ({ browser }) => {
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  await page.goto(`${INBOX}?view=bounces`);
  const titles = await page.locator('a[data-slot="item"]').allInnerTexts();
  await shot(page, 'FLOW-5-step-1-bounced');
  log('FLOW-5', titles.map((t) => t.replace(/\s+/g, ' ').slice(0, 120)));
  expect(titles.some((t) => t.includes('Daniel') && t.includes('Bounced'))).toBe(true);
  await ctx.close();
});

test('FLOW-9 a player thread opens in the Inbox; a party thread redirects to the record', async ({ browser }) => {
  const s = seed();
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  await page.goto(`${INBOX}/${s.playerThread}`);
  await expect(page.getByText('Which door do players use?')).toBeVisible();
  await shot(page, 'FLOW-9-step-1-player-thread');
  await page.goto(`${INBOX}/${s.aliceThread}`);
  await page.waitForURL(new RegExp(`/audience/${s.alice}$`));
  await shot(page, 'FLOW-9-step-2-party-redirect');
  const foreign = await page.goto(`${INBOX}/${s.foreignThread}`);
  const body = await page.locator('body').innerText();
  await shot(page, 'FLOW-9-step-3-foreign-thread');
  log('FLOW-9', { foreignStatus: foreign?.status(), foreignLeak: body.includes('FOREIGN-CONCERT-REPLY'), url: page.url() });
  expect(body).not.toContain('FOREIGN-CONCERT-REPLY');
  expect(page.url()).not.toContain(`/audience/${s.foreignParty}`);
  await ctx.close();
});

test('FLOW-7 hostile markup in a reply renders as text and never runs', async ({ browser }) => {
  const s = seed();
  const ctx = await login(browser, 'admin');
  const page = await ctx.newPage();
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await page.goto(`/admin/concerts/${C}/audience/${s.alice}`);
  await page.getByRole('tab', { name: /Conversation/ }).click();
  await expect(page.getByText('<script>window.__xss=1</script>', { exact: false })).toBeVisible();
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? null);
  const imgs = await page.locator('li img[src="x"]').count();
  await shot(page, 'FLOW-7-step-1-markup-as-text');
  log('FLOW-7', { xss, dialogs, imgs });
  expect(xss).toBeNull();
  expect(imgs).toBe(0);
  await ctx.close();
});

test('FLOW-6 a viewer reads the Inbox masked, with nothing to press', async ({ browser }) => {
  const s = seed();
  const ctx = await login(browser, 'viewer');
  const page = await ctx.newPage();
  await page.goto(`${INBOX}?view=all`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await shot(page, 'FLOW-6-step-1-viewer-inbox');
  const html = await page.content();
  const checkNow = await page.getByRole('button', { name: 'Check now' }).count();
  await page.goto(`/admin/concerts/${C}/audience/${s.alice}`);
  await page.getByRole('tab', { name: /Conversation/ }).click();
  await shot(page, 'FLOW-6-step-2-viewer-record');
  const recordHtml = await page.content();
  const replyButtons = await page.getByRole('button', { name: 'Reply' }).count();
  const handledButtons = await page.getByRole('button', { name: 'Mark handled' }).count();
  await page.goto(`${INBOX}/${s.playerThread}`);
  await shot(page, 'FLOW-6-step-3-viewer-player-thread');
  const playerHtml = await page.content();
  const leaks = ['alice.personal@example.test', '345 6789', 'alice@example.test', '444 5555', 'player.one@band.example'].filter(
    (sec) => html.includes(sec) || recordHtml.includes(sec) || playerHtml.includes(sec),
  );
  log('FLOW-6', { checkNow, replyButtons, handledButtons, leaks });
  expect(checkNow).toBe(0);
  expect(replyButtons).toBe(0);
  expect(handledButtons).toBe(0);
  expect(leaks).toEqual([]);
  await ctx.close();
});

test('FLOW-10 an operator and an anonymous visitor are refused the Inbox', async ({ browser }) => {
  const s = seed();
  const anon = await browser.newContext();
  const a = await anon.newPage();
  await a.goto(INBOX);
  await shot(a, 'FLOW-10-step-1-anonymous');
  const anonUrl = a.url();
  const anonBody = await a.locator('body').innerText();
  await a.goto(`${INBOX}/${s.playerThread}`);
  const anonThreadBody = await a.locator('body').innerText();
  const opCtx = await operator(browser);
  const o = await opCtx.newPage();
  await o.goto(INBOX);
  await shot(o, 'FLOW-10-step-2-operator');
  const opUrl = o.url();
  const opBody = await o.locator('body').innerText();
  await o.goto(`${INBOX}/${s.playerThread}`);
  const opThreadBody = await o.locator('body').innerText();
  log('FLOW-10', { anonUrl, opUrl, anyLeak: [anonBody, anonThreadBody, opBody, opThreadBody].some((b) => /Which door|Can my mother|Alice Tan/.test(b)) });
  expect(anonUrl).toContain('/login');
  expect(opUrl).not.toContain('/inbox');
  expect([anonBody, anonThreadBody, opBody, opThreadBody].some((b) => /Which door|Can my mother/.test(b))).toBe(false);
  await anon.close();
  await opCtx.close();
});

test('FLOW-11 the tick route over HTTP: bearer only, heartbeat recorded, shown in the Inbox', async ({ browser, request }) => {
  const statuses: Record<string, number> = {};
  const adminCtx = await login(browser, 'admin');
  const cookies = (await adminCtx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  statuses.anonymous = (await request.post('/api/scheduler/tick', { data: { source: 'pg_cron' } })).status();
  statuses.wrong = (await request.post('/api/scheduler/tick', { headers: { authorization: 'Bearer nope' }, data: {} })).status();
  statuses.adminCookie = (await request.post('/api/scheduler/tick', { headers: { cookie: cookies }, data: {} })).status();
  const before = (await sql`select count(*)::int c from scheduler_heartbeat`)[0].c;
  const good = await request.post('/api/scheduler/tick', { headers: { authorization: 'Bearer qa-cron-secret' }, data: { source: 'pg_cron' } });
  statuses.bearer = good.status();
  const report = await good.json().catch(() => null);
  const beats = await sql`select source, finished_at, error from scheduler_heartbeat order by id desc limit 1`;
  const page = await adminCtx.newPage();
  await page.goto(INBOX);
  await shot(page, 'FLOW-11-step-1-inbox-heartbeat');
  const said = await page.getByText(/Scheduler last ran/).innerText();
  log('FLOW-11', { statuses, before, beats, said, dispatch: report?.dispatch, inbox: report?.inbox?.result?.status });
  expect(statuses.anonymous).toBe(401);
  expect(statuses.wrong).toBe(401);
  expect(statuses.adminCookie).toBe(401);
  expect(statuses.bearer).toBe(200);
  expect(beats[0].source).toBe('pg_cron');
  expect(beats[0].finished_at).not.toBeNull();
  await adminCtx.close();
});
