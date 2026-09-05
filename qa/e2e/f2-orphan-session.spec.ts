import { test, expect } from '@playwright/test';

/**
 * A Supabase Auth user with no `app_users` row — the state an operator is in
 * between "created in Auth" and "provisioned", and the state a leaked account
 * would be in. Authentication succeeds; authorisation must not.
 */
const SHOTS = 'qa-artifacts/F2-app-shell-auth/screens';

test('an authenticated user with no app_users row reaches nothing', async ({ page }) => {
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill('Ghost');
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.status() < 400),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await expect(page.locator('#scan-login-error')).toContainText('That code was not recognised.');
  await page.screenshot({ path: `${SHOTS}/AC-orphan-1-login-refused.png`, fullPage: true });

  // and even if a session cookie existed, the surfaces refuse
  const scan = await page.goto('/scan');
  expect(page.url()).toContain('/scan/login');
  expect(scan?.status()).toBeLessThan(400);
  const admin = await page.goto('/admin');
  expect(page.url()).toContain('/login');
  expect(admin?.status()).toBeLessThan(400);
  const body = await page.content();
  expect(body).not.toContain('Evening Show');
  await page.screenshot({ path: `${SHOTS}/AC-orphan-2-no-surface.png`, fullPage: true });
});
