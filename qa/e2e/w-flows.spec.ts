import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { OUT, SHOTS, newPage, shot, sql } from './w-helpers';

/**
 * Module W — Home, the seven areas, Setup › Concert and After › Feedback,
 * walked in Chromium against zetix_qa (qa/support/start-v.sh). Every step
 * asserts before it screenshots; database state is read after the UI acts.
 */
mkdirSync(SHOTS, { recursive: true });
// The shared connection (w-helpers) is closed when the worker exits.

import { existsSync, readFileSync } from 'node:fs';
const EVIDENCE = `${OUT}/flows-evidence.json`;
const evidence: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
  set(_t, key, value) {
    const cur = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) : {};
    cur[String(key)] = value;
    writeFileSync(EVIDENCE, JSON.stringify(cur, null, 2));
    return true;
  },
});

test('FLOW-1 admin opens a concert and lands on Home', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'admin');
  await page.goto('/admin/concerts/1', { waitUntil: 'networkidle' });
  // step 1: redirect
  await expect(page).toHaveURL(/\/admin\/concerts\/1\/home$/);
  await shot(page, 'FLOW-1-step-1-home');

  // step 2: sidebar areas
  const sidebar = page.locator('[data-sidebar="sidebar"]').first();
  const areaLinks = await sidebar.locator('[data-sidebar="menu-button"]').allInnerTexts();
  evidence['FLOW-1 sidebar'] = areaLinks;
  const areas = areaLinks.map((t) => t.trim()).filter((t) => ['Home', 'Audience', 'Inbox', 'Intake', 'Door', 'After', 'Setup'].includes(t));
  expect(areas).toEqual(['Home', 'Audience', 'Inbox', 'Intake', 'Door', 'After', 'Setup']);
  for (const g of ['Activity', 'Trash', 'All concerts', 'Settings']) await expect(sidebar.getByText(g, { exact: true })).toBeVisible();
  expect(await sidebar.getByText(/^Exports$/).count()).toBe(0);
  await sidebar.screenshot({ path: `${SHOTS}/FLOW-1-step-2-sidebar.png` });

  // step 3: section order
  const order = await page.locator('main h2, [data-slot="sidebar-inset"] h2').allInnerTexts();
  evidence['FLOW-1 section order'] = order;
  const idx = (s: string) => order.findIndex((t) => t.includes(s));
  expect(idx('Needs attention')).toBeGreaterThanOrEqual(0);
  expect(idx('Needs attention')).toBeLessThan(idx('Where every party is'));
  expect(idx('Where every party is')).toBeLessThan(idx('Dates'));
  expect(idx('Dates')).toBeLessThan(idx('Setup checklist'));

  // step 4: stage tiles and flag counts equal party_pipeline
  const stages = await sql<{ stage: string; n: number }[]>`select stage, count(*)::int n from party_pipeline where concert_id = 1 group by stage`;
  const flags = await sql<{ f: string; n: number }[]>`select f, count(*)::int n from party_pipeline, unnest(flags) f where concert_id = 1 group by f`;
  const funnel = page.locator('section[aria-labelledby="funnel"] ol li');
  const tiles: Record<string, string> = {};
  for (const li of await funnel.all()) {
    const [label, n] = (await li.innerText()).split('\n').map((s) => s.trim());
    tiles[label!] = n!;
  }
  const attention: Record<string, string> = {};
  for (const a of await page.locator('section[aria-labelledby="attention"] a').all()) {
    const lines = (await a.innerText()).split('\n').map((s) => s.trim()).filter(Boolean);
    attention[lines[0]!] = lines[1]!;
  }
  evidence['FLOW-1 tiles'] = { tiles, attention, db: { stages, flags } };
  const label: Record<string, string> = { NEEDS_REVIEW: 'Needs review', UNVERIFIED: 'Unverified', NEEDS_TICKETS: 'Needs tickets', READY_TO_SEND: 'Ready to send', SENT: 'Sent', ADMITTED: 'Admitted', WAITLISTED: 'Waitlisted', CANCELLED: 'Cancelled' };
  for (const [stage, l] of Object.entries(label)) {
    expect(tiles[l], l).toBe(String(stages.find((s) => s.stage === stage)?.n ?? 0));
  }
  const flagLabel: Record<string, string> = { SEND_FAILED: 'Send failed', SUSPICIOUS_ADDRESS: 'Suspicious address', CHANGED_AFTER_SEND: 'Changed after send', UNNAMED_GUESTS: 'Unnamed guests', POSSIBLE_DUPLICATE: 'Possible duplicate', BOUNCED: 'Bounced', OVER_CAPACITY: 'Over capacity' };
  for (const [f, l] of Object.entries(flagLabel)) {
    const n = flags.find((x) => x.f === f)?.n ?? 0;
    if (n === 0) expect(attention[l], `${l} is zero and must not be listed`).toBeUndefined();
    else expect(attention[l], l).toBe(String(n));
  }
  await page.locator('section[aria-labelledby="attention"]').screenshot({ path: `${SHOTS}/FLOW-1-step-4-attention.png` });
  await ctx.close();
});

