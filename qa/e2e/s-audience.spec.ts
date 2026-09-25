import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * QA for module S — the Audience workspace. Flows from
 * qa-artifacts/claude-S-audience-workspace/02-flows.md (written from the spec
 * before src/ was read). Seed: qa/support/seed-s.mjs, server: start-s.sh.
 * Admin is web-first: Desktop Chrome only.
 */
const DB = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(DB, { prepare: false, max: 2 });
const SHOTS = 'qa-artifacts/claude-S-audience-workspace/screens';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const C = 1;
const AUD = `/admin/concerts/${C}/audience`;

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || !!isMobile, 'admin is desktop');

let admin: BrowserContext;
let ids: Record<string, string>;
let foreignParty: number;

async function asAdmin(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.getByRole('button', { name: 'Sign in' }).click()]);
  await page.close();
  return ctx;
}
async function asOperator(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.fill('input[name="displayName"]', 'Wei Ling');
  await page.fill('input[name="code"]', 'qa-op-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/scan\/\d+/);
  await page.close();
  return ctx;
}
const rowsText = (page: Page) => page.getByText(/^\d+ rows?$/).first();
const rowCount = async (page: Page) => Number((await rowsText(page).innerText()).split(' ')[0]);
const tableRow = (page: Page, text: string) => page.locator('tbody tr').filter({ hasText: text }).first();

async function openAction(page: Page, label: string) {
  await page.getByRole('button', { name: /selected$|^Actions$/ }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function runDialog(page: Page, runName: RegExp | string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: runName }).last().click();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(2, { timeout: 30_000 });
}

test.beforeAll(async ({ browser }) => {
  // Seed once per run: a worker restarted after a failing test must not reseed mid-run.
  const MARK = '/tmp/s-audience-seed.json';
  if (!existsSync(MARK)) {
    const out = execFileSync('node', ['qa/support/seed-s.mjs'], { env: { ...process.env, QA_DATABASE_URL: DB }, encoding: 'utf8' });
    writeFileSync(MARK, out.trim().split('\n').at(-1)!);
  }
  ids = JSON.parse(readFileSync(MARK, 'utf8'));
  // A second concert with one live party: must never be reachable from concert 1.
  const existing = await sql`select r.id from registrations r join shows s on s.id = r.show_id join concerts c on c.id = s.concert_id where c.slug = 'other-s'`;
  if (existing.length) { foreignParty = Number(existing[0].id); admin = await asAdmin(browser); return; }
  const [c2] = await sql`insert into concerts (name, slug, status, timezone) values ('Other S','other-s','ACTIVE','Europe/London') returning id`;
  const [s2] = await sql`insert into shows (concert_id, name, status, capacity, starts_at) values (${c2.id}, 'Other Show', 'OPEN', 50, now() + interval '20 days') returning id`;
  const [g2] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, extras_policy) values (${s2.id}, 'Pub', 'PUBLIC', 50, 'AUTO_FCFS') returning id`;
  const [r2] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, approved_at)
    values (${s2.id}, ${g2.id}, 'ADMIN', 'Foreign Family', 'foreign@example.test', 'WAITLIST', now(), now()) returning id`;
  await sql`select claim_seats(${g2.id}::bigint, ${r2.id}::bigint, '[{"full_name":"Foreign Guest","allocation_type":"EXTRA"}]'::jsonb, false)`;
  foreignParty = Number(r2.id);
  admin = await asAdmin(browser);
});
test.afterAll(async () => {
  await admin?.close();
  await sql.end();
});

// ---------------------------------------------------------------------------
test('FLOW-14 anonymous is sent to login with no party data', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const [n, path] of [[1, AUD], [2, `${AUD}/${ids.alice}`]] as const) {
    const res = await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
    const body = await page.content();
    expect(body).not.toContain('Alice Tan');
    expect(body).not.toContain('alice@example.test');
    expect(res?.status()).toBeLessThan(500);
    await shot(page, `FLOW-14-step-${n}-anon-${n === 1 ? 'audience' : 'record'}`);
  }
  await ctx.close();
});

