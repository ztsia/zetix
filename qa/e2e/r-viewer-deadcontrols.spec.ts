import { test, expect } from '@playwright/test';

/** Module R — mutating controls a VIEWER can still operate (AC-17). */
test('viewer: ticket designer Upload and form builder controls are live', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.253' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);

  await page.goto('/admin/concerts/1/tickets/templates/2');
  await page.waitForLoadState('networkidle');
  const upload = page.getByRole('button', { name: /Upload|Replace/ }).first();
  await expect(upload).toBeVisible();
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
  const statuses: number[] = [];
  page.on('response', (r) => { if (r.url().endsWith('/api/ticket-assets') && r.request().method() === 'POST') statuses.push(r.status()); });
  const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await upload.click();
  const fc = await chooser;
  if (fc) await fc.setFiles({ name: 'bg.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-5-step-4-viewer-designer-upload.png', fullPage: true });
  console.log('upload statuses', statuses, 'chooser opened', !!fc);

  await page.goto('/admin/concerts/1/forms/1');
  await expect(page.getByRole('button', { name: 'Add question' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-5-step-5-viewer-form-builder.png', fullPage: true });
});