test('FLOW-2 retired routes redirect', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'admin');
  await page.goto('/admin/concerts/1/overview', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/admin\/concerts\/1\/home$/);
  await shot(page, 'FLOW-2-step-1-overview-to-home', false);
  await page.goto('/admin/concerts/1/exports', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/admin\/concerts\/1\/audience$/);
  await shot(page, 'FLOW-2-step-2-exports-to-audience', false);
  await page.goto('/admin/concerts/99999/overview', { waitUntil: 'networkidle' });
  await expect(page.getByText(/could not be found|not found|404/i).first()).toBeVisible();
  await shot(page, 'FLOW-2-step-3-unknown-concert-404', false);
  await ctx.close();
});

test('FLOW-3 Setup area tabs', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'admin');
  await page.goto('/admin/concerts/1/shows', { waitUntil: 'networkidle' });
  const tabs = page.getByRole('navigation', { name: 'Setup' });
  await expect(tabs.getByRole('link')).toHaveText(['Concert', 'Shows', 'Players', 'Ticket designs', 'Email templates']);
  await expect(tabs.getByRole('link', { name: 'Shows' })).toHaveAttribute('aria-current', 'page');
  await shot(page, 'FLOW-3-step-1-setup-tabs', false);
  const expected: Array<[string, RegExp]> = [
    ['Concert', /\/setup$/], ['Players', /\/players$/], ['Ticket designs', /\/tickets\/templates$/], ['Email templates', /\/email\/templates$/],
  ];
  let n = 2;
  for (const [name, url] of expected) {
    await tabs.getByRole('link', { name }).click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('navigation', { name: 'Setup' }).getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await shot(page, `FLOW-3-step-${n++}-${name.toLowerCase().replace(/\s+/g, '-')}`, false);
  }
  // After area
  await page.goto('/admin/concerts/1/notes', { waitUntil: 'networkidle' });
  await expect(page.getByRole('navigation', { name: 'After' }).getByRole('link')).toHaveText(['Feedback', 'Notes', 'Portal']);
  await page.goto('/admin/concerts/1/operators', { waitUntil: 'networkidle' });
  await expect(page.getByRole('navigation', { name: 'Door' }).getByRole('link')).toHaveText(['Check-in', 'Operators']);
  await page.goto('/admin/concerts/1/import', { waitUntil: 'networkidle' });
  await expect(page.getByRole('navigation', { name: 'Intake' }).getByRole('link')).toHaveText(['Forms', 'Import']);
  await shot(page, `FLOW-3-step-${n++}-intake-tabs`, false);
  await ctx.close();
});

test('FLOW-4 a needs-attention count links to its view and the numbers agree', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'admin');
  await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
  const card = page.locator('section[aria-labelledby="attention"] a', { hasText: 'Suspicious address' });
  const shown = (await card.innerText()).split('\n').map((s) => s.trim()).filter(Boolean)[1];
  const [{ n }] = await sql`select count(*)::int n from party_pipeline where concert_id = 1 and flag_suspicious_address`;
  expect(shown).toBe(String(n));
  await shot(page, 'FLOW-4-step-1-home');
  await card.click();
  await expect(page).toHaveURL(/\/audience\?view=suspicious-address/);
  await page.waitForLoadState('networkidle');
  const rows = await page.locator('table tbody tr').count();
  evidence['FLOW-4'] = { shown, db: n, rows };
  expect(rows).toBe(n);
  await shot(page, 'FLOW-4-step-2-audience-view');
  await ctx.close();
});

