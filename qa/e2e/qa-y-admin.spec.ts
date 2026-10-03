import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { adminLogin, sql, SHOTS } from './qa-y-helpers';

/**
 * QA, module Y — phase 5, admin tables (spec/v3.md §32.1) and the Door screen (§32.2).
 * Desktop viewport, browser timezone deliberately not the concert's.
 */
test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles', acceptDownloads: true });

const shot = (page: Page, flow: string, step: number, what: string) =>
  page.screenshot({ path: `${SHOTS}/${flow}-step-${step}-${what}.png`, fullPage: false });

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

async function exportCsv(page: Page): Promise<{ label: string; rows: string[][] }> {
  await page.getByRole('button', { name: 'Export' }).first().click();
  const label = (await page.getByRole('menu').innerText()).split('\n')[0];
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'CSV' }).click()]);
  const rows = parseCsv(readFileSync(await download.path(), 'utf8'));
  return { label, rows: rows.slice(1) };
}

test('FLOW-1 audience: Select all N matching → every count agrees → export has N rows; untick 2 → N-2', async ({ page }) => {
  test.setTimeout(120_000);
  await adminLogin(page);
  await page.goto('/admin/concerts/1/audience');
  const total = await sql`select count(*)::int n from party_pipeline where concert_id = 1`.catch(async () =>
    sql`select count(*)::int n from registrations r join shows s on s.id=r.show_id where s.concert_id = 1 and r.deleted_at is null`);
  const N = total[0].n as number;
  await expect(page.getByText(`${N} rows`)).toBeVisible();
  await shot(page, 'FLOW-1', 1, 'audience-paged');

  await page.getByRole('checkbox', { name: 'Select all rows on this page' }).check();
  await page.getByRole('button', { name: `Select all ${N} that match these filters` }).click();
  await expect(page.getByRole('status').filter({ hasText: 'are selected' })).toContainText(`All ${N}`);
  const actions = await page.getByRole('button', { name: /^Actions/ }).innerText();
  const footer = await page.locator('main').innerText();
  test.info().annotations.push({ type: 'actions-label', description: actions });
  await shot(page, 'FLOW-1', 2, 'select-all-matching');
  const all = await exportCsv(page);
  await shot(page, 'FLOW-1', 3, 'export-menu');
  test.info().annotations.push({ type: 'export', description: `${all.label} → ${all.rows.length}` });
  expect(all.label).toContain(`all ${N} matching`);
  expect(all.rows.length).toBe(N);
  expect(actions).toContain(String(N));
  expect(footer).toContain(String(N));
  await page.keyboard.press('Escape');

  // untick two on page 1
  const rowBoxes = page.getByRole('checkbox', { name: 'Select row' });
  await rowBoxes.nth(0).uncheck();
  await rowBoxes.nth(1).uncheck();
  await expect(page.getByRole('status').filter({ hasText: 'except' })).toContainText('except 2');
  const actions2 = await page.getByRole('button', { name: /^Actions/ }).innerText();
  const less = await exportCsv(page);
  await shot(page, 'FLOW-1', 4, 'except-two');
  test.info().annotations.push({ type: 'export-except', description: `${less.label} → ${less.rows.length}; actions=${actions2}` });
  expect(less.rows.length).toBe(N - 2);
  expect(less.label).toContain(`${N - 2}`);
  expect(actions2).toContain(String(N - 2));
});

test('FLOW-2 audience: ticked rows across two pages export exactly those', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/admin/concerts/1/audience');
  const boxes = page.getByRole('checkbox', { name: 'Select row' });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Page 2 of')).toBeVisible();
  await boxes.nth(0).check();
  await shot(page, 'FLOW-2', 1, 'ticked-two-pages');
  const out = await exportCsv(page);
  await shot(page, 'FLOW-2', 2, 'export-ticked');
  test.info().annotations.push({ type: 'export', description: `${out.label} → ${out.rows.length}` });
  expect(out.label).toContain('the 3 ticked');
  expect(out.rows.length).toBe(3);
});

test('FLOW-1b filtered and seats-grain exports cover the whole filter, not the page', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/admin/concerts/1/audience?q=Bulk');
  await page.goto('/admin/concerts/1/audience');
  await page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first().fill('Bulk Party');
  await expect(page.getByText('60 rows')).toBeVisible({ timeout: 15_000 });
  const f = await exportCsv(page);
  await shot(page, 'FLOW-1b', 1, 'filtered-export');
  expect(f.label).toContain('all 60 matching');
  expect(f.rows.length).toBe(60);

  await page.goto('/admin/concerts/1/audience?grain=seats');
  const seats = await sql`select count(*)::int n from attendees a join shows s on s.id=a.show_id where s.concert_id=1 and a.deleted_at is null`;
  const footer = await page.locator('main').innerText();
  const m = footer.match(/(\d+) rows/);
  const g = await exportCsv(page);
  await shot(page, 'FLOW-1b', 2, 'seats-export');
  test.info().annotations.push({ type: 'seats', description: `footer=${m?.[1]} db=${seats[0].n} export=${g.rows.length} label=${g.label}` });
  expect(g.rows.length).toBe(Number(m?.[1]));
  expect(Number(m?.[1])).toBeGreaterThan(25);
});

