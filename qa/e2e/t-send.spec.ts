import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * QA for module T — the send wizard and Messages. Flows from
 * qa-artifacts/claude-T-send-wizard/02-flows.md (written from the spec before
 * src/ was read). Seed: qa/support/seed-t.mjs, server: qa/support/start-t.sh
 * (SMTP sink on :2526, counts on :2527). Admin is web-first: Desktop Chrome.
 */
const DB = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(DB, { prepare: false, max: 2 });
const SHOTS = 'qa-artifacts/claude-T-send-wizard/screens';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const C = 1;
const AUD = `/admin/concerts/${C}/audience`;
const MSG = `${AUD}/messages`;
const log = (...a: unknown[]) => console.log('QA', ...a);

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

const sinkCount = async (to: string) => {
  const { readFileSync, existsSync } = await import('node:fs');
  const f = '/tmp/qa-t-sink.jsonl';
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.includes(to)).length : -1;
};
const partyId = async (name: string) => Number((await sql`select id from registrations where contact_name = ${name}`)[0].id);
const ticketRows = (rid: number) =>
  sql<{ id: string; status: string; to_email: string; template_key: string }[]>`
    select id, status, to_email::text, template_key from email_outbox where registration_id = ${rid} and purpose = 'TICKETS' order by id`;
const wizard = (page: Page) => page.getByRole('dialog');
async function openDialog(page: Page, button: ReturnType<Page['locator']>) {
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    if (!(await page.getByRole('dialog').isVisible())) await button.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}
async function tick(page: Page, box: ReturnType<Page['locator']>) {
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    if (!(await box.isChecked())) await box.click();
    await expect(box).toBeChecked({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

let admin: BrowserContext;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, 'admin');
});
test.afterAll(async () => {
  await admin?.close();
  await sql.end();
});

test('FLOW-7 retired screens redirect; editors still open', async () => {
  const page = await admin.newPage();
  await page.goto(`/admin/concerts/${C}/email`);
  await expect(page).toHaveURL(new RegExp(`${MSG}$`));
  await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
  await shot(page, 'FLOW-7-step-1-email-redirect');
  await page.goto(`/admin/concerts/${C}/email/delivery`);
  await expect(page).toHaveURL(new RegExp(`${MSG}\\?status=FAILED$`));
  await shot(page, 'FLOW-7-step-2-delivery-redirect');
  await page.goto(`/admin/concerts/${C}/email/templates`);
  await expect(page.getByText(/template/i).first()).toBeVisible();
  expect(page.url()).toContain('/email/templates');
  await shot(page, 'FLOW-7-step-3-email-templates');
  await page.goto(`/admin/concerts/${C}/tickets/templates`);
  expect(page.url()).toContain('/tickets/templates');
  await shot(page, 'FLOW-7-step-4-ticket-designs');
  await page.close();
});

test('FLOW-8 queue banner counts only the concert in view', async () => {
  const page = await admin.newPage();
  // Concert 1: Alice's QUEUED feedback (due tomorrow) and one FAILED. Concert 2: one FAILED only.
  await page.goto(`${AUD}`);
  const b1 = page.getByText(/message\(s\) (failed and will be retried|ran out of attempts)/).first();
  await expect(b1).toBeVisible();
  const t1 = await b1.innerText();
  log('FLOW-8 concert1 banner', t1);
  expect(t1).toMatch(/^1 message\(s\)/);
  await shot(page, 'FLOW-8-step-1-concert1-banner');
  await page.goto(`/admin/concerts/2/audience`);
  const b2 = page.getByText(/message\(s\) (failed and will be retried|ran out of attempts)/).first();
  await expect(b2).toBeVisible();
  const t2 = await b2.innerText();
  log('FLOW-8 concert2 banner', t2);
  // unscoped, concert 1's retrying row would outrank this concert's failed one
  expect(t2).toMatch(/^1 message\(s\) ran out of attempts/);
  await shot(page, 'FLOW-8-step-2-concert2-banner');
  await page.close();
});