test('FLOW-5 admin edits the concert and its concert-level setting', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'admin');
  await page.goto('/admin/concerts/2/setup', { waitUntil: 'networkidle' });
  await shot(page, 'FLOW-5-step-1-setup');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Other T renamed');
  await page.getByRole('textbox', { name: 'Season', exact: true }).fill('2027');
  await page.getByRole('button', { name: 'Save concert' }).click();
  await expect(page.locator('span[role="status"]')).toContainText('Saved');
  await expect.poll(async () => (await sql`select name, season from concerts where id = 2`)[0]).toEqual({ name: 'Other T renamed', season: '2027' });
  await shot(page, 'FLOW-5-step-2-saved', false);
  // the sidebar concert name follows
  await expect(page.locator('[data-sidebar="sidebar"]').getByText('Other T renamed').first()).toBeVisible();

  // concert-level setting
  const row = page.locator('div.border-b', { has: page.locator('code', { hasText: /^form\.max_tickets_per_response$/ }) });
  await row.locator('input').fill('3');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('set for this concert')).toBeVisible();
  const [{ v }] = await sql`select resolve_setting('form.max_tickets_per_response', 4) as v`; // segment 4 is concert 2's
  expect(v).toBe(3);
  const [{ other }] = await sql`select resolve_setting('form.max_tickets_per_response', 5) as other`; // concert 3 unaffected
  evidence['FLOW-5'] = { concert2Segment: v, concert3Segment: other };
  expect(other).toBe(4);
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'FLOW-5-step-3-setting-set', false);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(row.locator('input')).toHaveValue('3');
  await row.getByRole('button', { name: /Inherit/ }).click();
  await expect(row.getByText(/inherits 4 from the system/)).toBeVisible();
  expect((await sql`select resolve_setting('form.max_tickets_per_response', 4) as v`)[0].v).toBe(4);
  await shot(page, 'FLOW-5-step-4-inherits-again', false);
  await sql`update concerts set name = 'Other T', season = null where id = 2`;
  await ctx.close();
});

test('FLOW-6 admin enters bad values in Setup › Concert', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'admin');
  await page.goto('/admin/concerts/3/setup', { waitUntil: 'networkidle' });
  const before = (await sql`select name, starts_on::text, ends_on::text, defaults from concerts where id = 3`)[0];

  // step 1: end before start
  await page.getByLabel('Starts on', { exact: true }).fill('2026-11-21');
  await page.getByLabel('Ends on', { exact: true }).fill('2026-11-20');
  await page.getByRole('button', { name: 'Save concert' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'cannot end' })).toContainText('cannot end before it starts');
  await shot(page, 'FLOW-6-step-1-end-before-start', false);

  // step 2: a concert base quota that oversubscribes the player segment (20 seats, players x quota)
  const [{ players }] = await sql`select count(*)::int players from players where concert_id = 3 and is_active and deleted_at is null`;
  const quota = Math.floor(20 / Math.max(players, 1)) + 1;
  // segment 6 has its own quota (2) so a concert value would be shadowed; clear it for this step
  await sql`update show_segments set base_quota = null where id = 6`;
  await page.reload({ waitUntil: 'networkidle' });
  const row = page.locator('div.border-b', { has: page.locator('code', { hasText: /^allocation\.base_quota$/ }) });
  await row.locator('input').fill(String(quota * 10));
  await row.getByRole('button', { name: 'Save' }).click();
  const alert = row.getByRole('alert');
  await expect(alert).toBeVisible();
  const alertText = await alert.innerText();
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'FLOW-6-step-2-quota-refused', false);
  const after = (await sql`select name, starts_on::text, ends_on::text, defaults from concerts where id = 3`)[0];
  evidence['FLOW-6'] = { players, tried: quota * 10, alertText, before, after };
  await sql`update show_segments set base_quota = 2 where id = 6`;
  expect(after).toEqual(before);
  expect(alertText).toMatch(/Player invited|segment/i);
  await ctx.close();
});