test('FLOW-13 operator is refused the Audience, the record and the command action', async ({ browser }) => {
  // Capture a real command-preview Server Action call as admin, then replay it as others.
  const page = await admin.newPage();
  await page.goto(`${AUD}/${ids.alice}`);
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  page.on('request', (req) => {
    const h = req.headers();
    if (req.method() === 'POST' && h['next-action'] && !captured) {
      captured = { url: req.url(), headers: h, body: req.postData() ?? '' };
    }
  });
  await page.getByRole('button', { name: 'Dismiss as cosmetic' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  expect(captured).not.toBeNull();

  const op = await asOperator(browser);
  const opPage = await op.newPage();
  await opPage.goto(AUD);
  await expect(opPage).not.toHaveURL(new RegExp(`${AUD}$`));
  expect(await opPage.content()).not.toContain('alice@example.test');
  await shot(opPage, 'FLOW-13-step-1-operator-audience');
  await opPage.goto(`${AUD}/${ids.alice}`);
  expect(await opPage.content()).not.toContain('alice@example.test');
  await shot(opPage, 'FLOW-13-step-2-operator-record');

  const c = captured!;
  const replay = async (ctx: BrowserContext) => {
    const res = await ctx.request.post(c.url, {
      headers: { 'next-action': c.headers['next-action'], 'content-type': c.headers['content-type'] ?? 'text/plain;charset=UTF-8', accept: 'text/x-component' },
      data: c.body,
      maxRedirects: 0,
    });
    return { status: res.status(), body: await res.text() };
  };
  const asOp = await replay(op);
  const anonCtx = await browser.newContext();
  const asAnon = await replay(anonCtx);
  const asAdm = await replay(admin);
  test.info().annotations.push({ type: 'replay', description: JSON.stringify({ op: [asOp.status, asOp.body.slice(0, 300)], anon: [asAnon.status, asAnon.body.slice(0, 300)], admin: [asAdm.status, asAdm.body.slice(0, 120)] }) });
  expect(asAdm.body).toContain('Alice Tan');
  expect(asOp.body).not.toContain('Alice Tan');
  expect(asAnon.body).not.toContain('Alice Tan');
  await opPage.setContent(`<pre style="white-space:pre-wrap;font:14px monospace">Server Action replay (command preview)\n\nADMIN    ${asAdm.status} contains "Alice Tan": ${asAdm.body.includes('Alice Tan')}\nOPERATOR ${asOp.status} contains "Alice Tan": ${asOp.body.includes('Alice Tan')}\n  ${asOp.body.slice(0, 200).replace(/</g, '&lt;')}\nANON     ${asAnon.status} contains "Alice Tan": ${asAnon.body.includes('Alice Tan')}\n  ${asAnon.body.slice(0, 200).replace(/</g, '&lt;')}</pre>`);
  await shot(opPage, 'FLOW-13-step-3-action-replay');
  await op.close();
  await anonCtx.close();
  await page.close();
});

test('FLOW-12 retired screens lead to their Audience view', async () => {
  const page = await admin.newPage();
  const cases: [string, RegExp, string][] = [
    ['/registrations', new RegExp(`${AUD}$`), 'registrations'],
    ['/registrations/unverified', /audience\?view=unverified$/, 'unverified'],
    ['/extras-review', /audience\?view=needs-review$/, 'extras-review'],
    ['/tickets', /audience\?grain=seats$/, 'tickets'],
  ];
  let n = 1;
  for (const [from, to, name] of cases) {
    await page.goto(`/admin/concerts/${C}${from}`);
    await expect(page).toHaveURL(to);
    await expect(page.getByRole('heading', { name: 'Audience', level: 1 })).toBeVisible();
    await shot(page, `FLOW-12-step-${n++}-${name}`);
  }
  // Ticket designs stay reachable.
  const res = await page.goto(`/admin/concerts/${C}/tickets/templates`);
  expect(res?.status()).toBe(200);
  await shot(page, `FLOW-12-step-${n}-ticket-designs-still-there`);
  await page.close();
});

test('FLOW-1 every view count equals its rows and the pipeline', async () => {
  const page = await admin.newPage();
  await page.goto(AUD);
  await shot(page, 'FLOW-1-step-1-all');
  const [{ n: all }] = await sql`select count(*)::int as n from party_pipeline where concert_id = ${C}`;
  expect(await rowCount(page)).toBe(all);
  const views = page.getByRole('navigation', { name: 'Views' }).getByRole('button');
  const labels = (await views.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  test.info().annotations.push({ type: 'views-offered', description: labels.join(' | ') });
  let step = 2;
  const stageOf: Record<string, string> = {
    'Needs review': "stage = 'NEEDS_REVIEW'", Unverified: "stage = 'UNVERIFIED'", 'Needs tickets': "stage = 'NEEDS_TICKETS'",
    'Ready to send': "stage = 'READY_TO_SEND'", Sent: "stage = 'SENT'", Admitted: "stage = 'ADMITTED'", Waitlisted: "stage = 'WAITLISTED'",
    Cancelled: "stage = 'CANCELLED'", 'Suspicious address': 'flag_suspicious_address', 'Changed after send': 'flag_changed_after_send',
    'Unnamed guests': 'flag_unnamed_guests',
  };
  for (const label of labels) {
    const m = label.match(/^(.*) (\d+)$/);
    if (!m || m[1] === 'All') continue;
    const [name, count] = [m[1], Number(m[2])];
    await views.filter({ hasText: name }).first().click();
    await expect(page).toHaveURL(/view=/);
    if (count === 0) await expect(page.getByText(/No |nothing/i).first()).toBeVisible();
    else await expect(rowsText(page)).toHaveText(`${count} row${count === 1 ? '' : 's'}`);
    if (stageOf[name]) {
      const [{ n }] = await sql.unsafe(`select count(*)::int as n from party_pipeline where concert_id = ${C} and ${stageOf[name]}`);
      expect([name, count]).toEqual([name, n]);
    }
    await shot(page, `FLOW-1-step-${step++}-${name.toLowerCase().replace(/\W+/g, '-')}`);
  }
  // Linkable: open a view cold in a fresh tab.
  const cold = await admin.newPage();
  await cold.goto(`${AUD}?view=suspicious-address`);
  await expect(tableRow(cold, 'Grace Lee')).toBeVisible();
  await expect(rowsText(cold)).toHaveText('1 row');
  await shot(cold, `FLOW-1-step-${step++}-cold-link`);
  // Sad: an unknown view does not 500.
  const res = await cold.goto(`${AUD}?view=no-such-view`);
  expect(res?.status()).toBe(200);
  test.info().annotations.push({ type: 'unknown-view-rows', description: String(await rowCount(cold)) });
  await shot(cold, `FLOW-1-step-${step++}-unknown-view`);
  // The flag views the spec lists (§22.2) that have no parties today
  const missing = ['Bounced', 'Send failed', 'Possible duplicates', 'Replies'].filter((v) => !labels.some((l) => l.startsWith(v)));
  test.info().annotations.push({ type: 'views-missing-when-zero', description: missing.join(', ') });
  await cold.close();
  await page.close();
});

test('FLOW-2 Seats grain keeps the queue', async () => {
  const page = await admin.newPage();
  await page.goto(`${AUD}?view=needs-review`);
  await shot(page, 'FLOW-2-step-1-needs-review-parties');
  await page.getByRole('group', { name: 'Show parties or seats' }).getByRole('button', { name: 'Seats' }).click();
  await expect(page).toHaveURL(/grain=seats/);
  await expect(page).toHaveURL(/view=needs-review/);
  const [{ n }] = await sql`select count(*)::int as n from attendees a join party_pipeline p on p.registration_id = a.registration_id
                              where p.concert_id = ${C} and p.stage = 'NEEDS_REVIEW' and a.deleted_at is null`;
  await expect(rowsText(page)).toHaveText(`${n} rows`);
  await expect(page.locator('thead').getByText('Ticket', { exact: true })).toBeVisible();
  await shot(page, 'FLOW-2-step-2-needs-review-seats');
  await page.close();
});

test('FLOW-3 pool meter equals the engine', async () => {
  const page = await admin.newPage();
  await page.goto(`${AUD}?view=needs-review`);
  const [{ p }] = await sql`select segment_pool(${ids.playerSegment}::bigint) as p`;
  const meter = page.getByRole('region', { name: 'Extras pool' });
  await expect(meter).toContainText(new RegExp(`${p.extras_pool}\\s*seats? left in the pool`));
  await expect(meter).toContainText(`${p.confirmed} of ${p.sellable} confirmed`);
  await shot(page, 'FLOW-3-step-1-pool-meter');
  await page.close();
});

test('FLOW-4 Grant extras walks first come first and stops at the first party that does not fit', async () => {
  // Shrink the pool to 3 by seating a 93-seat COMP party in the player segment.
  const seg = Number(ids.playerSegment);
  const [pre] = await sql`select segment_pool(${seg}::bigint) as p`;
  const fill = pre.p.extras_pool - 3;
  const [r] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, approved_at)
    values (${ids.show1}, ${seg}, 'ADMIN', 'Block Booking', 'block@example.test', 'WAITLIST', now(), now()) returning id`;
  await sql`select claim_seats(${seg}::bigint, ${r.id}::bigint, ${JSON.stringify(Array.from({ length: fill }, (_, i) => ({ full_name: `Block ${i}`, allocation_type: 'COMP' })))}::text::jsonb, false)`;
  const [{ p }] = await sql`select segment_pool(${seg}::bigint) as p`;
  expect(p.extras_pool).toBe(3);

  const page = await admin.newPage();
  await page.goto(`${AUD}?view=needs-review`);
  await expect(page.getByRole('region', { name: 'Extras pool' })).toContainText('3');
  await shot(page, 'FLOW-4-step-1-pool-3');
  await page.getByRole('checkbox', { name: 'Select all rows on this page' }).check();
  await openAction(page, 'Grant extras');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('3 left in the pool');
  await shot(page, 'FLOW-4-step-2-preview');
  await runDialog(page, /^Grant extras/);
  await shot(page, 'FLOW-4-step-3-report');
  const rows = await sql`select r.contact_name, count(*) filter (where a.status='CONFIRMED' and a.allocation_type='EXTRA')::int as granted,
                                count(*) filter (where a.status='PENDING_REVIEW')::int as pending
                           from registrations r join attendees a on a.registration_id = r.id
                          where r.contact_name like 'Player %' and a.deleted_at is null group by 1 order by 1`;
  test.info().annotations.push({ type: 'grant-result', description: JSON.stringify(rows) });
  const [{ p: after }] = await sql`select segment_pool(${seg}::bigint) as p`;
  expect(after.confirmed).toBeLessThanOrEqual(after.sellable);
  // Player 1 (2 asked) and Player 2 (1 asked) fit the 3; Player 3 (3) does not; Player 4 comes after the stop.
  expect(rows.map((x) => [x.contact_name, x.granted, x.pending])).toEqual([
    ['Player 1', 2, 0], ['Player 2', 1, 0], ['Player 3', 0, 3], ['Player 4', 0, 1],
  ]);
  await expect(dialog).toContainText(/Does not fit/);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.reload();
  await shot(page, 'FLOW-4-step-4-after');
  await page.close();
});

test('FLOW-5 party record: header, seats, sections', async () => {
  const page = await admin.newPage();
  await page.goto(`${AUD}?view=sent`);
  await tableRow(page, 'Alice Tan').getByRole('link', { name: 'Alice Tan' }).click();
  await expect(page).toHaveURL(new RegExp(`/audience/${ids.alice}$`));
  await expect(page.getByRole('heading', { name: 'Alice Tan', level: 1 })).toBeVisible();
  await expect(page.getByText('alice@example.test')).toBeVisible();
  await expect(page.getByText('Evening Show · Public')).toBeVisible();
  await expect(page.getByText(/Form, Round 1/)).toBeVisible();
  await expect(page.getByRole('main').getByText('Sent', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('main').getByText('Changed after send').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'More actions' })).toBeVisible();
  await shot(page, 'FLOW-5-step-1-header');
  const seatsRegion = page.getByRole('region', { name: /^Seats/ });
  await expect(seatsRegion.getByRole('row')).toHaveCount(4);
  await expect(seatsRegion).toContainText('ORC-');
  await expect(seatsRegion).toContainText('Default v1');
  await page.getByRole('button', { name: 'Actions for Alice Tan' }).click();
  const items = await page.getByRole('menuitem').allInnerTexts();
  test.info().annotations.push({ type: 'seat-actions', description: items.join(' | ') });
  for (const want of ['Download PDF', 'Reissue', 'Void and re-issue QR', 'Check in', 'Delete']) expect(items.join('|')).toContain(want);
  await shot(page, 'FLOW-5-step-2-seat-actions');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Activity/ }).click();
  await shot(page, 'FLOW-5-step-3-activity');
  await page.getByRole('tab', { name: /Responses/ }).click();
  await shot(page, 'FLOW-5-step-4-responses');
  await page.close();
});

test('FLOW-16 timestamps render in the concert zone, not the browser zone', async ({ browser }) => {
  const ny = await asAdmin(browser, { timezoneId: 'America/New_York' });
  const page = await ny.newPage();
  await page.goto(`${AUD}/${ids.alice}`);
  const [{ local }] = await sql`select to_char(requested_at at time zone 'Asia/Kuala_Lumpur', 'FMDD') || ' Sept 2026, ' || to_char(requested_at at time zone 'Asia/Kuala_Lumpur', 'HH24:MI') as local from registrations where id = ${ids.alice}`;
  await expect(page.getByText(new RegExp(`requested ${local}`))).toBeVisible();
  await shot(page, 'FLOW-16-step-1-new-york-browser');
  await page.goto(AUD);
  await expect(tableRow(page, 'Alice Tan')).toContainText(local);
  await shot(page, 'FLOW-16-step-2-table-new-york-browser');
  await ny.close();
});

test('FLOW-15 another concert’s party under this concert’s URL is a 404', async () => {
  const page = await admin.newPage();
  const res = await page.goto(`${AUD}/${foreignParty}`);
  expect(res?.status()).toBe(404);
  expect(await page.content()).not.toContain('Foreign Family');
  await shot(page, 'FLOW-15-step-1-foreign-404');
  const res2 = await page.goto(`${AUD}/abc`);
  expect(res2?.status()).toBe(404);
  const res3 = await page.goto(`/admin/concerts/999999/audience`);
  expect(res3?.status()).toBe(404);
  await shot(page, 'FLOW-15-step-2-bad-ids-404');
  await page.close();
});

test('FLOW-6 edit contact email: typo flagged, pending re-addressed, sent kept, resend question', async () => {
  const farah = Number(ids.unverified);
  await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, sent_at) values
    (${farah}, 'RECEIPT', 'registration_receipt', 'farah@example.test', 'Receipt', 'b', 'SENT', now() - interval '1 day'),
    (${farah}, 'VERIFICATION', 'public_verify', 'farah@example.test', 'Verify', 'b', 'QUEUED', null)`;
  const page = await admin.newPage();
  await page.goto(`${AUD}/${farah}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Contact email').fill('farah@gmail..com');
  await shot(page, 'FLOW-6-step-1-typo-entered');
  await dialog.getByRole('button', { name: 'Save registration' }).click();
  await page.waitForTimeout(800);
  const [still] = await sql`select contact_email::text as e from registrations where id = ${farah}`;
  expect(still.e).toBe('farah@example.test');
  await shot(page, 'FLOW-6-step-2-double-dot-refused');

  await dialog.getByLabel('Contact email').fill('farah@gmail.con');
  await dialog.getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByText(/looks wrong/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/will go to the new address/)).toBeVisible();
  await shot(page, 'FLOW-6-step-3-saved-with-warning');
  const [reg] = await sql`select contact_email::text as e, email_issue from registrations where id = ${farah}`;
  expect(reg.e).toBe('farah@gmail.con');
  expect(reg.email_issue).not.toBeNull();
  const mail = await sql`select status, to_email::text as to_email from email_outbox where registration_id = ${farah} order by id`;
  expect(mail.map((m) => [m.status, m.to_email])).toEqual([['SENT', 'farah@example.test'], ['QUEUED', 'farah@gmail.con']]);
  await page.reload();
  await expect(page.getByRole('main').getByText('Suspicious address').first()).toBeVisible();
  await shot(page, 'FLOW-6-step-4-flagged');

  // Delivered tickets: the resend question (the resend itself is T's).
  await page.goto(`${AUD}/${ids.alice}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Contact email').fill('alice.new@example.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByText(/Tickets were sent to the old address/)).toBeVisible({ timeout: 20_000 });
  await shot(page, 'FLOW-6-step-5-resend-question');
  await page.close();
});

test('FLOW-7 rename a delivered seat flags it for reissue', async () => {
  const page = await admin.newPage();
  await page.goto(`${AUD}/${ids.alice}`);
  // Sad first, with the seed's template as it is (layout element type 'text', lower case).
  const [bern] = await sql`select id, full_name, needs_reissue from attendees where full_name = 'Bernard Lim'`;
  await page.getByRole('button', { name: 'Rename Bernard Lim' }).click();
  await page.getByLabel('Guest name').fill('Bernard Lim Jr');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(2000);
  const [bernAfter] = await sql`select full_name, needs_reissue from attendees where id = ${bern.id}`;
  test.info().annotations.push({ type: 'rename-with-bad-template', description: JSON.stringify(bernAfter) });
  await shot(page, 'FLOW-7-step-1-rename-error');
  // Now a valid layout, as the template editor would store it.
  await sql`update ticket_templates set layout = '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[{"id":"n","type":"TEXT","binding":"attendee.full_name","x":20,"y":20,"w":300,"h":30}]}'::jsonb`;
  await page.reload();
  const [cheryl] = await sql`select id, needs_reissue from attendees where full_name = 'Cheryl Ng'`;
  expect(cheryl.needs_reissue).toBe(false);
  await page.getByRole('button', { name: 'Rename Cheryl Ng' }).click();
  await page.getByLabel('Guest name').fill('Cheryl Ng Mei Ling');
  await shot(page, 'FLOW-7-step-2-rename');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await sql`select needs_reissue from attendees where id = ${cheryl.id}`)[0].needs_reissue, { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect(page.locator('tr').filter({ hasText: 'Cheryl Ng Mei Ling' })).toContainText('Changed after send');
  await shot(page, 'FLOW-7-step-3-flagged');
  await page.close();
});

test('FLOW-9 Reissue from the record keeps the QR', async () => {
  const [seat] = await sql`select id, qr_token, ticket_code, ticket_template_version from attendees where full_name = 'Daniel Wong'`;
  const page = await admin.newPage();
  await page.goto(`${AUD}/${ids.daniel}`);
  await page.getByRole('button', { name: 'Actions for Daniel Wong' }).click();
  await page.getByRole('menuitem', { name: 'Reissue', exact: true }).click();
  await shot(page, 'FLOW-9-step-1-preview');
  await runDialog(page, /^Reissue/);
  await shot(page, 'FLOW-9-step-2-report');
  const [after] = await sql`select qr_token, ticket_code from attendees where id = ${seat.id}`;
  expect(after.qr_token).toBe(seat.qr_token);
  expect(after.ticket_code).toBe(seat.ticket_code);
  await page.close();
});

test('FLOW-8 Void and re-issue QR on three seats needs the typed phrase', async () => {
  const before = await sql`select id, qr_token, ticket_code from attendees where registration_id = ${ids.alice} order by id`;
  const page = await admin.newPage();
  await page.goto(`${AUD}?grain=seats&q=${encodeURIComponent('Alice Tan')}`);
  await page.goto(`${AUD}?grain=seats`);
  for (const s of before) {
    const code = s.ticket_code as string;
    await tableRow(page, code).getByRole('checkbox').check();
  }
  await shot(page, 'FLOW-8-step-1-three-selected');
  await openAction(page, 'Void and re-issue QR');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/refused at the door/);
  const phraseLabel = await dialog.locator('label[for="command-phrase"] span').innerText();
  const runBtn = dialog.getByRole('button', { name: /^Void and re-issue/ }).last();
  await dialog.locator('#command-phrase').fill('void 3 seats');
  await expect(runBtn).toBeDisabled();
  await shot(page, 'FLOW-8-step-2-wrong-phrase-disabled');
  await dialog.locator('#command-phrase').fill(phraseLabel);
  await expect(runBtn).toBeEnabled();
  await shot(page, 'FLOW-8-step-3-right-phrase');
  await runBtn.click();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(2, { timeout: 30_000 });
  await shot(page, 'FLOW-8-step-4-report');
  const after = await sql`select id, qr_token, ticket_code, ticket_sent_at from attendees where registration_id = ${ids.alice} order by id`;
  for (let i = 0; i < before.length; i++) {
    expect(after[i].qr_token).not.toBe(before[i].qr_token);
    expect(after[i].ticket_code).not.toBe(before[i].ticket_code);
    expect(after[i].ticket_sent_at).toBeNull();
  }
  const [{ n }] = await sql`select count(*)::int as n from audit_log where action = 'attendee.qr_voided'`;
  expect(n).toBe(3);
  const [{ stage }] = await sql`select stage from party_pipeline where registration_id = ${ids.alice}`;
  expect(stage).toBe('READY_TO_SEND');
  test.info().annotations.push({ type: 'phrase', description: phraseLabel });
  await page.close();
});

test('FLOW-11 Send verification reminder twice leaves one pending message', async () => {
  const farah = Number(ids.unverified);
  await sql`update email_outbox set status = 'CANCELLED' where registration_id = ${farah} and status = 'QUEUED'`;
  const page = await admin.newPage();
  for (const n of [1, 2]) {
    await page.goto(`${AUD}/${farah}`);
    await page.getByRole('button', { name: 'Send reminder' }).click();
    await shot(page, `FLOW-11-step-${n * 2 - 1}-preview-${n}`);
    const dialog = page.getByRole('dialog');
    const runBtn = dialog.getByRole('button', { name: /^Send reminder/ }).last();
    if (await runBtn.isEnabled()) {
      await runBtn.click();
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(2, { timeout: 30_000 });
    }
    await shot(page, `FLOW-11-step-${n * 2}-after-${n}`);
    await page.keyboard.press('Escape');
  }
  const [{ n }] = await sql`select count(*)::int as n from email_outbox where registration_id = ${farah} and purpose = 'VERIFICATION' and status in ('DRAFT','QUEUED','SENDING')`;
  expect(n).toBe(1);
  await page.close();
});

test('FLOW-10 Cancel from the record, then Restore', async () => {
  const grace = Number(ids.suspicious);
  await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status) values
    (${grace}, 'TICKETS', 'public_ticket', 'grace@gmail.con', 'Tickets', 'b', 'DRAFT')`;
  const page = await admin.newPage();
  await page.goto(`${AUD}/${grace}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Cancel', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/withdrawn/);
  await shot(page, 'FLOW-10-step-1-cancel-preview');
  await runDialog(page, /^Cancel \d/);
  await shot(page, 'FLOW-10-step-2-cancel-report');
  const [{ stage }] = await sql`select stage from party_pipeline where registration_id = ${grace}`;
  expect(stage).toBe('CANCELLED');
  const [mail] = await sql`select status from email_outbox where registration_id = ${grace} and purpose = 'TICKETS'`;
  expect(mail.status).toBe('CANCELLED');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.reload();
  await page.getByRole('button', { name: 'Restore' }).first().click();
  await runDialog(page, /^Restore/);
  await shot(page, 'FLOW-10-step-3-restored');
  const seats = await sql`select status from attendees where registration_id = ${grace} and deleted_at is null`;
  expect(seats.map((s) => s.status)).toEqual(['CONFIRMED']);
  await page.close();
});

