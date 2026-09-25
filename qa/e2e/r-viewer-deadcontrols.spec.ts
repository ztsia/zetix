import { test, expect } from '@playwright/test';

/** Module R — mutating controls a VIEWER can still operate (AC-17). */
test('viewer: designer uploads hidden; form builder still editable locally (deferred to W)', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.253' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);

  await page.goto('/admin/concerts/1/tickets/templates/2');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Classic Landscape').first()).toBeVisible();
  // Re-verified after 4d57f23: uploads are hidden from a viewer.
  await expect(page.getByRole('button', { name: /^(Upload|Replace)$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Image' })).toHaveCount(0);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-5-step-4-viewer-designer-no-upload.png', fullPage: true });

  await page.goto('/admin/concerts/1/forms/1');
  await expect(page.getByRole('button', { name: 'Add question' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-5-step-5-viewer-form-builder.png', fullPage: true });
});