test('FLOW-12 a malformed concert-level deadline is refused at save, and nothing downstream breaks', async ({ browser }) => {
  // Found by this pass: "next tuesday" used to save, and segment_pool() then
  // failed for Home, Shows and the players' public form. Fixed in W: the
  // catalogue checks a timestamp's shape (domain.md §6: a bad value is a
  // validation error at save time).
  const { ctx, page } = await newPage(browser, 'admin');
  await page.goto('/admin/concerts/3/setup', { waitUntil: 'networkidle' });
  const row = page.locator('div.border-b', { has: page.locator('code', { hasText: /^allocation\.base_claim_deadline$/ }) });
  await row.locator('input').fill('next tuesday');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByRole('alert')).toContainText(/timestamp with its zone/);
  await expect(row.getByText('set for this concert')).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'FLOW-12-step-1-garbage-deadline-refused', false);
  const [{ d }] = await sql`select defaults from concerts where id = 3`.then((r) => [{ d: r[0].defaults }]);
  let poolError = '';
  try {
    await sql`select segment_pool(6)`;
  } catch (e) {
    poolError = (e as Error).message;
  }
  const pub = await ctx.newPage();
  const response = await pub.goto('/f/qa-players', { waitUntil: 'networkidle' });
  evidence['FLOW-12'] = { stored: d, poolError, formStatus: response?.status() };
  await ctx.close();
  expect(d === null || !(d as Record<string, unknown>)['allocation.base_claim_deadline']).toBe(true);
  expect(poolError, 'segment_pool(6) raised').toBe('');
  expect(response?.status()).toBeLessThan(500);
});

test('FLOW-7 a viewer walks Home, Setup and Feedback', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'viewer');
  // Home
  await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  expect(await page.getByRole('button', { name: 'Check every address' }).count()).toBe(0);
  const dbEmails = (await sql<{ e: string }[]>`select contact_email::text e from registrations where contact_email is not null`).map((r) => r.e);
  const html = await page.content();
  const leaked = dbEmails.filter((e) => html.includes(e));
  expect(leaked).toEqual([]);
  await shot(page, 'FLOW-7-step-1-viewer-home');

  // Setup › Concert
  await page.goto('/admin/concerts/1/setup', { waitUntil: 'networkidle' });
  expect(await page.getByRole('button', { name: 'Save concert' }).count()).toBe(0);
  expect(await page.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled();
  const row = page.locator('div.border-b', { has: page.locator('code', { hasText: /^portal\.note_max_length$/ }) });
  const input = row.locator('input');
  const editable = await input.isEditable();
  if (editable) await input.fill('12345');
  const typed = await input.inputValue();
  const selectRow = page.locator('div.border-b', { has: page.locator('code', { hasText: /^portal\.enabled$/ }) });
  const selectEnabled = await selectRow.locator('select').isEnabled();
  const allSettingInputs = page.locator('div.border-b input, div.border-b select');
  let editableCount = 0;
  for (const el of await allSettingInputs.all()) if (await el.isEditable()) editableCount++;
  evidence['FLOW-7 setup'] = { noteInputEditable: editable, typed, portalSelectEnabled: selectEnabled, editableSettingControls: editableCount, totalSettingControls: await allSettingInputs.count() };
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'FLOW-7-step-2-viewer-setup-typed', false);
  expect((await sql`select defaults from concerts where id = 1`)[0].defaults).toBeNull();

  // Feedback
  await page.goto('/admin/concerts/1/feedback', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Feedback' })).toBeVisible();
  expect(await page.getByRole('button', { name: /Generate feedback emails|Send now/ }).count()).toBe(0);
  await shot(page, 'FLOW-7-step-3-viewer-feedback');
  await ctx.close();
  expect.soft(editable, 'a viewer can type into a Setup › Concert setting field (§29.6: "A viewer cannot type into Setup’s editors")').toBe(false);
  expect.soft(editableCount, 'editable setting controls for a viewer').toBe(0);
});

