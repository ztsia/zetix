import { test, expect } from '@playwright/test';

/** Module R — a command report opened by a VIEWER (readRunAction) is masked in the wire response. */
test('viewer opens a run report; the readRunAction response carries no full contact or token', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.250' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await page.goto('/admin/concerts/1/activity?tab=runs');
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && r.request().headers()['next-action']) bodies.push(await r.text().catch(() => ''));
  });
  await page.getByText('registration.cancel').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-16-step-1-viewer-run-report.png', fullPage: true });
  const wire = bodies.join('\n');
  console.log('readRunAction wire:', wire.slice(0, 600));
  expect(bodies.length).toBeGreaterThan(0);
  expect(wire).not.toMatch(/[A-Za-z0-9._%+-]+@example\.test/);
  expect(wire).not.toContain('QRSECRET');
  expect(wire).not.toMatch(/\+60 12-555 0005/);
});
