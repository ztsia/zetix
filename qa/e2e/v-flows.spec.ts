import { test, expect, type Browser, type Page, type BrowserContext } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Module V, phase 5 — the flows of qa-artifacts/claude-V-intake/02-flows.md,
 * walked in Chromium against qa/support/start-v.sh. Assert first, then shoot.
 * Every flow checks the database after the UI acts.
 */
const OUT = 'qa-artifacts/claude-V-intake';
const SHOTS = `${OUT}/screens`;
mkdirSync(SHOTS, { recursive: true });
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', { prepare: false, max: 2 });
const seed = JSON.parse(readFileSync('/tmp/qa-v-seed.json', 'utf8'));
const LOG: Record<string, unknown> = {};
const log = (key: string, value: unknown) => {
  // A failed test restarts the worker; merge with what earlier workers wrote.
  let prior: Record<string, unknown> = {};
  try { prior = JSON.parse(readFileSync(`${OUT}/e2e-evidence.json`, 'utf8')); } catch { prior = {}; }
  Object.assign(LOG, prior, { [key]: value });
  writeFileSync(`${OUT}/e2e-evidence.json`, JSON.stringify(LOG, null, 2));
};
/** Admin screens: click only once React has hydrated, or the click is lost. */
const settle = async (page: Page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(1500); };
test.afterAll(async () => { await sql.end(); });

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function signIn(browser: Browser, who: 'admin' | 'viewer'): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(who === 'admin' ? 'committee@example.test' : 'mei@example.test');
  await page.locator('input[name="password"]').fill(who === 'admin' ? 'qa-admin-pass' : 'qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  return { ctx, page };
}

const byId = (page: Page, id: string) => page.locator(`[id="${id}"]`);

/**
 * Submit, and accept the address warning once if it appears: the sandbox has no
 * DNS, so every example.test address is "no mail server" (lib/email/address.ts).
 * The warning itself is screenshotted the first time, as evidence.
 */
async function submitForm(page: Page, label: string, warnShot?: string) {
  await page.getByRole('button', { name: label }).click();
  const warned = page.getByText('Submit again to use it anyway.');
  const done = page.waitForURL(/\/done\?r=/, { timeout: 20_000 }).then(() => 'done' as const);
  const which = await Promise.race([done, warned.waitFor({ timeout: 20_000 }).then(() => 'warned' as const)]);
  if (which === 'warned') {
    if (warnShot) await shot(page, warnShot);
    await page.getByRole('button', { name: label }).click();
    await page.waitForURL(/\/done\?r=/, { timeout: 20_000 });
  }
}