test('FLOW-10 Home dates do not move with the browser timezone', async ({ browser }) => {
  const texts: Record<string, string[]> = {};
  for (const tz of ['America/New_York', 'Pacific/Auckland']) {
    const { ctx, page } = await newPage(browser, 'admin', { timezoneId: tz });
    await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
    const dates = page.locator('section[aria-labelledby="dates"] li');
    texts[tz] = (await dates.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    await page.locator('section[aria-labelledby="dates"]').screenshot({ path: `${SHOTS}/FLOW-10-step-${tz === 'America/New_York' ? 1 : 2}-dates-${tz.split('/')[1]}.png` });
    await ctx.close();
  }
  evidence['FLOW-10'] = texts;
  expect(texts['America/New_York']).toEqual(texts['Pacific/Auckland']);
  // Matinee starts 07:00Z = 15:00 in Asia/Kuala_Lumpur
  expect(texts['America/New_York']!.find((t) => t.includes('Show starts') && t.includes('Matinee'))).toContain('15:00');
});

test('FLOW-11 feedback card on a completed show; Generate twice is harmless; viewer has no controls', async ({ browser }) => {
  await sql`update shows set status = 'COMPLETED', ends_at = now() - interval '1 day' where id = 1`;
  await sql`insert into check_ins (attendee_id, show_id, scanned_at, source) values (1, 1, now() - interval '1 day', 'SCAN')`.catch(async (e) => {
    evidence['FLOW-11 checkin insert'] = String(e);
    await sql`insert into check_ins (attendee_id, show_id, scanned_at, source) values (1, 1, now() - interval '1 day', 'MANUAL')`;
  });
  try {
    const { ctx, page } = await newPage(browser, 'admin');
    await page.goto('/admin/concerts/1/feedback', { waitUntil: 'networkidle' });
    const card = page.locator('[data-slot="card"]', { hasText: 'Evening Show' });
    await expect(card).toContainText(/\d+ admitted/);
    const gen = card.getByRole('button', { name: /Generate feedback emails/ });
    await expect(gen).toBeVisible();
    await shot(page, 'FLOW-11-step-1-completed-card');
    const count = async () => (await sql`select count(*)::int n from email_outbox where purpose = 'FEEDBACK' and registration_id = 1 and deleted_at is null`)[0].n as number;
    const before = await count();
    await gen.click();
    await page.waitForTimeout(2500);
    const once = await count();
    const msg1 = await card.innerText();
    await shot(page, 'FLOW-11-step-2-generated');
    await card.getByRole('button', { name: /Generate feedback emails/ }).click();
    await page.waitForTimeout(2500);
    const twice = await count();
    await shot(page, 'FLOW-11-step-3-generated-again');
    evidence['FLOW-11'] = { before, once, twice, msg1: msg1.slice(0, 600) };
    expect(once).toBe(before + 1);
    expect(twice).toBe(once);
    // A non-completed show has no controls.
    await page.goto('/admin/concerts/3/feedback', { waitUntil: 'networkidle' });
    expect(await page.getByRole('button', { name: /Generate feedback emails/ }).count()).toBe(0);
    await shot(page, 'FLOW-11-step-4-open-show-no-controls');
    await ctx.close();
    const v = await newPage(browser, 'viewer');
    await v.page.goto('/admin/concerts/1/feedback', { waitUntil: 'networkidle' });
    await expect(v.page.locator('[data-slot="card"]', { hasText: 'Evening Show' })).toContainText(/\d+ admitted/);
    expect(await v.page.getByRole('button', { name: /Generate feedback emails|Send now/ }).count()).toBe(0);
    await shot(v.page, 'FLOW-11-step-5-viewer-no-controls');
    await v.ctx.close();
  } finally {
    await sql`delete from email_outbox where purpose = 'FEEDBACK' and registration_id = 1`;
    await sql`delete from check_ins where attendee_id = 1 and show_id = 1`;
    await sql`update shows set status = 'OPEN', ends_at = null where id = 1`;
  }
});

test('FLOW-13 heartbeat: never, failed (masked for a viewer), stale by the resolved interval', async ({ browser }) => {
  const secret = 'smtp.secret.person@example.test';
  try {
    const { ctx, page } = await newPage(browser, 'admin');
    await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
    await expect(page.getByText('The scheduler has never run')).toBeVisible();
    await shot(page, 'FLOW-13-step-1-never', false);

    await sql`insert into scheduler_heartbeat (source, started_at, error) values ('qa', now() - interval '5 minutes', ${`SMTP 535 auth failed for ${secret}`})`;
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/The last scheduler tick failed/)).toBeVisible();
    await expect(page.getByText(secret)).toBeVisible();
    await shot(page, 'FLOW-13-step-2-failed-admin', false);
    const v = await newPage(browser, 'viewer');
    await v.page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
    await expect(v.page.getByText(/The last scheduler tick failed/)).toBeVisible();
    expect((await v.page.content()).includes(secret)).toBe(false);
    await shot(v.page, 'FLOW-13-step-3-failed-viewer-masked', false);
    await v.ctx.close();

    await sql`delete from scheduler_heartbeat where source = 'qa'`;
    await sql`insert into scheduler_heartbeat (source, started_at) values ('qa', now() - interval '35 minutes')`;
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/The scheduler last ran 35 min ago/)).toBeVisible();
    await shot(page, 'FLOW-13-step-4-stale-at-10min-ticks', false);
    await sql`update system_settings set value = '15'::jsonb where key = 'scheduler.tick_minutes'`;
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/The scheduler last ran/)).toHaveCount(0);
    await expect(page.getByText(/scheduler ran 35 min ago/)).toBeVisible();
    await shot(page, 'FLOW-13-step-5-ok-at-15min-ticks', false);
    await sql`delete from system_settings where key = 'scheduler.tick_minutes'`;
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('The scheduler is not set up yet')).toBeVisible();
    await shot(page, 'FLOW-13-step-6-unset', false);
    await ctx.close();
  } finally {
    await sql`delete from scheduler_heartbeat where source = 'qa'`;
    await sql`insert into system_settings (key, value) values ('scheduler.tick_minutes', '10'::jsonb) on conflict (key) do update set value = '10'::jsonb`;
  }
});

