import { test, expect } from '@playwright/test';

/** Module R — People's "Last sign-in" renders in the concert zone, not the viewer's (CLAUDE.md). */
test('People last sign-in does not move with the browser timezone', async ({ browser }) => {
  const texts: string[] = [];
  for (const [i, tz] of ['America/New_York', 'Asia/Tokyo'].entries()) {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', timezoneId: tz, extraHTTPHeaders: { 'x-real-ip': `198.51.100.23${i}` } });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.locator('input[name="email"]').fill('committee@example.test');
    await page.locator('input[name="password"]').fill('qa-admin-pass');
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.goto('/admin/settings/people');
    const row = page.getByRole('row').filter({ hasText: 'Mei Viewer' });
    await expect(row).toBeVisible();
    texts.push(await row.innerText());
    await page.screenshot({ path: `qa-artifacts/claude-R-roles-accounts/screens/FLOW-15-step-${i + 1}-people-tz-${tz.replace('/', '-')}.png`, fullPage: true });
    await ctx.close();
  }
  console.log(texts);
  expect(texts[0]).toBe(texts[1]);
});