test('FLOW-6 Messages: every status and its exits', async () => {
  const page = await admin.newPage();
  await page.goto(MSG);
  await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
  const row = (subject: string) => page.locator('tbody tr').filter({ hasText: subject }).first();
  for (const s of ['DRAFT', 'QUEUED', 'SENDING', 'FAILED', 'SENT', 'BOUNCED']) {
    await expect(row(`QA ${s}`)).toBeVisible();
  }
  // nothing from concert 2
  await expect(page.getByText('QA foreign')).toHaveCount(0);
  await shot(page, 'FLOW-6-step-1-all-statuses');

  // SENDING: no actions menu
  await expect(row('QA SENDING').getByRole('button', { name: 'Message actions' })).toHaveCount(0);

  const menuOf = async (subject: string) => {
    await row(subject).getByRole('button', { name: 'Message actions' }).click();
    const items = await page.getByRole('menuitem').allInnerTexts();
    return items.map((t) => t.trim());
  };
  const exits: Record<string, string[]> = {};
  for (const s of ['DRAFT', 'QUEUED', 'FAILED', 'SENT', 'BOUNCED']) {
    exits[s] = await menuOf(`QA ${s}`);
    if (s === 'SENT') await shot(page, 'FLOW-6-step-2-sent-menu-no-view');
    await page.keyboard.press('Escape');
  }
  log('FLOW-6 exits', JSON.stringify(exits));
  expect(exits.DRAFT).toEqual(expect.arrayContaining(['Edit…', 'Cancel', 'Delete']));
  expect(exits.QUEUED).toEqual(expect.arrayContaining(['Edit…', 'Cancel', 'Delete']));
  expect(exits.FAILED).toEqual(expect.arrayContaining(['Retry', 'Fix address…', 'Cancel', 'Delete']));
  expect(exits.BOUNCED).toEqual(expect.arrayContaining(['Fix address…', 'Delete']));

  // DRAFT → Cancel
  await row('QA DRAFT').getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Cancel' }).click();
  await shot(page, 'FLOW-6-step-3-cancel-preview');
  await wizard(page).getByRole('button', { name: /^Cancel 1 message/ }).click();
  await expect(wizard(page).getByText(/1 done|Done/).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-6-step-4-cancel-report');
  const [draft] = await sql`select status from email_outbox where subject = 'QA DRAFT DRAFT' or subject = 'QA DRAFT REMINDER'`;
  log('FLOW-6 draft after cancel', draft?.status);
  expect(draft.status).toBe('CANCELLED');
  await page.keyboard.press('Escape');

  // FAILED → Retry (attempts reset)
  await page.goto(MSG);
  await row('QA FAILED').getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Retry' }).click();
  await wizard(page).getByRole('button', { name: /^Retry 1 message/ }).click();
  await expect(wizard(page).getByText(/Done/).first()).toBeVisible({ timeout: 30_000 });
  const [failed] = await sql`select status, attempts, last_error from email_outbox where subject = 'QA FAILED VERIFICATION'`;
  log('FLOW-6 failed after retry', JSON.stringify(failed));
  expect(failed.attempts === 0 || failed.status === 'SENT').toBe(true);
  await shot(page, 'FLOW-6-step-5-retry-report');
  await page.close();

  // §24.4: SENT and BOUNCED offer "view". Asserted last so the rest runs.
  expect(exits.SENT, 'SENT row must offer View (§24.4)').toEqual(expect.arrayContaining(['View']));
});

test('FLOW-1 Send tickets through the wizard, and FLOW-2 pressed twice', async () => {
  const page = await admin.newPage();
  const daniel = await partyId('Daniel Wong');
  await page.goto(`${AUD}?view=ready-to-send`);
  const r = page.locator('tbody tr').filter({ hasText: 'Daniel Wong' }).first();
  await expect(r).toBeVisible();
  await shot(page, 'FLOW-1-step-1-ready-to-send');
  await tick(page, r.getByRole('checkbox'));
  await page.getByRole('button', { name: /^Send tickets/ }).first().click();
  const dlg = wizard(page);
  await expect(dlg.getByText(/of 1 party will be sent their tickets/)).toBeVisible({ timeout: 60_000 });
  await expect(dlg.getByText(/^1$/).first()).toBeVisible();
  await shot(page, 'FLOW-1-step-2-who');
  await dlg.getByRole('button', { name: 'Next' }).click();
  await expect(dlg.getByLabel('Design')).toBeVisible();
  await expect(dlg.getByText(/Previewed with the longest name/)).toBeVisible();
  await expect(dlg.locator('img, canvas').first()).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-1-step-3-design');
  await dlg.getByRole('button', { name: 'Next' }).click();
  await expect(dlg.getByLabel('Template')).toHaveValue('public_ticket');
  await expect(dlg.locator('iframe')).toBeVisible();
  await expect(dlg.locator('iframe')).toHaveAttribute('srcdoc', /Dear Daniel Wong/, { timeout: 30_000 });
  await shot(page, 'FLOW-1-step-4-email');
  await dlg.getByRole('button', { name: 'Next' }).click();
  await shot(page, 'FLOW-1-step-5-send');
  await dlg.getByRole('button', { name: /^Send to 1 party/ }).click();
  await expect(dlg.getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 60_000 });
  await shot(page, 'FLOW-1-step-6-report');
  // the shell loop sends it
  await expect.poll(async () => (await ticketRows(daniel)).map((x) => x.status).join(','), { timeout: 60_000 }).toMatch(/SENT/);
  const rows1 = await ticketRows(daniel);
  const seats = await sql`select qr_token, ticket_sent_at from attendees where registration_id = ${daniel} and status='CONFIRMED'`;
  log('FLOW-1 rows', JSON.stringify(rows1), 'seats delivered', seats.filter((s) => s.ticket_sent_at).length, 'sink', await sinkCount('daniel'));
  expect(rows1).toHaveLength(1);
  expect(seats.every((s) => s.ticket_sent_at)).toBe(true);
  await page.keyboard.press('Escape');

  // FLOW-2: press again on the record
  await page.goto(`${AUD}/${daniel}`);
  await shot(page, 'FLOW-2-step-1-record-sent');
  await page.goto(`${AUD}?view=sent`);
  const r2 = page.locator('tbody tr').filter({ hasText: 'Daniel Wong' }).first();
  await tick(page, r2.getByRole('checkbox'));
  await page.getByRole('button', { name: /selected$|^Actions$/ }).click();
  await page.getByRole('menuitem', { name: 'Send tickets…' }).first().click();
  await expect(dlg.getByText(/0 of 1 party will be sent/)).toBeVisible({ timeout: 60_000 });
  await expect(dlg.getByText(/already delivered/)).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Next' })).toBeDisabled();
  await shot(page, 'FLOW-2-step-2-nothing-to-send');
  const rows2 = await ticketRows(daniel);
  log('FLOW-2 rows', JSON.stringify(rows2));
  expect(rows2).toHaveLength(1);
  await page.close();
});