test('FLOW-14 an email-shaped import filename on Home, as a viewer', async ({ browser }) => {
  const secret = 'alice.private@example.test';
  const { ctx, page } = await newPage(browser, 'admin');
  const csv = Buffer.from('Timestamp,Name,Email,Guest\n,Mask Probe,maskprobe@example.test,Mask Guest\n');
  const profile = JSON.stringify({ columns: { requested_at: 'Timestamp', contact_name: 'Name', contact_email: 'Email', attendee_name: 'Guest' }, default_allocation_type: 'EXTRA' });
  const res = await page.request.post('/api/import', { multipart: { action: 'stage', segmentId: '5', profile, file: { name: `export-from-${secret}.csv`, mimeType: 'text/csv', buffer: csv } } });
  const staged = await res.text();
  const [batch] = await sql`select id, filename from import_batches where filename like ${'%' + secret + '%'} order by id desc limit 1`;
  try {
    await page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
    await expect(page.getByText('Staged import rows')).toBeVisible();
    await shot(page, 'FLOW-14-step-1-admin-home-staged');
    const v = await newPage(browser, 'viewer');
    await v.page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
    await expect(v.page.getByText('Staged import rows')).toBeVisible();
    const html = await v.page.content();
    const shownHint = await v.page.locator('section[aria-labelledby="attention"] a', { hasText: 'Staged import rows' }).innerText();
    await v.page.locator('section[aria-labelledby="attention"]').screenshot({ path: `${SHOTS}/FLOW-14-step-2-viewer-home-filename.png` });
    evidence['FLOW-14'] = { stageStatus: res.status(), staged: staged.slice(0, 200), batch, viewerHint: shownHint, leaked: html.includes(secret) };
    await v.ctx.close();
    expect(html.includes(secret), 'viewer HTML carries an unmasked email-shaped filename').toBe(false);
  } finally {
    if (batch) {
      await sql`delete from import_rows where batch_id = ${batch.id}`;
      await sql`delete from import_batches where id = ${batch.id}`;
    }
    await ctx.close();
  }
});

test('FLOW-15 the setup checklist follows the database', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'admin');
  const item = (label: string) => page.locator('section[aria-labelledby="checklist"] li', { hasText: label });
  const done = async (label: string) => (await item(label).locator('[aria-label="Done"]').count()) > 0;
  const results: Record<string, unknown> = {};
  try {
    await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
    results.endBefore = { done: await done('Every show has an end time'), text: await item('Every show has an end time').innerText() };
    expect(results.endBefore).toMatchObject({ done: false });
    await shot(page, 'FLOW-15-step-1-end-missing', false);
    await sql`update shows set ends_at = starts_at + interval '2 hours' where id in (1, 2)`;
    await page.reload({ waitUntil: 'networkidle' });
    results.endAfter = await done('Every show has an end time');
    expect(results.endAfter).toBe(true);
    await item('Every show has an end time').screenshot({ path: `${SHOTS}/FLOW-15-step-2-end-set.png` });

    // address check: unchecked count. Registration 9 is CANCELLED (no live seats).
    const addr = async () => (await item('Address checks are clean').innerText()).replace(/\s+/g, ' ');
    results.addrBefore = await addr();
    await sql`update registrations set email_checked_at = null where id = 9`;
    await page.reload({ waitUntil: 'networkidle' });
    results.addrWithCancelledUnchecked = await addr();
    await item('Address checks are clean').screenshot({ path: `${SHOTS}/FLOW-15-step-3-cancelled-party-counted.png` });
    evidence['FLOW-15'] = results;
    expect.soft(results.addrWithCancelledUnchecked, 'a cancelled party (off the line) counts as never checked').toBe(results.addrBefore);
  } finally {
    await sql`update shows set ends_at = null where id in (1, 2)`;
    await sql`update registrations set email_checked_at = now() where id = 9`;
    await ctx.close();
  }
});