test('FLOW-4 messages: bounced tab exports; a ticked message from a filtered tab exports', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/admin/concerts/1/audience/messages');
  await page.getByRole('tab', { name: /Bounced/ }).click();
  await expect(page.getByText('1 row')).toBeVisible();
  const b = await exportCsv(page);
  await shot(page, 'FLOW-4', 1, 'messages-bounced-export');
  expect(b.rows.length).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Failed/ }).click();
  await page.getByRole('checkbox', { name: 'Select row' }).first().check();
  const t = await exportCsv(page);
  test.info().annotations.push({ type: 'messages', description: `bounced=${b.rows.length} ${b.label}; failed ticked=${t.rows.length} ${t.label}` });
  expect(t.label).toContain('the 1 ticked');
  expect(t.rows.length).toBe(1);
});

test('FLOW-4b export inventory: activity has one, concerts list and form responses table do not', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/admin/concerts/1/activity');
  await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(1);
  await shot(page, 'FLOW-4b', 1, 'activity-export');
  const a = await exportCsv(page);
  const dbAudit = await sql`select count(*)::int n from audit_log where concert_id = 1`;
  test.info().annotations.push({ type: 'activity', description: `${a.label} → ${a.rows.length}; audit rows concert 1=${dbAudit[0].n}` });
  await page.keyboard.press('Escape');

  await page.goto('/admin/concerts');
  await expect(page.getByRole('heading', { name: 'Concerts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await shot(page, 'FLOW-4b', 2, 'concerts-no-export');

  await page.goto('/admin/concerts/3/forms/1/responses');
  await page.waitForLoadState('networkidle');
  const buttons = await page.getByRole('button').allInnerTexts();
  test.info().annotations.push({ type: 'responses-buttons', description: buttons.join(' | ') });
  await shot(page, 'FLOW-4b', 3, 'responses');
  expect(buttons.filter((b) => b.trim() === 'Export')).toEqual([]);
});

test('FLOW-3 viewer: no export control on audience, messages, door; door revert hidden', async ({ page }) => {
  await adminLogin(page, 'mei@example.test', 'qa-viewer-pass');
  for (const [i, p] of ['/admin/concerts/1/audience', '/admin/concerts/1/audience/messages', '/admin/concerts/1/activity', '/admin/concerts/3/checkin?show=4'].entries()) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
    await shot(page, 'FLOW-3', i + 1, p.split('/').pop()!.replace(/[?=]/g, '-'));
    await expect(page.getByRole('button', { name: 'Export' }), p).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Revert/ }), p).toHaveCount(0);
  }
});

test('FLOW-17 Door screen: in the hall, walk-ins log, export includes walk-ins, revert is audited; FLOW-18 times in concert zone', async ({ page }) => {
  test.setTimeout(120_000);
  await sql`insert into walk_ins (client_id, show_id, headcount, label, operator_id, device_id, admitted_at)
            values (gen_random_uuid(), 4, 2, 'QA door walk-in', '22222222-2222-4222-8222-222222222222', 'qa', '2026-11-20 11:05:00+00')`;
  await adminLogin(page);
  await page.goto('/admin/concerts/3/checkin?show=4');
  const db = await sql`select
      (select coalesce(sum(headcount),0)::int from walk_ins where show_id=4 and reverted_at is null) w,
      (select count(distinct attendee_id)::int from check_ins where show_id=4 and reverted_at is null) t`;
  const inHall = db[0].w + db[0].t;
  await expect(page.getByText(`In the hall ${inHall}`).or(page.getByText('In the hall'))).toBeVisible();
  const main = await page.locator('main').innerText();
  expect(main).toMatch(new RegExp(`In the hall\\s*${inHall}`));
  // 11:05 UTC is 19:05 in Asia/Kuala_Lumpur and 03:05 in Los Angeles
  await expect(page.getByRole('row').filter({ hasText: 'QA door walk-in' })).toContainText('2026-11-20 19:05');
  await shot(page, 'FLOW-17', 1, 'door-screen');

  const ex = await exportCsv(page);
  const kinds = ex.rows.map((r) => r[0]);
  test.info().annotations.push({ type: 'door-export', description: `${ex.label} → ${ex.rows.length}; kinds=${[...new Set(kinds)].join(',')}` });
  expect(ex.rows.some((r) => r.join(',').includes('QA door walk-in'))).toBe(true);
  await page.keyboard.press('Escape');
  await shot(page, 'FLOW-17', 2, 'door-export');

  await page.getByRole('button', { name: 'Revert the walk-in "QA door walk-in"' }).click();
  await shot(page, 'FLOW-17', 3, 'revert-dialog');
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await dialog.getByRole('button', { name: /Revert/ }).last().click();
  await expect
    .poll(() => sql`select count(*)::int n from audit_log where action = 'checkin.walk_in_reverted'`.then((r) => r[0].n), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const [w] = await sql`select reverted_at, reverted_by from walk_ins where label = 'QA door walk-in'`;
  expect(w.reverted_by).toBe('11111111-1111-4111-8111-111111111111');
  await page.reload();
  const main2 = await page.locator('main').innerText();
  expect(main2).toMatch(new RegExp(`In the hall\\s*${inHall - 2}`));
  await shot(page, 'FLOW-17', 4, 'reverted');
});