test('FLOW-18 select all matching resolves on the server and honours exclusions', async () => {
  const seg = Number(ids.publicSegment);
  const [r] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, approved_at)
    values (${ids.show1}, ${seg}, 'ADMIN', 'Bulk Family', 'bulk@example.test', 'WAITLIST', now(), now()) returning id`;
  await sql`select claim_seats(${seg}::bigint, ${r.id}::bigint, ${JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ full_name: `Bulk ${i}`, allocation_type: 'COMP' })))}::text::jsonb, false)`;
  const page = await admin.newPage();
  await page.goto(`${AUD}?grain=seats&ticket=none&size=10`);
  const total = await rowCount(page);
  test.info().annotations.push({ type: 'unissued-seats', description: String(total) });
  expect(total).toBeGreaterThan(10);
  await page.getByRole('checkbox', { name: 'Select all rows on this page' }).check();
  await page.getByRole('button', { name: new RegExp(`Select all ${total}`) }).click();
  await expect(page.getByRole('status').filter({ hasText: 'matching' })).toContainText(`All ${total}`);
  const firstRow = page.locator('tbody tr').first();
  const excludedName = (await firstRow.locator('td').nth(1).innerText()).split('\n')[0];
  await firstRow.getByRole('checkbox').uncheck();
  await shot(page, 'FLOW-18-step-1-all-but-one');
  await openAction(page, 'Issue tickets');
  await shot(page, 'FLOW-18-step-2-preview');
  await runDialog(page, /^Issue tickets/);
  await shot(page, 'FLOW-18-step-3-report');
  const [{ left }] = await sql`select count(*)::int as left from attendees a join registrations r on r.id = a.registration_id
      where a.status = 'CONFIRMED' and a.deleted_at is null and r.deleted_at is null and a.qr_token is null
        and r.show_id in (select id from shows where concert_id = ${C})`;
  test.info().annotations.push({ type: 'excluded', description: `${excludedName}; unissued after run: ${left}` });
  expect(left).toBe(1);
  await page.close();
});

test('FLOW-17 Confirm seats with the override shows the overage and flags Over capacity', async () => {
  const seg = Number(ids.publicSegment);
  const [{ p }] = await sql`select segment_pool(${seg}::bigint) as p`;
  await sql`update show_segments set capacity = ${p.confirmed} where id = ${seg}`;
  const [r] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, approved_at)
    values (${ids.show1}, ${seg}, 'ADMIN', 'Late Family', 'late@example.test', 'WAITLIST', now(), now()) returning id`;
  await sql`select claim_seats(${seg}::bigint, ${r.id}::bigint, '[{"full_name":"Late One","allocation_type":"EXTRA"},{"full_name":"Late Two","allocation_type":"EXTRA"}]'::jsonb, false)`;
  const page = await admin.newPage();
  await page.goto(`${AUD}?view=waitlisted`);
  await tableRow(page, 'Late Family').getByRole('checkbox').check();
  await openAction(page, 'Confirm seats');
  const dialog = page.getByRole('dialog');
  await shot(page, 'FLOW-17-step-1-preview-no-override');
  await dialog.getByRole('switch', { name: 'Go past capacity' }).or(dialog.getByRole('checkbox', { name: 'Go past capacity' })).first().click();
  await expect(dialog).toContainText(`${p.confirmed + 2} of ${p.confirmed}`);
  await shot(page, 'FLOW-17-step-2-preview-override');
  await runDialog(page, /^Confirm seats/);
  await shot(page, 'FLOW-17-step-3-report');
  const seats = await sql`select status, over_capacity_at is not null as over from attendees where registration_id = ${r.id} order by id`;
  expect(seats.map((s) => [s.status, s.over])).toEqual([['CONFIRMED', true], ['CONFIRMED', true]]);
  await page.goto(`${AUD}?view=over-capacity`);
  await expect(tableRow(page, 'Late Family')).toBeVisible();
  await shot(page, 'FLOW-17-step-4-over-capacity-view');
  await page.close();
});