test('FLOW-16 admin runs "Check every address" from Home', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'admin');
  await sql`update registrations set email_checked_at = null where id = 9`;
  try {
    await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Check every address' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(1500);
    await shot(page, 'FLOW-16-step-1-preview', false);
    const previewText = (await dialog.innerText()).replace(/\s+/g, ' ');
    const typed = dialog.locator('input');
    if (await typed.count()) {
      const phrase = previewText.match(/[Tt]ype[^“"]*[“"]([^”"]+)[”"]/)?.[1];
      if (phrase) await typed.first().fill(phrase);
    }
    const run = dialog.getByRole('button').filter({ hasNotText: /Cancel|Close/ }).last();
    await run.click();
    await page.waitForTimeout(4000);
    await shot(page, 'FLOW-16-step-2-after-run', false);
    const rows = await sql`select id, status::text, email_checked_at is not null as checked from registrations r where id in (9, 11) order by id`;
    await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
    const addr = (await page.locator('section[aria-labelledby="checklist"] li', { hasText: 'Address checks are clean' }).innerText()).replace(/\s+/g, ' ');
    await shot(page, 'FLOW-16-step-3-home-after', false);
    evidence['FLOW-16'] = { previewText: previewText.slice(0, 500), rows, addr };
    expect.soft(addr, 'checklist still says a party was never checked after "Check every address"').not.toMatch(/never been checked/);
  } finally {
    // The check has no DNS in this container, so every example.test address comes back without an MX;
    // put the seed's own flags back (only registration 8 was suspicious, 11 never checked).
    await sql`update registrations set email_issue = null where id in (1,2,3,4,5,6,7,9,10,11)`;
    await sql`update registrations set email_checked_at = null where id = 11`;
    await sql`update registrations set email_checked_at = coalesce(email_checked_at, now()) where id = 9`;
    await ctx.close();
  }
});

test('FLOW-7b a viewer on Setup’s other editors and the form builder', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'viewer');
  const out: Record<string, unknown> = {};
  await page.goto('/admin/concerts/1/email/templates', { waitUntil: 'networkidle' });
  const subject = page.locator('#subject');
  out.emailSubject = (await subject.count()) ? { editable: await subject.isEditable() } : 'no #subject on page';
  const body = page.locator('#bodyMd');
  out.emailBody = (await body.count()) ? { editable: await body.isEditable() } : 'no #bodyMd';
  await shot(page, 'FLOW-7b-step-1-viewer-email-templates', false);
  const [tpl] = await sql`select id from ticket_templates where concert_id = 1 and deleted_at is null order by id limit 1`;
  if (tpl) {
    await page.goto(`/admin/concerts/1/tickets/templates/${tpl.id}`, { waitUntil: 'networkidle' });
    const name = page.locator('#template-name');
    out.ticketName = (await name.count()) ? { editable: await name.isEditable() } : 'no #template-name';
    const pageW = page.locator('#page-w');
    out.ticketPageW = (await pageW.count()) ? { editable: await pageW.isEditable() } : 'no #page-w';
    await shot(page, 'FLOW-7b-step-2-viewer-ticket-design', false);
  }
  await page.goto('/admin/concerts/3/forms/1', { waitUntil: 'networkidle' });
  const editableInBuilder = await page.locator('main input:not([type=hidden]), main textarea, main [contenteditable="true"]').evaluateAll((els) =>
    els.filter((e) => !(e as HTMLInputElement).disabled && !(e as HTMLInputElement).readOnly && (e as HTMLElement).offsetParent !== null).length,
  );
  out.formBuilderEditable = editableInBuilder;
  await shot(page, 'FLOW-7b-step-3-viewer-form-builder', false);
  await page.goto('/admin/concerts/3/forms/1/settings', { waitUntil: 'networkidle' });
  const editableSettings = await page.locator('main input:not([type=hidden]), main textarea, main select').evaluateAll((els) =>
    els.filter((e) => !(e as HTMLInputElement).disabled && !(e as HTMLInputElement).readOnly && (e as HTMLElement).offsetParent !== null && !(e as HTMLElement).closest('fieldset:disabled')).length,
  );
  out.formSettingsEditable = editableSettings;
  await shot(page, 'FLOW-7b-step-4-viewer-form-settings', false);
  await page.goto('/admin/concerts/1/shows', { waitUntil: 'networkidle' });
  out.showsMutatingButtons = await page.getByRole('button', { name: /Add show|Add segment|Edit|Delete|Move/ }).count();
  await shot(page, 'FLOW-7b-step-5-viewer-shows', false);
  evidence['FLOW-7b'] = out;
  await ctx.close();
  expect.soft(out.emailSubject).toEqual({ editable: false });
  expect.soft(out.formBuilderEditable).toBe(0);
  expect.soft(out.formSettingsEditable).toBe(0);
});

