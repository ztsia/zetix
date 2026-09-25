import { test, expect, type Page } from '@playwright/test';

/**
 * Module R — FLOW-17 (re-verification of 4d57f23): a VIEWER opening the ticket
 * designer on a show with issued tickets is offered the sample attendee only,
 * and no real token reaches the browser. An ADMIN still previews a real one.
 * (Seed: the first attendee of show 1 holds QRSECRET00000000000001.)
 */
async function signIn(page: Page, email: string, password: string, ip: string) {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': ip });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
}

test('FLOW-17 viewer gets the sample attendee only in the ticket designer', async ({ page }) => {
  await signIn(page, 'mei@example.test', 'qa-viewer-pass', '198.51.100.249');
  await expect(page.getByText('Read-only access.')).toBeVisible();
  const res = await page.goto('/admin/concerts/1/tickets/templates/2?show=1');
  expect(res?.status()).toBe(200);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Classic Landscape').first()).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain('QRSECRET');
  await expect(page.getByText('A real attendee')).toHaveCount(0);
  await expect(page.getByText('Sample data').first()).toBeVisible(); // the only preview subject offered
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-17-step-1-viewer-designer-sample-only.png', fullPage: true });
});

test('FLOW-17 twin: an admin still previews a real attendee', async ({ page }) => {
  await signIn(page, 'committee@example.test', 'qa-admin-pass', '198.51.100.248');
  await page.goto('/admin/concerts/1/tickets/templates/2?show=1');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('A real attendee').first()).toBeVisible();
  expect(await page.content()).toContain('QRSECRET00000000000001');
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-17-step-2-admin-designer-real-attendee.png', fullPage: true });
});