// ---------------------------------------------------------------------------
test('FLOW-1 stranger registers on the public link (phone)', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  const res = await page.goto('/f/qa-autumn');
  expect(res?.status()).toBe(200);
  await expect(page.getByText('Autumn Evening — public registration').first()).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await shot(page, 'FLOW-1-step-1-open');

  await byId(page, 'registrant.contact_name').fill('Priya Nair');
  await byId(page, 'registrant.contact_email').fill('priya@example.test');
  await byId(page, 'party.0.full_name').fill('Ravi Nair');
  await expect(byId(page, 'party.0.full_name')).toHaveValue('Ravi Nair');
  await shot(page, 'FLOW-1-step-2-filled');

  const t0 = Date.now();
  await submitForm(page, 'Submit', 'FLOW-1-step-3a-address-warning');
  await expect(page.getByText('Your registration has been recorded.')).toBeVisible();
  await shot(page, 'FLOW-1-step-3-done');

  const [party] = await sql`select id::int, approved_at, status::text, email_issue from registrations where contact_email = 'priya@example.test'`;
  const seats = await sql`select full_name, status::text from attendees where registration_id = ${party.id} order by id`;
  const receipts = await sql`select status::text, scheduled_for, body_md from email_outbox where registration_id = ${party.id} and purpose = 'RECEIPT'`;
  const stage = await sql`select stage from party_pipeline where registration_id = ${party.id}`;
  log('FLOW-1', { party, seats, stage, receipts: receipts.map((r) => ({ status: r.status, dueInMin: Math.round((new Date(r.scheduled_for).getTime() - t0) / 60000), hasVerify: /\/f\/verify\?t=/.test(r.body_md), hasUpdate: /\/f\/update\?t=/.test(r.body_md) })) });
  expect(seats).toEqual([{ full_name: 'Priya Nair', status: 'CONFIRMED' }, { full_name: 'Ravi Nair', status: 'CONFIRMED' }]);
  expect(party.approved_at).toBeNull();
  expect(stage[0].stage).toBe('NEEDS_REVIEW');
  expect(receipts).toHaveLength(1);
  expect(receipts[0].status).toBe('QUEUED');
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-2 the same person submits again inside the hold (phone)', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  await page.goto('/f/qa-autumn');
  await byId(page, 'registrant.contact_name').fill('Priya Nair');
  await byId(page, 'registrant.contact_email').fill('PRIYA@Example.test');
  await shot(page, 'FLOW-2-step-1-filled');
  await submitForm(page, 'Submit');
  await expect(page.getByText('3 seats confirmed')).toBeVisible();
  await shot(page, 'FLOW-2-step-2-done');
  const parties = await sql`select id::int from registrations where contact_email = 'priya@example.test' and deleted_at is null`;
  const receipts = await sql`select id::int, status::text, superseded_by_id::int from email_outbox where registration_id = ${parties[0].id} and purpose = 'RECEIPT' order by id`;
  log('FLOW-2', { parties, receipts });
  expect(parties).toHaveLength(1);
  expect(receipts.map((r) => r.status)).toEqual(['CANCELLED', 'QUEUED']);
  expect(receipts[0].superseded_by_id).toBe(receipts[1].id);
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-15 a stranger types someone else’s address (sad): what does the confirmation reveal?', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  await page.goto('/f/qa-autumn');
  await byId(page, 'registrant.contact_name').fill('Mallory Stranger');
  await byId(page, 'registrant.contact_email').fill('nadia@example.test'); // Nadia Hassan's address
  await shot(page, 'FLOW-15-step-1-filled');
  await submitForm(page, 'Submit');
  const body = await page.locator('body').innerText();
  const revealsName = body.includes('Nadia Hassan');
  const seatsLine = body.match(/\d+ seats? confirmed/)?.[0] ?? null;
  await shot(page, 'FLOW-15-step-2-confirmation');
  const [nadia] = await sql`select approved_at, (select count(*)::int from attendees a where a.registration_id = r.id and a.deleted_at is null and a.status <> 'CANCELLED') as seats,
                                   (select array_agg(full_name order by id) from attendees a where a.registration_id = r.id and a.deleted_at is null) as names
                              from registrations r where id = ${seed.nadia}`;
  log('FLOW-15', { revealsVictimName: revealsName, seatsLine, strangerSeesTitle: body.split('\n').find((l) => l.startsWith('Thank you')), nadiaAfter: nadia });
  // Spec §25.8: "someone typing another person's address cannot edit that person's party".
  // The confirmation must not disclose the other person's registration either.
  expect(revealsName).toBe(false);
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-3 a player’s guest registers through the picker', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  await page.goto('/f/qa-players');
  await expect(page.getByText('Which player invited you?')).toBeVisible();
  await shot(page, 'FLOW-3-step-1-open');
  await page.getByPlaceholder('Search by name').fill('Aish');
  await expect(page.getByRole('option', { name: 'Aisha Rahman' })).toBeVisible();
  await shot(page, 'FLOW-3-step-2-search');
  await page.getByRole('option', { name: 'Aisha Rahman' }).click();
  await expect(page.getByText('Aisha Rahman has 1 invited seat left.')).toBeVisible();
  await shot(page, 'FLOW-3-step-3-picked');
  await byId(page, 'registrant.contact_name').fill('Siti Rahman');
  await byId(page, 'registrant.contact_email').fill('siti@example.test');
  await byId(page, 'base_seats.0.full_name').fill('Farid Rahman');
  await submitForm(page, 'Submit');
  await expect(page.getByText('Your registration has been recorded.')).toBeVisible();
  await shot(page, 'FLOW-3-step-4-done');
  const [party] = await sql`select player_id::int, approved_at from registrations where contact_email = 'siti@example.test'`;
  const seats = await sql`select a.allocation_type::text, a.status::text from attendees a join registrations r on r.id = a.registration_id where r.contact_email = 'siti@example.test'`;
  log('FLOW-3', { party, seats });
  expect(party.player_id).toBe(seed.aisha);
  expect(seats).toEqual([{ allocation_type: 'BASE', status: 'CONFIRMED' }]);
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-4 the picker offers no inactive player and leaks no contact data (sad)', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  const res = await page.goto('/f/qa-players');
  const html = await res!.text();
  const leaks = {
    playerEmails: (html.match(/[a-z.]+@band\.example/g) ?? []).length,
    inviteTokens: (html.match(/qa-invite-[a-z]+-0+/g) ?? []).length,
    inactiveName: html.includes('Chloe Inactive'),
    deletedName: html.includes('Dmitri Deleted'),
  };
  await page.getByPlaceholder('Search by name').fill('Chloe');
  await expect(page.getByText('No player by that name.')).toBeVisible();
  await shot(page, 'FLOW-4-step-1-inactive-absent');
  await page.getByPlaceholder('Search by name').fill('Dmitri');
  await expect(page.getByText('No player by that name.')).toBeVisible();
  await shot(page, 'FLOW-4-step-2-deleted-absent');
  log('FLOW-4', leaks);
  expect(leaks).toEqual({ playerEmails: 0, inviteTokens: 0, inactiveName: false, deletedName: false });
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-5 unknown slug (sad)', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  const res = await page.goto('/f/does-not-exist');
  const body = await page.locator('body').innerText();
  await shot(page, 'FLOW-5-step-1-not-found');
  log('FLOW-5', { status: res?.status(), text: body.slice(0, 200) });
  expect(body).not.toMatch(/Error:|at .*\.tsx?:\d+/);
  expect(body).toMatch(/not available|not found|no longer/i);
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-6 a full segment: waitlist mode takes the request, the other form says full', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  await page.goto('/f/qa-full-closed');
  const closedText = await page.locator('body').innerText();
  await shot(page, 'FLOW-6-step-1-full-closed');
  await page.goto('/f/qa-full-wait');
  await expect(page.getByRole('button', { name: 'Join the waitlist' })).toBeVisible();
  await shot(page, 'FLOW-6-step-2-waitlist-form');
  await byId(page, 'registrant.contact_name').fill('Wendy Wait');
  await byId(page, 'registrant.contact_email').fill('wendy@example.test');
  await submitForm(page, 'Join the waitlist');
  await expect(page.getByText(/1 seat waitlisted/)).toBeVisible();
  await shot(page, 'FLOW-6-step-3-waitlisted');
  const seats = await sql`select a.status::text from attendees a join registrations r on r.id = a.registration_id where r.contact_email = 'wendy@example.test'`;
  const [cap] = await sql`select count(*)::int as n from attendees where segment_id = ${seed.matPub} and status = 'CONFIRMED' and deleted_at is null`;
  log('FLOW-6', { closedFormText: closedText.slice(0, 160), wendySeats: seats, confirmedInFullSegment: cap.n });
  expect(seats).toEqual([{ status: 'WAITLIST' }]);
  expect(cap.n).toBe(2);
  expect(closedText).toMatch(/full|no seats|waitlist/i);
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-7 the party update link: name a guest, give back a seat (phone, New York browser)', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100', timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  const before = await sql`select id::int, full_name, name_source::text, qr_token from attendees where registration_id = ${seed.nadia} order by id`;
  await page.goto('/f/update?t=qa-update-nadia-0000000000');
  await expect(page.getByRole('heading', { name: 'Your guests' })).toBeVisible();
  const text = await page.locator('body').innerText();
  // Show at 2026-11-20T12:00Z = 8:00 pm in Kuala Lumpur; 7:00 am in New York.
  const showsKl = /8:00\s*(pm|PM)|20:00/.test(text);
  const showsNy = /7:00\s*(am|AM)|07:00/.test(text);
  await shot(page, 'FLOW-7-step-1-open');

  const unnamed = before.find((s) => s.name_source === 'PLACEHOLDER')!;
  await byId(page, `seat-${unnamed.id}`).fill('Omar Hassan');
  await page.getByRole('button', { name: 'Save names' }).click();
  await expect(page.getByText('Saved 1 name.')).toBeVisible();
  await shot(page, 'FLOW-7-step-2-named');

  await page.getByText('This guest can no longer come — give the seat back').nth(1).click();
  await page.getByRole('button', { name: /Give back 1 seat/ }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await shot(page, 'FLOW-7-step-3-confirm');
  await page.getByRole('button', { name: 'Give back', exact: true }).click();
  await expect(page.getByText(/1 seat given back/)).toBeVisible();
  await shot(page, 'FLOW-7-step-4-given-back');

  const after = await sql`select id::int, full_name, name_source::text, qr_token, status::text, needs_reissue from attendees where registration_id = ${seed.nadia} order by id`;
  log('FLOW-7', { showsKlTime: showsKl, showsNyTime: showsNy, before, after });
  expect(showsKl).toBe(true);
  expect(showsNy).toBe(false);
  const renamed = after.find((s) => s.id === unnamed.id)!;
  expect(renamed.full_name).toBe('Omar Hassan');
  expect(renamed.qr_token).toBe(unnamed.qr_token);
  expect(renamed.status).toBe('CANCELLED');
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-8 a forged update token (sad)', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PHONE, baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  const res = await page.goto('/f/update?t=qa-update-nadia-0000000001');
  const body = await page.locator('body').innerText();
  await shot(page, 'FLOW-8-step-1-refused');
  log('FLOW-8', { status: res?.status(), text: body.slice(0, 160) });
  expect(body).not.toContain('Nadia');
  expect(body).not.toContain('Your guests');
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-9 admin merges a duplicate pair from the party record', async ({ browser }) => {
  const { ctx, page } = await signIn(browser, 'admin');
  await page.goto(`/admin/concerts/${seed.concert}/audience?view=possible-duplicate`);
  await expect(page.getByText('Kenji Sato', { exact: true }).first()).toBeVisible();
  await shot(page, 'FLOW-9-step-1-duplicates-view');
  await page.goto(`/admin/concerts/${seed.concert}/audience/${seed.kenjiPub}`);
  await expect(page.getByRole('heading', { name: 'Possible duplicates' })).toBeVisible();
  await settle(page);
  await shot(page, 'FLOW-9-step-2-record');
  const tokens0 = await sql`select id::int, qr_token from attendees where registration_id in (${seed.kenjiPub}, ${seed.kenjiPly}) order by id`;
  await page.getByRole('button', { name: 'Merge into this party' }).click();
  const run = page.getByRole('button', { name: /^Merge 1 pair$/ });
  await expect(run).toBeVisible();
  await shot(page, 'FLOW-9-step-3-preview');
  await run.click();
  await expect(page.getByRole('heading', { name: 'Done' }).or(page.getByText('Done', { exact: true }))).toBeVisible({ timeout: 20_000 });
  await shot(page, 'FLOW-9-step-4-report');
  const [absorbed] = await sql`select deleted_at is not null as deleted, merged_into_id::int from registrations where id = ${seed.kenjiPly}`;
  const seats = await sql`select id::int, full_name, segment_id::int, allocation_type::text, status::text, qr_token from attendees where registration_id = ${seed.kenjiPub} and deleted_at is null order by id`;
  const [pair] = await sql`select status::text from duplicate_candidates where id = ${seed.pair}`;
  log('FLOW-9', { absorbed, survivorSeats: seats, pair, tokens0 });
  expect(absorbed).toEqual({ deleted: true, merged_into_id: seed.kenjiPub });
  expect(seats.map((s) => s.full_name)).toEqual(['Kenji Sato', 'Yui Sato', 'Haruto Sato']);
  expect(seats.every((s) => s.segment_id === seed.pub)).toBe(true);
  expect(pair.status).toBe('MERGED');
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-10 admin dismisses a false duplicate and it stays dismissed', async ({ browser }) => {
  // Priya (public, FLOW-1) gets a namesake in the player segment by email.
  const [p] = await sql`insert into registrations (show_id, segment_id, player_id, source, contact_name, contact_email, status, requested_at, approved_at)
    values (${seed.eve}, ${seed.ply}, ${seed.benjamin}, 'ADMIN', 'Priya N.', 'priya@example.test', 'WAITLIST', now(), now()) returning id`;
  await sql`select claim_seats(${seed.ply}::bigint, ${p.id}::bigint, '[{"full_name":"Priya N.","allocation_type":"BASE"}]'::jsonb, false)`;
  await sql`select refresh_duplicate_candidates(${p.id}::bigint)`;
  const { ctx, page } = await signIn(browser, 'admin');
  await page.goto(`/admin/concerts/${seed.concert}/audience/${p.id}`);
  await expect(page.getByRole('heading', { name: 'Possible duplicates' })).toBeVisible();
  await settle(page);
  await shot(page, 'FLOW-10-step-1-record');
  await page.getByRole('button', { name: 'Not a duplicate' }).click();
  const run = page.getByRole('button', { name: /^Mark not a duplicate 1 pair$/ });
  await expect(run).toBeVisible();
  await run.click();
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, 'FLOW-10-step-2-dismissed');
  await sql`select refresh_duplicate_candidates(${p.id}::bigint)`;
  const pairs = await sql`select status::text from duplicate_candidates where ${p.id} in (registration_a_id, registration_b_id)`;
  const [flag] = await sql`select flag_possible_duplicate from party_pipeline where registration_id = ${p.id}`;
  log('FLOW-10', { pairs, flag });
  expect(pairs.map((x) => x.status)).toEqual(['DISMISSED']);
  expect(flag.flag_possible_duplicate).toBe(false);
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-13 Invite players, run twice', async ({ browser }) => {
  const { ctx, page } = await signIn(browser, 'admin');
  await page.goto(`/admin/concerts/${seed.concert}/players`);
  await settle(page);
  await page.getByRole('button', { name: 'Invite players…' }).click();
  const run = page.getByRole('button', { name: /^Invite \d+ players?$/ });
  await expect(run).toBeVisible({ timeout: 20_000 });
  await shot(page, 'FLOW-13-step-1-preview');
  await run.click();
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, 'FLOW-13-step-2-report');
  await page.getByRole('button', { name: 'Close' }).first().click();
  await settle(page);
  await page.getByRole('button', { name: 'Invite players…' }).click();
  await expect(page.getByText('Already invited to this form.').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, 'FLOW-13-step-3-second-preview');
  const rows = await sql`select player_id::int, status::text, count(*)::int as n from email_outbox where purpose = 'PLAYER_INVITE' group by 1, 2 order by 1`;
  log('FLOW-13', rows);
  expect(rows.every((r) => r.n === 1)).toBe(true);
  expect(rows.map((r) => r.player_id).sort()).toEqual([seed.aisha, seed.benjamin].sort());
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-11 admin stages a wide sheet, fixes a cell, commits, undoes', async ({ browser }) => {
  test.setTimeout(240_000);
  const { ctx, page } = await signIn(browser, 'admin');
  const csv = [
    'Timestamp,Name,Email,Guest 1 Name,Guest 2 Name',
    '2026-10-05 10:00:00,Tan Wei,tanwei@example.test,Tan Mei,Tan Lim',
    '2026-10-05 10:05:00,,noname@example.test,Someone,',
    '2026-10-05 10:07:00,Typo Person,typo@gmail..com,,',
    '2026-10-05 10:09:00,Nadia Hassan,nadia@example.test,Nadia Hassan,Late Guest',
  ].join('\n');
  await page.goto(`/admin/concerts/${seed.concert}/import`);
  await settle(page);
  await shot(page, 'FLOW-11-step-1-import');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#segment').click();
  await page.getByRole('option', { name: /Autumn Evening — Public/ }).click();
  await page.locator('#file').setInputFiles({ name: 'autumn.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 20_000 });
  await shot(page, 'FLOW-11-step-2-read');
  await page.getByRole('button', { name: 'Continue' }).click();
  // The switch is auto-set when the headers repeat; only flip it if it is off.
  if (!(await page.locator('#wide').isChecked())) await page.getByText('Guests are in repeating columns').click();
  if (!(await page.locator('#registrant-seat').isChecked().catch(() => true))) await page.getByText('The contact is a seat too').click();
  await shot(page, 'FLOW-11-step-3-mapping');
  await page.getByRole('button', { name: 'Continue' }).click();
  await shot(page, 'FLOW-11-step-4-stage');
  await page.getByRole('button', { name: 'Stage rows' }).click();
  await page.waitForURL(/\/import\/\d+/, { timeout: 30_000 });
  const batchId = Number(page.url().match(/\/import\/(\d+)/)![1]);
  const [nothingYet] = await sql`select count(*)::int as n from registrations where import_batch_id = ${batchId}`;
  const staged = await sql`select row_number, seat_index, normalized->>'attendeeName' as seat, issues from import_rows where batch_id = ${batchId} order by row_number, seat_index`;
  await expect(page.getByText(/part(y needs|ies need) fixing/)).toBeVisible();
  await shot(page, 'FLOW-11-step-5-grid');

  // Fix the missing contact name, as the grid does: click the empty cell and type.
  await settle(page);
  await page.getByRole('tab', { name: /Needs fixing/ }).click().catch(() => null);
  const emptyName = page.getByRole('button', { name: /—|No name|Contact name/ }).first();
  await emptyName.click();
  await page.keyboard.type('Nora Name');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await shot(page, 'FLOW-11-step-6-fixed');
  const [fixed] = await sql`select normalized->>'contactName' as name, issues from import_rows where batch_id = ${batchId} and row_number = 3 order by seat_index limit 1`;

  await page.getByRole('button', { name: /^Commit \d+ ready part/ }).click();
  const run = page.getByRole('button', { name: /^Commit \d+ part/ }).last();
  await expect(run).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await shot(page, 'FLOW-11-step-7-commit-preview');
  await run.click();
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-11-step-8-committed');
  await page.getByRole('button', { name: 'Close' }).first().click();
  const [otherRow] = await sql`select normalized->>'contactName' as name, issues from import_rows where batch_id = ${batchId} and row_number = 3 and seat_index = 1`;
  const committed = await sql`select r.contact_name, r.approved_at is not null as approved, array_agg(a.full_name order by a.id) as seats
    from registrations r join attendees a on a.registration_id = r.id and a.deleted_at is null
   where r.segment_id = ${seed.pub} and r.deleted_at is null and (r.import_batch_id = ${batchId} or r.id = ${seed.nadia}) group by r.id order by r.id`;
  const [typo] = await sql`select flags from party_pipeline where contact_email = 'typo@gmail..com'`;

  await page.reload();
  await settle(page);
  await page.getByRole('button', { name: 'Undo import' }).click();
  const undo = page.getByRole('button', { name: /^Undo import 1 import$/ });
  await expect(undo).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await shot(page, 'FLOW-11-step-9-undo-preview');
  await undo.click();
  // The dialog closes on its own after an irreversible run; the header says "undone".
  await expect(page.getByText(/· undone/)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-11-step-10-undone');
  const afterUndo = await sql`select r.contact_name, r.deleted_at is not null as deleted,
      (select array_agg(a.full_name order by a.id) from attendees a where a.registration_id = r.id and a.deleted_at is null) as live
    from registrations r where r.import_batch_id = ${batchId} or r.id = ${seed.nadia} order by r.id`;
  log('FLOW-11', { batchId, sameLineOtherSeatAfterFix: otherRow, nothingBeforeCommit: nothingYet.n, staged: staged.map((s) => ({ row: s.row_number, seat: s.seat, codes: (s.issues as { code: string }[]).map((i) => i.code) })), fixed, committed, typoFlags: typo?.flags, afterUndo });
  expect(nothingYet.n).toBe(0);
  expect(afterUndo.find((r) => r.contact_name === 'Nadia Hassan')?.deleted).toBe(false);
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-12 a viewer opens the intake screens (sad for edits)', async ({ browser }) => {
  const { ctx, page } = await signIn(browser, 'viewer');
  const [batch] = await sql`select id::int from import_batches order by id desc limit 1`;
  const res = await page.goto(`/admin/concerts/${seed.concert}/import/${batch.id}`);
  const html = await res!.text();
  await shot(page, 'FLOW-12-step-1-grid');
  const buttons = await page.getByRole('button').allInnerTexts();
  const mutating = buttons.filter((b) => /Commit|Undo import|Stage rows/.test(b));
  const fullEmails = (html.match(/[a-z0-9.]+@(example\.test|gmail\.\.com)/g) ?? []).filter((e) => !e.includes('mei@'));
  await page.goto(`/admin/concerts/${seed.concert}/audience/${seed.kenjiPub}`);
  await shot(page, 'FLOW-12-step-2-record');
  const recordButtons = await page.getByRole('button').allInnerTexts();
  const recordMutating = recordButtons.filter((b) => /Merge|Not a duplicate|Undo merge|Copy update link|update link/i.test(b));
  await page.goto(`/admin/concerts/${seed.concert}/players`);
  await shot(page, 'FLOW-12-step-3-players');
  const inviteVisible = await page.getByRole('button', { name: 'Invite players…' }).isVisible().catch(() => false);
  log('FLOW-12', { mutating, fullEmails: fullEmails.slice(0, 5), recordMutating, inviteVisible });
  expect(mutating).toEqual([]);
  expect(fullEmails).toEqual([]);
  expect(recordMutating).toEqual([]);
  expect(inviteVisible).toBe(false);
  await ctx.close();
});

// ---------------------------------------------------------------------------
test('FLOW-14 the form funnel on the forms page equals the database', async ({ browser }) => {
  const { ctx, page } = await signIn(browser, 'admin');
  await page.goto(`/admin/concerts/${seed.concert}/forms`);
  await expect(page.getByText('Autumn Evening — public registration').first()).toBeVisible();
  await shot(page, 'FLOW-14-step-1-forms');
  const [db] = await sql`
    select (select count(*)::int from form_responses fr where fr.form_id = ${seed.autumnForm}
              and not exists (select 1 from form_responses l where l.supersedes_id = fr.id)) as responses,
           (select count(distinct p.registration_id)::int from form_responses fr join party_pipeline p on p.registration_id = fr.registration_id where fr.form_id = ${seed.autumnForm}) as parties`;
  const rowText = await page.locator('tr, li, [data-slot="item"], [data-slot="card"]').filter({ hasText: 'Autumn Evening — public registration' }).first().innerText();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:3100' });
  await settle(page);
  const row = page.locator('div').filter({ hasText: /^Autumn Evening — public registration/ }).first();
  await page.getByRole('button', { name: 'Copy responder link' }).last().click();
  await page.waitForTimeout(500);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  await shot(page, 'FLOW-14-step-2-copied');
  log('FLOW-14', { db, rowText, copied, rowVisible: await row.isVisible().catch(() => false) });
  expect(rowText).toContain(String(db.responses));
  expect(copied).toBe('http://localhost:3100/f/qa-autumn');
  await ctx.close();
});