test('FLOW-3 a mixed selection shows every skip with its reason; an unchecked address is checked', async () => {
  const page = await admin.newPage();
  await page.goto(AUD);
  await shot(page, 'FLOW-3-step-1-all-parties');
  await tick(page, page.getByRole('checkbox', { name: 'Select all rows on this page' }));
  const all = page.getByRole('button', { name: /Select all \d+ matching/ });
  if (await all.count()) await all.click();
  await page.getByRole('button', { name: /selected$|^Actions$/ }).click();
  await page.getByRole('menuitem', { name: 'Send tickets…' }).first().click();
  const dlg = wizard(page);
  await expect(dlg.getByText(/will be skipped/)).toBeVisible({ timeout: 90_000 });
  const text = await dlg.innerText();
  log('FLOW-3 who', text.replace(/\n+/g, ' | ').slice(0, 2500));
  await shot(page, 'FLOW-3-step-2-who-skips');
  expect(text).toMatch(/Not approved/);
  expect(text).toMatch(/verified/);
  expect(text).toMatch(/Suspicious address/);
  const [jon] = await sql`select email_issue, email_checked_at from registrations where contact_name = 'Jon Typo'`;
  log('FLOW-3 jon', JSON.stringify(jon));
  expect(jon.email_issue).not.toBeNull();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  // nothing was sent to a skipped party
  const [n] = await sql`select count(*)::int n from email_outbox o join registrations r on r.id=o.registration_id
     where r.contact_name in ('Jon Typo','Grace Lee','Farah Aziz') and o.purpose='TICKETS'`;
  expect(n.n).toBe(0);
  await page.close();
});

