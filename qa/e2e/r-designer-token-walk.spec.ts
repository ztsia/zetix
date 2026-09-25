import { test, expect } from '@playwright/test';

/**
 * Module R — FLOW-17: a VIEWER opens the ticket designer, the QR on the canvas
 * is a real attendee's, and the token it carries opens that attendee's ticket
 * page. (Seed: the first attendee of show 1 holds QRSECRET00000000000001.)
 */
test('FLOW-17 viewer takes a real attendee token from the ticket designer', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.249' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await expect(page.getByText('Read-only access.')).toBeVisible();

  await page.goto('/admin/concerts/1/tickets/templates/2?show=1');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('A real attendee')).toBeVisible();
  const html = await page.content();
  const inDom = html.includes('QRSECRET00000000000001');
  const flight = await page.evaluate(() => JSON.stringify((self as unknown as { __next_f?: unknown[] }).__next_f ?? []).includes('QRSECRET00000000000001'));
  console.log('token in DOM html:', inDom, '| token in RSC flight data held by the browser:', flight);
  expect(flight || inDom).toBe(true);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-17-step-1-viewer-designer-real-qr.png', fullPage: true });

  const res = await page.goto('/t/QRSECRET00000000000001');
  console.log('ticket page status:', res?.status());
  await expect(page.getByText('Player 1').first()).toBeVisible();
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-17-step-2-ticket-page-opened-with-token.png', fullPage: true });
});
