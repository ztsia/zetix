import { test, expect, devices, chromium, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { operatorLogin, sql, SHOTS } from './qa-y-helpers';

/**
 * QA, module Y — phase 5, the door (spec/v3.md §32.2) at a phone viewport.
 * Show 4 (Autumn Evening, concert 3, Asia/Kuala_Lumpur): Wei Ling assigned.
 */
const SHOW = 4;
const WEI = '22222222-2222-4222-8222-222222222222';
const BOB = '44444444-4444-4444-8444-444444444444';
test.use({ ...devices['Pixel 7'], timezoneId: 'America/Los_Angeles' });

async function hideDevOverlay(page: Page) {
  await page.addInitScript(() => {
    const hide = () => {
      const s = document.createElement('style');
      s.textContent = 'nextjs-portal{display:none!important}';
      document.head?.appendChild(s);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
}

const shot = (page: Page, flow: string, step: number, what: string) =>
  page.screenshot({ path: `${SHOTS}/${flow}-step-${step}-${what}.png` });

async function openShow(page: Page) {
  await page.goto(`/scan/${SHOW}`);
  await page.getByRole('tab', { name: 'Search' }).click();
  // the roster has landed when a known name is searchable
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Search by name or ticket code').fill('Nadia');
  await expect(page.getByText('Nadia Hassan').first()).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Search by name or ticket code').fill('');
  await page.getByRole('button', { name: 'Not in', exact: true }).click();
}

const search = (page: Page) => page.getByLabel('Search by name or ticket code');
const n = async (q: ReturnType<typeof sql>) => ((await q) as unknown as { n: number }[])[0].n;

test.beforeAll(async () => {
  await sql`insert into system_settings (key, value) values ('checkin.walk_ins_enabled', 'true'::jsonb), ('checkin.walk_in_max_headcount', '10'::jsonb)
            on conflict (key) do update set value = excluded.value`;
  await sql`delete from operator_show_assignments where user_id = ${BOB}`;
});
test.afterAll(async () => {
  await sql`delete from operator_show_assignments where user_id = ${BOB}`;
});

test('FLOW-5 party search: one card per party, all pre-ticked, admit clears the query', async ({ page }) => {
  await sql`delete from check_ins where show_id = ${SHOW}`;
  await sql`delete from walk_ins where show_id = ${SHOW}`;
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await expect(page).toHaveURL(/\/scan$/);
  await shot(page, 'FLOW-5', 1, 'signed-in-picker');

  await openShow(page);
  await shot(page, 'FLOW-5', 2, 'search-tab');

  await search(page).fill('lim');
  const card = page.getByRole('button', { name: /Party of 4/ }).first();
  await expect(card).toBeVisible();
  await expect(page.getByText('0 of 4 in')).toBeVisible();
  await expect(page.getByText(/^1 party$/)).toBeVisible();
  await expect(page.locator('mark').first()).toHaveText(/lim/i);
  await shot(page, 'FLOW-5', 3, 'party-card');

  await card.click();
  const boxes = page.getByRole('checkbox');
  await expect(boxes).toHaveCount(4);
  for (const b of await boxes.all()) await expect(b).toBeChecked();
  const admit = page.getByRole('button', { name: 'Admit 4' });
  await expect(admit).toBeVisible();
  await shot(page, 'FLOW-5', 4, 'party-sheet-prechecked');

  await admit.click();
  await expect
    .poll(() => n(sql`select count(*)::int n from check_ins c join attendees a on a.id = c.attendee_id
                     where a.full_name like 'Qa Lim%' and c.operator_id = ${WEI} and c.reverted_at is null`), { timeout: 20_000 })
    .toBe(4);
  await expect(search(page)).toHaveValue('');
  await expect(search(page)).toBeFocused();
  await shot(page, 'FLOW-5', 5, 'admitted-query-cleared');
});

test('FLOW-6 already-in member: Not in hides the party, All shows it, ticking reads Admit anyway', async ({ page }) => {
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await openShow(page);
  await search(page).fill('lim');
  await expect(page.getByRole('button', { name: /Party of 4/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Not in', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'FLOW-6', 1, 'not-in-default-hides-all-in');

  await page.getByRole('button', { name: 'All', exact: true }).click();
  const card = page.getByRole('button', { name: /Party of 4/ }).first();
  await expect(card).toBeVisible();
  await expect(page.getByText('All in')).toBeVisible();
  await shot(page, 'FLOW-6', 2, 'all-shows-all-in');

  await card.click();
  const boxes = page.getByRole('checkbox');
  for (const b of await boxes.all()) await expect(b).not.toBeChecked();
  await boxes.first().check();
  const btn = page.getByRole('button', { name: 'Admit anyway (1)' });
  await expect(btn).toBeVisible();
  await shot(page, 'FLOW-6', 3, 'admit-anyway');
  await btn.click();
  await expect
    .poll(() => n(sql`select count(*)::int n from check_ins c join attendees a on a.id = c.attendee_id
                     where a.full_name like 'Qa Lim%' and c.override_reason = 'Admitted again at the door'`), { timeout: 20_000 })
    .toBe(1);
  const [row] = await sql`select c.source, c.override_reason from check_ins c join attendees a on a.id = c.attendee_id
                          where a.full_name like 'Qa Lim%' and c.override_reason = 'Admitted again at the door'`;
  expect(row.source).toBe('MANUAL');
  await shot(page, 'FLOW-6', 4, 'override-recorded');
  test.info().annotations.push({ type: 'evidence', description: JSON.stringify(row) });
});

test('FLOW-19 unticketed party: found by search, admitted with "No ticket issued"', async ({ page }) => {
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await openShow(page);
  await search(page).fill('yui');
  const card = page.getByRole('button', { name: /Party of 2/ }).first();
  await expect(card).toBeVisible();
  await expect(page.getByText('No ticket').first()).toBeVisible();
  await shot(page, 'FLOW-19', 1, 'no-ticket-card');
  await card.click();
  const boxes = page.getByRole('checkbox');
  await expect(boxes).toHaveCount(2);
  const states = await Promise.all((await boxes.all()).map((b) => b.isChecked()));
  test.info().annotations.push({ type: 'prechecked', description: JSON.stringify(states) });
  await shot(page, 'FLOW-19', 2, 'party-sheet');
  for (const b of await boxes.all()) await b.check();
  const btn = page.getByRole('button', { name: /Admit/ }).first();
  const label = await btn.innerText();
  test.info().annotations.push({ type: 'button', description: label });
  expect(label).toMatch(/Admit anyway \(2\)/);
  await btn.click();
  await expect
    .poll(() => n(sql`select count(*)::int n from check_ins c join attendees a on a.id = c.attendee_id
                     where a.full_name in ('Kenji Sato','Yui Sato') and c.override_reason like 'No ticket issued%'`), { timeout: 20_000 })
    .toBe(2);
  await shot(page, 'FLOW-19', 3, 'admitted');
});

test('FLOW-7 no match offers Record as walk-in; one event row; Stats counts it', async ({ page }) => {
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await openShow(page);
  await search(page).fill('Zebedee Quux');
  await expect(page.getByText(/No match|no match|Nobody/).first()).toBeVisible();
  await shot(page, 'FLOW-7', 1, 'no-match');
  await page.getByRole('button', { name: 'Record as walk-in' }).click();
  await expect(page.getByLabel('Name or note (optional)')).toHaveValue('Zebedee Quux');
  await page.getByRole('button', { name: 'One more' }).click();
  await page.getByRole('button', { name: 'One more' }).click();
  await shot(page, 'FLOW-7', 2, 'walk-in-sheet');
  // dark everywhere: the drawer is portalled out of the page tree
  const bg = await page.locator('[data-slot="drawer-content"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  test.info().annotations.push({ type: 'drawer-bg', description: bg });
  await page.getByRole('button', { name: 'Admit 3 walk-ins' }).click();
  await expect
    .poll(() => n(sql`select coalesce(sum(headcount),0)::int n from walk_ins where show_id = ${SHOW} and label = 'Zebedee Quux'`), { timeout: 20_000 })
    .toBe(3);
  const [w] = await sql`select operator_id, device_id, admitted_at, synced_at, segment_id from walk_ins where label = 'Zebedee Quux'`;
  expect(w.operator_id).toBe(WEI);
  expect(w.device_id).toBeTruthy();
  await shot(page, 'FLOW-7', 3, 'walk-in-recorded');

  await page.getByRole('tab', { name: 'Stats' }).click();
  const db = await sql`select
      (select coalesce(sum(headcount),0)::int from walk_ins where show_id=${SHOW} and reverted_at is null) w,
      (select count(distinct attendee_id)::int from check_ins where show_id=${SHOW} and reverted_at is null) t`;
  const inHall = db[0].w + db[0].t;
  await expect(page.getByText('In the hall')).toBeVisible();
  await expect(page.locator('body')).toContainText(String(inHall));
  await expect(page.getByText(/as of \d\d:\d\d/i).first()).toBeVisible();
  await page.waitForTimeout(1500); // let the admission flash clear
  const asOf = (await page.getByText(/as of \d\d:\d\d/i).first().innerText()).match(/\d\d:\d\d/)![0];
  const fmt = (tz: string) => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  test.info().annotations.push({ type: 'as-of', description: `${asOf}; KL now ${fmt('Asia/Kuala_Lumpur')}; LA now ${fmt('America/Los_Angeles')}` });
  expect(asOf.slice(0, 2)).toBe(fmt('Asia/Kuala_Lumpur').slice(0, 2));
  await shot(page, 'FLOW-7', 4, 'stats');
  test.info().annotations.push({ type: 'inHall', description: String(inHall) });
});

test('FLOW-9 offline: admit, stats stale, reconnect syncs', async ({ page, context }) => {
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await openShow(page);
  await page.getByRole('tab', { name: 'Stats' }).click();
  await expect(page.getByText('In the hall')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('Offline').first()).toBeVisible();
  await shot(page, 'FLOW-9', 1, 'offline');

  await page.getByRole('tab', { name: 'Search' }).click();
  await search(page).fill('nadia');
  await page.getByRole('button', { name: /Party of 2/ }).first().click();
  await page.getByRole('button', { name: 'Admit 2' }).click();
  await expect(page.getByText('Offline · 2 waiting')).toBeVisible();
  expect(await n(sql`select count(*)::int n from check_ins c join attendees a on a.id=c.attendee_id where a.registration_id = 13`)).toBe(0);
  await shot(page, 'FLOW-9', 2, 'queued-offline');

  await page.getByRole('tab', { name: 'Stats' }).click();
  await expect(page.getByText(/2 from this phone not yet counted|2 waiting to sync/).first()).toBeVisible();
  await shot(page, 'FLOW-9', 3, 'stats-stale');

  await context.setOffline(false);
  await expect
    .poll(() => n(sql`select count(*)::int n from check_ins c join attendees a on a.id=c.attendee_id where a.registration_id = 13`), { timeout: 30_000 })
    .toBe(2);
  await expect(page.getByText(/waiting/)).toHaveCount(0, { timeout: 15_000 });
  await shot(page, 'FLOW-9', 4, 'synced');
});

test('FLOW-20 a refused row is set aside, never re-sent, and the header says so', async ({ page, context }) => {
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await openShow(page);
  await context.setOffline(true);
  await search(page).fill('minted');
  await page.getByRole('button', { name: /One seat/ }).first().click();
  await page.getByRole('button', { name: /^Admit 1$/ }).click();
  await expect(page.getByText('Offline · 1 waiting')).toBeVisible();
  // the seat disappears on the server before the phone syncs
  await sql`update attendees set deleted_at = now() where full_name = 'Qa Minted Solo'`;
  let posts = 0;
  page.on('request', (r) => { if (r.url().includes('/api/checkin/scan') && r.method() === 'POST') posts += 1; });
  await context.setOffline(false);
  const refused = page.getByRole('button', { name: /couldn't sync — tap for details/ });
  await expect(refused).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-20', 1, 'refused-header');
  await refused.click();
  await expect(page.getByText(/no such seat/)).toBeVisible();
  await shot(page, 'FLOW-20', 2, 'refused-details');
  await page.keyboard.press('Escape');
  const before = posts;
  // trigger another drain: offline then online
  await context.setOffline(true);
  await page.waitForTimeout(500);
  await shot(page, 'FLOW-20', 3, 'offline-with-refused');
  const offlineShown = await page.getByText('Offline').count();
  test.info().annotations.push({ type: 'offline-badge-visible-while-refused', description: String(offlineShown) });
  await context.setOffline(false);
  await page.waitForTimeout(3000);
  expect(posts - before, 'refused row must not be re-sent').toBe(0);
  await sql`update attendees set deleted_at = null where full_name = 'Qa Minted Solo'`;
  expect.soft(offlineShown, 'header should still say Offline while a refused row is listed').toBeGreaterThan(0);
});

test('FLOW-10 account menu; sign out with queued scans asks first, wipes the roster, keeps them tagged', async ({ page, context }) => {
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await openShow(page);
  // keep the admission unsynced while online
  await page.route('**/api/checkin/scan', (r) => r.abort());
  await search(page).fill('review');
  await page.getByRole('button', { name: /One seat/ }).first().click();
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /Admit anyway \(1\)/ }).click();
  await expect(page.getByText('1 waiting')).toBeVisible({ timeout: 10_000 });
  await shot(page, 'FLOW-10', 1, 'one-unsynced');

  await page.getByRole('button', { name: 'Account and sign out' }).click();
  await expect(page.getByRole('menu')).toContainText('Wei Ling');
  await expect(page.getByRole('menuitem', { name: 'Switch show' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Check this phone' })).toBeVisible();
  await shot(page, 'FLOW-10', 2, 'account-menu');
  const menuBg = await page.locator('[data-slot="dropdown-menu-content"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  test.info().annotations.push({ type: 'menu-bg', description: menuBg });

  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('alertdialog')).toContainText("1 admission hasn't synced");
  await shot(page, 'FLOW-10', 3, 'confirm-dialog');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/scan\/login/, { timeout: 20_000 });
  await shot(page, 'FLOW-10', 4, 'signed-out');

  const idb = await page.evaluate(() => new Promise<{ manifests: number; queue: { operatorId?: string; syncedAt?: string }[] }>((resolve) => {
    const open = indexedDB.open('zetix-checkin');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['manifests', 'queue'], 'readonly');
      const m = tx.objectStore('manifests').count();
      const q = tx.objectStore('queue').getAll();
      tx.oncomplete = () => resolve({ manifests: m.result, queue: q.result });
    };
  }));
  test.info().annotations.push({ type: 'idb-after-signout', description: JSON.stringify({ manifests: idb.manifests, queue: idb.queue.map((r) => ({ op: r.operatorId, synced: !!r.syncedAt })) }) });
  expect(idb.manifests).toBe(0);
  const unsynced = idb.queue.filter((r) => !r.syncedAt);
  expect(unsynced.length).toBe(1);
  expect(unsynced[0].operatorId).toBe(WEI);

  // Bob is rostered on show 4 for this flow and signs in on the same phone
  await page.unroute('**/api/checkin/scan');
  await sql`insert into operator_show_assignments (user_id, show_id) values (${BOB}, ${SHOW}) on conflict do nothing`;
  await operatorLogin(page, 'Bob', 'qa-op-code-2');
  await page.goto(`/scan/${SHOW}`);
  await expect(page.getByText('1 admission from Wei Ling is waiting')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'FLOW-10', 5, 'bob-told-whose');
  await page.waitForTimeout(3000);
  expect(await n(sql`select count(*)::int n from check_ins c join attendees a on a.id=c.attendee_id where a.full_name='Qa Review Solo'`)).toBe(0);

  // Bob signs out; Wei signs back in and his scan goes, as his
  await page.getByRole('button', { name: 'Account and sign out' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/scan\/login/, { timeout: 20_000 });
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await page.goto(`/scan/${SHOW}`);
  await expect
    .poll(() => sql`select c.operator_id from check_ins c join attendees a on a.id=c.attendee_id where a.full_name='Qa Review Solo'`.then((r) => r.map((x) => x.operator_id)), { timeout: 30_000 })
    .toEqual([WEI]);
  await shot(page, 'FLOW-10', 6, 'wei-synced-as-wei');
  await sql`delete from operator_show_assignments where user_id = ${BOB}`;
});

test('FLOW-21 sign out with only an unsynced walk-in queued', async ({ page, context }) => {
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await openShow(page);
  await page.route('**/api/checkin/walk-ins', (r) => r.abort());
  await page.getByRole('tab', { name: 'Scan' }).click();
  await page.getByRole('button', { name: 'Walk-in' }).click();
  await page.getByRole('button', { name: 'Admit 1 walk-in' }).click();
  await expect(page.getByText(/1 waiting/)).toBeVisible({ timeout: 10_000 });
  await shot(page, 'FLOW-21', 1, 'walk-in-unsynced');
  await page.getByRole('button', { name: 'Account and sign out' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  const asked = await page.getByRole('alertdialog').isVisible().catch(() => false);
  await page.waitForTimeout(1500);
  await shot(page, 'FLOW-21', 2, 'after-sign-out-tap');
  test.info().annotations.push({ type: 'asked-first', description: String(asked) });
  if (asked) await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/scan\/login/, { timeout: 20_000 });
  await page.unroute('**/api/checkin/walk-ins');
  expect.soft(asked, 'an unsynced walk-in is an unsynced admission: sign-out should ask first').toBe(true);
});

test('AC-29 expired session says so, with the count', async ({ page, context }) => {
  await hideDevOverlay(page);
  await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  await openShow(page);
  await context.setOffline(true);
  await search(page).fill('haruto');
  await page.getByRole('button', { name: /One seat/ }).first().click();
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /Admit/ }).first().click();
  await expect(page.getByText('Offline · 1 waiting')).toBeVisible();
  await context.clearCookies();
  await context.setOffline(false);
  await expect(page.getByText('Signed out — sign in again to send 1 queued')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'AC-29', 1, 'expired-session');
});

test('FLOW-11 unassigned operator cannot open show 4', async ({ page }) => {
  await hideDevOverlay(page);
  await sql`delete from operator_show_assignments where user_id = ${BOB}`;
  await operatorLogin(page, 'Bob', 'qa-op-code-2');
  await shot(page, 'FLOW-11', 1, 'bob-picker');
  const manifestCalls: number[] = [];
  page.on('response', (r) => { if (r.url().includes('/api/checkin/manifest')) manifestCalls.push(r.status()); });
  const res = await page.goto(`/scan/${SHOW}`);
  await shot(page, 'FLOW-11', 2, 'refused');
  expect(res?.status()).toBe(404);
  await expect(page.locator('body')).not.toContainText('Nadia');
  expect(manifestCalls.filter((s) => s === 200)).toEqual([]);
});

// ── FLOW-12: a real QR through the real camera path ──
async function withCamera(token: string, fn: (page: Page, ctx: BrowserContext) => Promise<void>) {
  const browser: Browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=/tmp/claude-0/qr/y-${token}.y4m`],
  });
  const ctx = await browser.newContext({ ...devices['Pixel 7'], baseURL: 'http://localhost:3100', permissions: ['camera'] });
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

test('FLOW-12 waitlisted seat scans red "Not confirmed" with Admit anyway; nothing recorded unless overridden', async () => {
  await withCamera('QaWaitTok000000000001W', async (page) => {
    await hideDevOverlay(page);
    await operatorLogin(page, 'Wei Ling', 'qa-op-code');
    await openShow(page);
    await page.getByRole('tab', { name: 'Scan' }).click();
    await page.getByRole('button', { name: 'Start scanning' }).click();
    const overlay = page.locator('[data-slot="scan-result"]');
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    await expect(overlay).toContainText('Not confirmed');
    await expect(overlay.getByRole('button', { name: /Admit anyway/ })).toBeVisible();
    await shot(page, 'FLOW-12', 1, 'not-confirmed-red');
    await page.waitForTimeout(1500);
    expect(await n(sql`select count(*)::int n from check_ins c join attendees a on a.id=c.attendee_id where a.full_name like 'Qa Wait%'`)).toBe(0);
  });
});

test('FLOW-22 cancelled seat scans red "Cancelled" (regression)', async () => {
  await withCamera('QaCnclTok000000000001C', async (page) => {
    await hideDevOverlay(page);
    await operatorLogin(page, 'Wei Ling', 'qa-op-code');
    await openShow(page);
    await page.getByRole('tab', { name: 'Scan' }).click();
    await page.getByRole('button', { name: 'Start scanning' }).click();
    const overlay = page.locator('[data-slot="scan-result"]');
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    await expect(overlay).toContainText(/Cancelled/i);
    await shot(page, 'FLOW-22', 1, 'cancelled-red');
  });
});