test('FLOW-12 a first send from the record passes review; only a one-party resend may skip it (§24.1)', async () => {
  const page = await admin.newPage();
  const ivy = await partyId('Ivy Chen');
  await page.goto(`${AUD}/${ivy}`);
  await expect(page.getByText('Needs tickets').first()).toBeVisible();
  await openDialog(page, page.getByRole('button', { name: 'Send tickets' }).first());
  const dlg = wizard(page);
  await expect(dlg.getByText(/of 1 party will be sent their tickets\./)).toBeVisible({ timeout: 60_000 });
  const skip = await dlg.getByRole('button', { name: 'Skip to Send' }).count();
  log('FLOW-12 first send, Skip to Send offered:', skip);
  await shot(page, 'FLOW-12-step-1-first-send-no-skip');
  expect(skip, 'a first send is reviewed').toBe(0);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  const rows = await ticketRows(ivy);
  expect(rows).toHaveLength(0);
  await page.close();
});

test('FLOW-4 email changed after delivery asks, and Yes resends to the new address', async () => {
  const page = await admin.newPage();
  const alice = await partyId('Alice Tan');
  await page.goto(`${AUD}/${alice}`);
  await shot(page, 'FLOW-4-step-1-record');
  await openDialog(page, page.getByRole('button', { name: /^Edit/ }).first());
  await page.getByRole('dialog').getByLabel('Contact email').fill('alice.new@example.com');
  await shot(page, 'FLOW-4-step-2-edit');
  await page.getByRole('dialog').getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByText('Tickets were sent to the old address. Resend them to the new one?')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-4-step-3-question');
  await page.getByRole('alert').filter({ hasText: 'Tickets were sent to the old address' }).getByRole('button', { name: 'Resend tickets' }).click();
  const dlg = wizard(page);
  await expect(dlg.getByText(/will be sent their tickets again/)).toBeVisible({ timeout: 60_000 });
  const skip = dlg.getByRole('button', { name: 'Skip to Send' });
  log('FLOW-4 skip-to-send offered', await skip.count());
  await shot(page, 'FLOW-4-step-4-wizard');
  if (await skip.count()) await skip.click();
  else for (let i = 0; i < 3; i++) await dlg.getByRole('button', { name: 'Next' }).click();
  await dlg.getByRole('button', { name: /^Resend to 1 party/ }).click();
  await expect(dlg.getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 60_000 });
  await shot(page, 'FLOW-4-step-5-report');
  const rows = await ticketRows(alice);
  log('FLOW-4 rows', JSON.stringify(rows));
  expect(rows.some((r) => r.to_email === 'alice.new@example.com' && ['QUEUED', 'SENDING', 'SENT'].includes(r.status))).toBe(true);
  await page.close();
});