test('FLOW-19 Waitlist a party with a queued ticket email withdraws the email (sad)', async () => {
  const daniel = Number(ids.daniel);
  await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status) values
    (${daniel}, 'TICKETS', 'public_ticket', 'daniel@example.test', 'Your tickets', 'b', 'QUEUED')`;
  const page = await admin.newPage();
  await page.goto(`${AUD}/${daniel}`);
  await page.getByRole('tab', { name: /Conversation/ }).click();
  await shot(page, 'FLOW-19-step-1-queued-before');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Waitlist', exact: true }).click();
  await shot(page, 'FLOW-19-step-2-waitlist-preview');
  await runDialog(page, /^Waitlist \d/);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.reload();
  await page.getByRole('tab', { name: /Conversation/ }).click();
  await shot(page, 'FLOW-19-step-3-after-waitlist');
  const seats = await sql`select status from attendees where registration_id = ${daniel} and deleted_at is null`;
  expect(seats.every((s) => s.status === 'WAITLIST')).toBe(true);
  const [mail] = await sql`select status from email_outbox where registration_id = ${daniel} and purpose = 'TICKETS'`;
  test.info().annotations.push({ type: 'mail-after-waitlist', description: mail.status });
  expect(mail.status).not.toBe('QUEUED');
  await page.close();
});

test('FLOW-20 Clearing the contact email leaves pending mail addressed to the old address (sad)', async () => {
  const farah = Number(ids.unverified);
  const page = await admin.newPage();
  await page.goto(`${AUD}/${farah}`);
  const [before] = await sql`select contact_email::text as e from registrations where id = ${farah}`;
  await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status) values
    (${farah}, 'REMINDER', 'reminder', ${before.e}, 'Reminder', 'b', 'DRAFT')`;
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Contact email').fill('');
  await shot(page, 'FLOW-20-step-1-cleared');
  await page.getByRole('dialog').getByRole('button', { name: 'Save registration' }).click();
  await expect.poll(async () => (await sql`select contact_email from registrations where id = ${farah}`)[0].contact_email, { timeout: 15_000 }).toBeNull();
  await shot(page, 'FLOW-20-step-2-saved');
  const pending = await sql`select status, to_email::text as to_email from email_outbox where registration_id = ${farah} and status in ('DRAFT','QUEUED')`;
  test.info().annotations.push({ type: 'pending-after-clear', description: JSON.stringify(pending) });
  expect(pending.filter((m) => m.to_email === before.e)).toEqual([]);
  await page.close();
});