test('FLOW-17 Home, Setup and Feedback for a concert with nothing in it', async ({ browser }) => {
  const [{ id }] = await sql`insert into concerts (name, slug, status) values ('QA Empty', ${'qa-empty-' + Date.now()}, 'DRAFT') returning id`;
  try {
    const { ctx, page } = await newPage(browser, 'admin');
    await page.goto(`/admin/concerts/${id}/home`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
    await expect(page.getByText('Nothing is waiting on a person right now.')).toBeVisible();
    await expect(page.getByText('No dates yet.', { exact: false })).toBeVisible();
    const tz = await page.locator('section[aria-labelledby="checklist"] li', { hasText: 'The concert has a timezone' }).locator('[aria-label="To do"]').count();
    expect(tz).toBe(1);
    await shot(page, 'FLOW-17-step-1-empty-home');
    await page.goto(`/admin/concerts/${id}/setup`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: 'Save concert' })).toBeVisible();
    await page.goto(`/admin/concerts/${id}/feedback`, { waitUntil: 'networkidle' });
    await expect(page.getByText('No shows yet')).toBeVisible();
    await shot(page, 'FLOW-17-step-2-empty-feedback', false);
    await ctx.close();
  } finally {
    await sql`delete from concerts where id = ${id}`;
  }
});

test('FLOW-18 "after (feedback enabled)": checklist vs the portal switch', async ({ browser }) => {
  const ids = await sql`insert into registration_forms (title, slug, status, kind, show_id)
    values ('QA fb 1', ${'qa-fb1-' + Date.now()}, 'OPEN', 'FEEDBACK', 1), ('QA fb 2', ${'qa-fb2-' + Date.now()}, 'OPEN', 'FEEDBACK', 2) returning id`;
  try {
    const [{ enabled }] = await sql`select resolve_setting('portal.feedback_enabled', null, 1, 1) as enabled`;
    const { ctx, page } = await newPage(browser, 'admin');
    await page.goto('/admin/concerts/1/home', { waitUntil: 'networkidle' });
    const item = page.locator('section[aria-labelledby="checklist"] li', { hasText: 'Feedback is enabled for every show' });
    const done = (await item.locator('[aria-label="Done"]').count()) > 0;
    await item.screenshot({ path: `${SHOTS}/FLOW-18-step-1-checklist-feedback-done.png` });
    await page.goto('/admin/concerts/1/feedback', { waitUntil: 'networkidle' });
    const portalLine = (await page.locator('[data-slot="card"]', { hasText: 'Evening Show' }).getByText(/In the portal:/).innerText()).replace(/\s+/g, ' ');
    await shot(page, 'FLOW-18-step-2-feedback-hidden-in-portal', false);
    evidence['FLOW-18'] = { resolvedFeedbackEnabled: enabled, checklistDone: done, portalLine };
    await ctx.close();
    expect.soft(done && enabled !== true, 'checklist says feedback is done while portal.feedback_enabled is not on').toBe(false);
  } finally {
    await sql`delete from registration_forms where id in ${sql(ids.map((r) => r.id))}`;
  }
});