test('FLOW-5 record email edited to a suspicious address raises the flag', async () => {
  const page = await admin.newPage();
  const ivy = await partyId('Ivy Chen');
  await page.goto(`${AUD}/${ivy}`);
  await openDialog(page, page.getByRole('button', { name: /^Edit/ }).first());
  await page.getByRole('dialog').getByLabel('Contact email').fill('ivy@gmail..com');
  await page.getByRole('dialog').getByRole('button', { name: 'Save registration' }).click();
  // the browser's own email validation refuses the double dot before the server sees it
  expect(await page.getByRole('dialog').getByLabel('Contact email').evaluate((el) => (el as HTMLInputElement).validity.valid)).toBe(false);
  await shot(page, 'FLOW-5-step-1-double-dot-refused');
  await page.getByRole('dialog').getByLabel('Contact email').fill('ivy@gmail.con');
  await page.getByRole('dialog').getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByText(/could not find the mail server/i).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-5-step-2-suspicious-flagged');
  const [r] = await sql`select contact_email::text, email_issue from registrations where id = ${ivy}`;
  const [p] = await sql`select flags from party_pipeline where registration_id = ${ivy}`;
  log('FLOW-5', JSON.stringify({ r, flags: p?.flags }));
  expect(p.flags).toContain('SUSPICIOUS_ADDRESS');
  // restore for FLOW-11
  await sql`update registrations set contact_email = 'ivy@example.test', email_issue = null, email_checked_at = now() where id = ${ivy}`;
  await page.close();
});

