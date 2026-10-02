import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import postgres from 'postgres';

/**
 * Module `Y` — tables act on the whole set, never the page (spec/v3.md §32.1).
 *
 * Runs against the `start-v.sh` world: concert 1 holds 11 parties and 24 seats,
 * so a page size of 10 leaves rows on a second page — which is the only shape
 * in which "page-only" and "whole set" give different answers.
 */
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
test.afterAll(async () => {
  await sql.end();
});

async function signInAdmin(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('committee@example.test');
  await page.locator('input[name="password"]').fill('qa-admin-pass');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function exportCsv(page: Page): Promise<{ label: string; lines: string[] }> {
  await page.getByRole('button', { name: /Export/i }).click();
  const label = (await page.getByRole('menu').getByText(/^Export /).innerText()).trim();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'CSV' }).click(),
  ]);
  const csv = fs.readFileSync((await download.path())!, 'utf8');
  return { label, lines: csv.trim().split('\r\n') };
}

const selectedFooter = (page: Page) => page.getByText(/^\d+ of \d+ rows? selected$/);

test('Audience seats: export, footer and Actions agree after "Select all N matching"', async ({ page }) => {
  const [{ n: seats }] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees a join shows s on s.id = a.show_id
     where s.concert_id = 1 and a.deleted_at is null
       and exists (select 1 from registrations r where r.id = a.registration_id and r.deleted_at is null)
  `;
  expect(seats).toBeGreaterThan(10);

  await signInAdmin(page);
  await page.goto('/admin/concerts/1/audience?grain=seats&size=10');
  await expect(page.locator('table tbody tr')).toHaveCount(10);
  await page.waitForLoadState('networkidle');

  // Nothing ticked: the whole filter, not the ten on screen.
  const all = await exportCsv(page);
  expect(all.label).toBe(`Export all ${seats} matching`);
  expect(all.lines.length - 1).toBe(seats);

  // Tick the page, then select every match, then untick one row.
  await page.getByRole('checkbox', { name: /select all/i }).first().click();
  await page.getByRole('button', { name: new RegExp(`Select all ${seats}`) }).click();
  await expect(selectedFooter(page)).toHaveText(`${seats} of ${seats} rows selected`);
  await page.locator('table tbody tr').first().getByRole('checkbox').click();
  await expect(selectedFooter(page)).toHaveText(`${seats - 1} of ${seats} rows selected`);

  const minusOne = await exportCsv(page);
  expect(minusOne.label).toBe(`Export all ${seats - 1} matching`);
  expect(minusOne.lines.length - 1).toBe(seats - 1);
});

test('Audience parties: ticked rows on two pages export together, and only they', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/concerts/1/audience?size=10');
  // A tick before hydration is a click on static markup.
  await page.waitForLoadState('networkidle');
  await page.locator('table tbody tr').first().getByRole('checkbox').click();
  await page.getByRole('button', { name: /next page/i }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.locator('table tbody tr').first().getByRole('checkbox').click();
  await expect(selectedFooter(page)).toHaveText(/^2 of \d+ rows selected$/);

  const ticked = await exportCsv(page);
  expect(ticked.label).toBe('Export the 2 ticked');
  expect(ticked.lines.length - 1).toBe(2);
});

test('The concerts list carries no export and no selection', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/concerts');
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Export/i })).toHaveCount(0);
  await expect(page.locator('table tbody tr').first().getByRole('checkbox')).toHaveCount(0);
});

test('Messages and Activity export; form responses keep one export', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/concerts/1/audience/messages');
  await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
  await page.goto('/admin/concerts/1/activity');
  await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
});
