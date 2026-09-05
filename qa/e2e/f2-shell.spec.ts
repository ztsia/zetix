import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/** FLOW-1 steps 4-5 — the admin shell: sidebar, concert context, breadcrumb. */
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

test('FLOW-1 step 4-5: sidebar holds the concert context and the breadcrumb follows', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/admin/concerts');

  // outside a concert: no per-concert nav at all
  await expect(page.getByText('No concert selected')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Registrations', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-4-shell-no-concert.png`, fullPage: true });

  const [{ id }] = await sql`select id from concerts where slug = 'qa-opener'`;
  await page.goto(`/admin/concerts/${id}/registrations`);

  // inside a concert: the switcher shows it and every §14.1 screen is in the nav
  await expect(page.getByText('QA Season Opener')).toBeVisible();
  for (const label of ['Overview', 'Shows', 'Players', 'Forms', 'Registrations',
                       'Extras review', 'Import', 'Tickets', 'Email', 'Check-in',
                       'Operators', 'Portal', 'Notes', 'Exports']) {
    await expect.soft(page.getByRole('link', { name: label, exact: true }).first(), label).toBeVisible();
  }
  // breadcrumb reflects where we are
  await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText('Registrations');
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-5-shell-in-concert.png`, fullPage: true });

  // the concert switcher moves between concerts
  await page.getByRole('button', { name: /QA Season Opener/ }).first().click();
  await page.getByRole('menuitem', { name: /Concert 01/ }).click();
  await page.waitForURL(/\/admin\/concerts\/\d+/);
  await expect(page.getByText('Concert 01')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-6-concert-switched.png`, fullPage: true });
});

test('AC-25: a nonexistent or hostile concert id does not crash the shell', async ({ page }) => {
  await loginAdmin(page);
  for (const id of ['999999', 'abc', '..%2F..%2Fetc%2Fpasswd', "1'%20OR%201=1"]) {
    const res = await page.goto(`/admin/concerts/${id}/registrations`);
    const body = await page.content();
    expect.soft(res?.status(), id).toBeLessThan(500);
    expect.soft(body, id).not.toMatch(/Unhandled Runtime Error|at Object\.<anonymous>/);
  }
  await page.screenshot({ path: `${SHOTS}/AC-25-bad-concert-id.png`, fullPage: true });
  const [{ c }] = await sql`select count(*)::int as c from concerts`;
  expect(c).toBe(32);
});

test('AC-24: the admin shell is usable at a phone viewport (degrades, does not break)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await loginAdmin(page);
  await page.goto('/admin/concerts');
  await expect(page.getByRole('heading', { name: 'Concerts' })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/AC-24-admin-mobile.png`, fullPage: true });
  await ctx.close();
});
