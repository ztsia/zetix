/**
 * QA pass 2 — the shared `DataTable` and the surface rules, in a real browser.
 * spec/surfaces.md §15, §15.1; spec/domain.md §6.1.
 */
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';

const SHOTS = path.resolve('qa-artifacts/F2-app-shell-auth/screens');
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

async function signInAdmin(page: Page) {
  await sql`delete from auth_failures`;
  await page.goto('/login');
  await page.fill('#code', 'correct-admin-code');
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin/**', { timeout: 20000 });
}

const bodyRows = (page: Page) => page.locator('table tbody tr');
test.afterAll(async () => { await sql.end(); });

// ---------------------------------------------------------------- FLOW-10
test('FLOW-10 admin drives the DataTable end to end', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/concerts');
  await expect(bodyRows(page).first()).toBeVisible();
  const total = Number((await sql`select count(*) from concerts where deleted_at is null`)[0].count);

  // AC-35 — page size governs the rendered row count.
  expect(await bodyRows(page).count()).toBe(Math.min(25, total));
  await expect(page.getByText(`${total} rows`)).toBeVisible();
  await shot(page, 'FLOW-10-step-1-table');

  // AC-32 — sorting changes the first row to the extreme value.
  const firstBefore = await bodyRows(page).first().innerText();
  await page.getByRole('button', { name: 'Name' }).click();
  await page.getByRole('menuitem', { name: /^Asc/ }).click();
  const firstAsc = await bodyRows(page).first().innerText();
  await page.getByRole('button', { name: 'Name' }).click();
  await page.getByRole('menuitem', { name: /^Desc/ }).click();
  const firstDesc = await bodyRows(page).first().innerText();
  expect(firstAsc).not.toBe(firstDesc);
  expect(firstDesc).toContain('QA Concert');
  await shot(page, 'FLOW-10-step-2-sorted-desc');
  expect(firstBefore.length).toBeGreaterThan(0);

  // AC-33 — filtering narrows to exactly the matching rows.
  const expected = Number(
    (await sql`select count(*) from concerts where name ilike '%Concert 1%' and deleted_at is null`)[0].count,
  );
  await page.getByPlaceholder('Search concerts…').fill('Concert 1');
  await expect(bodyRows(page)).toHaveCount(Math.min(expected, 25));
  await expect(page.getByText(`${expected} rows`)).toBeVisible();
  await shot(page, 'FLOW-10-step-3-filtered');
  await page.getByPlaceholder('Search concerts…').fill('');
  await expect(bodyRows(page)).toHaveCount(Math.min(25, total));

  // AC-35 — page size 10.
  await page.getByLabel('Rows per page').click();
  await page.getByRole('option', { name: '10', exact: true }).click();
  await expect(bodyRows(page)).toHaveCount(10);
  await shot(page, 'FLOW-10-step-4-page-size-10');

  // AC-36 — column visibility.
  await expect(page.locator('table thead th', { hasText: 'Season' })).toHaveCount(1);
  await page.getByRole('button', { name: /View|Columns/i }).click();
  await page.getByRole('menuitemcheckbox', { name: /Season/i }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('table thead th', { hasText: 'Season' })).toHaveCount(0);
  await shot(page, 'FLOW-10-step-5-column-hidden');
  await page.getByRole('button', { name: /View|Columns/i }).click();
  await page.getByRole('menuitemcheckbox', { name: /Season/i }).click();
  await page.keyboard.press('Escape');

  // AC-40 — selection follows the row, not the index, across a re-sort.
  const search = page.getByPlaceholder('Search concerts\u2026');
  await page.getByRole('button', { name: 'Name' }).click();
  await page.getByRole('menuitem', { name: /^Asc/ }).click();
  await search.fill('Concert 05');
  await expect(bodyRows(page)).toHaveCount(1);
  await bodyRows(page).first().locator('input[type=checkbox], [role=checkbox]').first().click();
  await expect(page.getByText(/^1 of \d+ rows? selected$/)).toBeVisible();
  await search.fill('');
  await page.getByRole('button', { name: 'Name' }).click();
  await page.getByRole('menuitem', { name: /^Desc/ }).click();
  await search.fill('Concert 05');
  const selected = page.locator('table tbody tr[data-state=selected]');
  await expect(selected).toHaveCount(1);
  expect(await selected.innerText()).toContain('Concert 05');
  await shot(page, 'FLOW-10-step-6-selection-survives-resort');
  await search.fill('');

  // AC-37 — CSV export follows the selection, not the whole dataset.
  const download = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: /Export/i }).click();
      await page.getByRole('menuitem', { name: /CSV/i }).click();
    })(),
  ]).then(([d]) => d);
  const csv = fs.readFileSync((await download.path())!, 'utf8');
  const lines = csv.trim().split('\r\n');
  expect(lines.length).toBe(2);
  expect(lines[1]).toContain('Concert 05');
  await shot(page, 'FLOW-10-step-7-export');

  // AC-38 — a name that begins with `=` must be neutralised in the file.
  await search.fill('Concert 05');
  await bodyRows(page).first().locator('input[type=checkbox], [role=checkbox]').first().click();
  await search.fill('HYPERLINK');
  await expect(bodyRows(page)).toHaveCount(1);
  const d2 = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: /Export/i }).click();
      await page.getByRole('menuitem', { name: /CSV/i }).click();
    })(),
  ]).then(([d]) => d);
  const csv2 = fs.readFileSync((await d2.path())!, 'utf8');
  const dataLine = csv2.trim().split('\r\n')[1];
  expect(dataLine).toMatch(/^"'=HYPERLINK/);
  await shot(page, 'FLOW-10-step-8-formula-escaped');
});

// ---------------------------------------------------------------- FLOW-11
test('FLOW-11 a filter that matches nothing shows an empty state', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/concerts');
  await page.getByPlaceholder('Search concerts…').fill('zzzz-no-such-concert-zzzz');
  await expect(page.getByText('No matches')).toBeVisible();
  await expect(page.getByText('0 rows')).toBeVisible();
  await shot(page, 'FLOW-11-step-1-empty-state');
});

// ---------------------------------------------- AC-35 server-side pagination
test('AC-35 pagination is server-side (surfaces.md §15.1)', async ({ page }) => {
  await signInAdmin(page);
  const responses: string[] = [];
  page.on('response', (r) => responses.push(r.url()));
  await page.goto('/admin/concerts');
  await expect(page.locator('table tbody tr').first()).toBeVisible();

  const html = await page.content();
  const total = Number((await sql`select count(*) from concerts where deleted_at is null`)[0].count);
  // If pagination were server-side, only one page of rows would reach the
  // browser. Every row's slug is in the RSC payload, so count them.
  const shipped = (await page.content()).match(/concert-\d\d/g) ?? [];
  const distinct = new Set(shipped).size;
  expect(html.length).toBeGreaterThan(0);
  // This assertion states what the spec asks for; it is expected to FAIL today.
  expect(distinct, `slugs shipped to the browser on page 1 of ${total}`).toBeLessThanOrEqual(25);
});

// ---------------------------------------------------------------- FLOW-13
test('FLOW-13 timestamps do not move with the viewer timezone', async ({ browser }) => {
  const seen: string[] = [];
  for (const timezoneId of ['Asia/Singapore', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    const ctx = await browser.newContext({ timezoneId });
    const page = await ctx.newPage();
    await signInAdmin(page);
    const res = await page.request.post('/api/export/xlsx', {
      data: {
        filename: 'tz', headers: ['When'],
        rows: [[{ date: '2026-09-19T15:30:00Z' }]],
        timeZone: 'Asia/Singapore',
      },
    });
    expect(res.status()).toBe(200);
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(new Uint8Array(await res.body()) as any);
    seen.push(String(wb.worksheets[0].getRow(2).getCell(1).value));
    await page.goto('/admin/concerts/1/overview');
    await shot(page, `FLOW-13-step-1-${timezoneId.replace('/', '-')}`);
    await ctx.close();
  }
  // The same instant renders identically regardless of the viewer's zone.
  expect(seen).toEqual(['2026-09-19 23:30', '2026-09-19 23:30', '2026-09-19 23:30']);
});

// ---------------------------------------------- AC-27 sidebar reachability
test('AC-27 every sidebar nav item is reachable at 1280x720', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await signInAdmin(page);
  await page.goto('/admin/concerts/1/overview');
  const links = page.locator('[data-slot=sidebar] a');
  const count = await links.count();
  expect(count).toBeGreaterThan(10);
  const unreachable: string[] = [];
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    const label = (await link.innerText()).trim();
    if (!box) { unreachable.push(`${label} (no box)`); continue; }
    const hit = await page.evaluate(
      ([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('a')?.textContent?.trim() ?? null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    if (hit === null) unreachable.push(`${label} (nothing at its centre)`);
  }
  await shot(page, 'AC-27-sidebar-1280x720');
  expect(unreachable, unreachable.join('; ')).toEqual([]);
});

// ---------------------------------------------- AC-30 separate layouts
test('AC-30 the scanner does not inherit the admin chrome', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/concerts');
  expect(await page.locator('[data-slot=sidebar]').count()).toBeGreaterThan(0);
  await page.goto('/scan');
  expect(await page.locator('[data-slot=sidebar]').count()).toBe(0);
  await shot(page, 'AC-30-scanner-no-admin-chrome');
});
