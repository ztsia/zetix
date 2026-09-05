import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/** FLOW-10 / FLOW-11 — the one shared DataTable, on its only consumer today. */
const SHOTS = 'qa-artifacts/F2-app-shell-auth/screens';
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

async function loginAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

const firstCell = (page: Page) => page.locator('tbody tr').first().locator('td').first();

test('FLOW-10: sort, filter, paginate, hide a column, export', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAdmin(page);
  await page.goto('/admin/concerts');
  await expect(page.getByRole('heading', { name: 'Concerts' })).toBeVisible();

  const total = (await sql`select count(*)::int as c from concerts where deleted_at is null`)[0].c;

  // rows visible = page size 25, count label reflects the whole filtered set
  await expect(page.locator('tbody tr')).toHaveCount(25);
  await expect(page.getByText(`${total} rows`)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-1-initial.png`, fullPage: true });

  // --- sort ---
  const before = await firstCell(page).innerText();
  await page.getByRole('button', { name: /^Name/ }).click();
  await page.getByRole('menuitem', { name: 'Descending' }).click();
  await expect(firstCell(page)).not.toHaveText(before);
  const desc = await firstCell(page).innerText();
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-2-sorted-desc.png`, fullPage: true });

  await page.getByRole('button', { name: /^Name/ }).click();
  await page.getByRole('menuitem', { name: 'Ascending' }).click();
  await expect(firstCell(page)).not.toHaveText(desc);
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-3-sorted-asc.png`, fullPage: true });

  // --- pagination ---
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  const page1First = await firstCell(page).innerText();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  expect(await firstCell(page).innerText()).not.toBe(page1First);
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-4-page-2.png`, fullPage: true });
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();

  // --- filter ---
  await page.getByLabel('Search concerts…').fill('Matinee-nothing-matches-xyz');
  await expect(page.getByText('No matches')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-1-no-matches.png`, fullPage: true });

  await page.getByLabel('Search concerts…').fill('QA Season');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('1 row', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-5-filtered.png`, fullPage: true });
  await page.getByLabel('Search concerts…').fill('');

  // --- column visibility ---
  const headers = page.locator('thead th');
  await expect(headers).toHaveCount(5);
  await expect(headers.filter({ hasText: 'Season' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Season' }).click();
  await page.keyboard.press('Escape');
  await expect(headers).toHaveCount(4);
  await expect(headers.filter({ hasText: 'Season' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-6-column-hidden.png`, fullPage: true });
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Season' }).click();
  await page.keyboard.press('Escape');
});

test('FLOW-10b: CSV export matches the filtered view and neutralises formulas', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/admin/concerts');
  await page.getByLabel('Search concerts…').fill('HYPERLINK');
  await expect(page.locator('tbody tr')).toHaveCount(1);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: 'Export' }).click();
      await page.getByRole('menuitem', { name: 'CSV' }).click();
    })(),
  ]);
  const path = await download.path();
  const body = await (await import('node:fs/promises')).readFile(path!, 'utf8');
  console.log('CSV EXPORT:\n' + body);

  expect(download.suggestedFilename()).toMatch(/^concerts-\d{4}-\d{2}-\d{2}\.csv$/);
  // one header row + exactly the one filtered row
  expect(body.trim().split('\r\n')).toHaveLength(2);
  // formula neutralised
  expect(body).toContain(`"'=HYPERLINK(""http://evil.example"",""click me"")"`);
  expect(body).not.toMatch(/\n=HYPERLINK/);
  // BOM present for Excel
  expect(body.charCodeAt(0)).toBe(0xfeff);
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-7-export.png`, fullPage: true });
});

test('FLOW-10c: XLSX export goes through the server route and downloads', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/admin/concerts');
  await page.getByLabel('Search concerts…').fill('QA Season');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: 'Export' }).click();
      await page.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click();
    })(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^concerts-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const buf = await (await import('node:fs/promises')).readFile((await download.path())!);
  // a real zip container, not an error page
  expect(buf.subarray(0, 2).toString()).toBe('PK');
  expect(buf.length).toBeGreaterThan(1000);
});

test('FLOW-13: a rendered timestamp does not move with the viewer timezone', async ({ browser }) => {
  const shots: string[] = [];
  const seen: string[] = [];
  for (const [i, tz] of ['UTC', 'Pacific/Kiritimati'].entries()) {
    const ctx = await browser.newContext({ timezoneId: tz });
    const page = await ctx.newPage();
    await loginAdmin(page);
    await page.goto('/admin/concerts');
    await page.getByLabel('Search concerts…').fill('QA Season');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    seen.push(await page.locator('tbody tr').first().innerText());
    const p = `${SHOTS}/FLOW-13-step-${i + 1}-tz-${tz.replace('/', '-')}.png`;
    await page.screenshot({ path: p, fullPage: true });
    shots.push(p);

    // and the server-rendered export of a real instant
    const res = await page.request.post('/api/export/xlsx', {
      data: { filename: 'tz', headers: ['When'], rows: [[{ date: '2026-09-19T11:30:00.000Z' }]], timeZone: 'Asia/Singapore' },
    });
    expect(res.status()).toBe(200);
    await ctx.close();
  }
  expect(seen[0]).toBe(seen[1]);
  console.log('row rendered identically in both zones:', JSON.stringify(seen[0]));
});