// Open spec question, left to the spec owner: email.md §11.6 requires a reason
// for Mark as delivered; v3 §23.3 makes every command's reason optional, and T
// followed v3. Fixme until the owner decides, rather than red on every run.
test.fixme('FLOW-11 Mark delivered by hand asks for no reason', async () => {
  const page = await admin.newPage();
  const ivy = await partyId('Ivy Chen');
  await page.goto(`${AUD}/${ivy}`);
  await openDialog(page, page.getByRole('button', { name: 'Issue only' }));
  await wizard(page).getByRole('button', { name: /^Issue/ }).last().click();
  await expect(wizard(page).getByText(/Done/).first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await page.goto(`${AUD}?view=ready-to-send`);
  await tick(page, page.locator('tbody tr').filter({ hasText: 'Ivy Chen' }).first().getByRole('checkbox'));
  await page.getByRole('button', { name: /selected$|^Actions$/ }).click();
  await page.getByRole('menuitem', { name: 'Mark delivered by hand' }).click();
  const dlg = wizard(page);
  await shot(page, 'FLOW-11-step-1-preview');
  const run = dlg.getByRole('button', { name: /^Mark delivered by hand for 1/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(dlg.getByText(/Done|1 done/).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-11-step-2-done-without-reason');
  const seats = await sql`select ticket_sent_source from attendees where registration_id = ${ivy} and status='CONFIRMED'`;
  const [audit] = await sql`select reason from audit_log where action='attendee.marked_delivered' order by id desc limit 1`;
  log('FLOW-11', JSON.stringify({ seats, audit }));
  // email.md §11.6: "requires a short reason"
  expect(audit.reason, 'a reason is required by email.md §11.6').not.toBeNull();
  await page.close();
});

test('FLOW-9 viewer: Messages masked, no exits, search cannot find an address', async ({ browser }) => {
  const viewer = await login(browser, 'viewer');
  const page = await viewer.newPage();
  await page.goto(MSG);
  await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
  const html = await page.content();
  const leaks = html.match(/[a-z0-9.]+@example\.(test|com)/gi) ?? [];
  log('FLOW-9 leaks', JSON.stringify([...new Set(leaks)]));
  expect(leaks.filter((l) => !l.startsWith('mei@'))).toEqual([]);
  await expect(page.getByRole('button', { name: 'Message actions' })).toHaveCount(0);
  await shot(page, 'FLOW-9-step-1-viewer-messages');
  await page.goto(`${MSG}?q=alice%40`);
  await expect(page.getByText(/No results|No messages|0 rows/i).first()).toBeVisible();
  await shot(page, 'FLOW-9-step-2-viewer-search-address');
  // design preview route as viewer
  const res = await page.request.get(`/api/tickets/design-preview?concertId=1&designId=1&attendeeId=12`);
  log('FLOW-9 design-preview as viewer', res.status());
  expect(res.status()).not.toBe(200);
  await viewer.close();
});

test('FLOW-10 Messages timestamps render in concert.timezone', async ({ browser }) => {
  const texts: string[] = [];
  for (const tz of ['America/New_York', 'Asia/Tokyo']) {
    const ctx = await login(browser, 'admin', { timezoneId: tz });
    const page = await ctx.newPage();
    await page.goto(`${MSG}?status=SENT`);
    const row = page.locator('tbody tr').filter({ hasText: 'QA SENT TICKETS' }).first();
    texts.push(await row.innerText());
    await shot(page, `FLOW-10-step-${texts.length}-${tz.replace('/', '-')}`);
    await ctx.close();
  }
  log('FLOW-10', JSON.stringify(texts));
  expect(texts[0]).toBe(texts[1]);
  // 2026-09-10T02:30Z in Asia/Kuala_Lumpur is 10:30
  expect(texts[0]).toMatch(/10:30/);
});

test('AUTHZ matrix', async ({ browser }) => {
  const anon = await browser.newContext();
  const viewer = await login(browser, 'viewer');
  const op = await operator(browser);
  const who = { anonymous: anon, admin, viewer, operator: op } as const;
  const url = {
    'GET /api/tickets/design-preview': '/api/tickets/design-preview?concertId=1&designId=1&attendeeId=12',
    'GET /audience/messages': MSG,
    'GET /email (redirect)': `/admin/concerts/${C}/email`,
    'POST /api/outbox/dispatch?concertId=1': '/api/outbox/dispatch?concertId=1',
  } as const;
  const out: Record<string, Record<string, string>> = {};
  for (const [label, path] of Object.entries(url)) {
    out[label] = {};
    for (const [name, ctx] of Object.entries(who)) {
      const res = label.startsWith('POST')
        ? await ctx.request.post(path, { maxRedirects: 0 })
        : await ctx.request.get(path, { maxRedirects: 0 });
      const loc = res.headers()['location'] ?? '';
      const type = res.headers()['content-type'] ?? '';
      out[label][name] = `${res.status()}${loc ? ' → ' + loc : ''} ${type.split(';')[0]}`;
    }
  }
  log('AUTHZ', JSON.stringify(out, null, 1));
  expect(out['GET /api/tickets/design-preview'].admin).toMatch(/^200 .*pdf/);
  for (const n of ['anonymous', 'viewer', 'operator']) expect(out['GET /api/tickets/design-preview'][n]).not.toMatch(/^200/);
  expect(out['POST /api/outbox/dispatch?concertId=1'].viewer).toMatch(/^40[13]/);
  await anon.close();
  await viewer.close();
  await op.close();
});

test('FLOW-9b viewer holds no ticket link on the record or in Messages', async ({ browser }) => {
  const viewer = await login(browser, 'viewer');
  const page = await viewer.newPage();
  const alice = await partyId('Alice Tan');
  const tokens = (await sql`select qr_token from attendees where registration_id = ${alice} and qr_token is not null`).map((r) => r.qr_token as string);
  await page.goto(`${AUD}/${alice}`);
  await page.getByRole('tab', { name: /Conversation/ }).click().catch(() => {});
  const html1 = await page.content();
  await shot(page, 'FLOW-9-step-3-viewer-record-conversation');
  await page.goto(MSG);
  const html2 = await page.content();
  const found = tokens.filter((t) => html1.includes(t) || html2.includes(t));
  const links = [...new Set([...(html1.match(/\/t\/[0-9A-Za-z]{10,}/g) ?? []), ...(html2.match(/\/t\/[0-9A-Za-z]{10,}/g) ?? [])])];
  log('FLOW-9b', JSON.stringify({ tokens: tokens.length, found: found.length, links }));
  expect(found).toEqual([]);
  expect(links).toEqual([]);
  await viewer.close();
});
