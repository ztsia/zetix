import { test, expect } from '@playwright/test';

// Run against a dev server started WITHOUT SHOWCASE (spec/v3.md 31). FLOW-1, AC-1, AC-4.
const SHOTS = 'qa-artifacts/claude-X-publication/screens';

test('FLOW-1 flag unset: / is the placeholder, every showcase path is a 404', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Zetix');
  await expect(page.getByText('this surface is not public')).toBeVisible();
  expect(await page.locator('video').count()).toBe(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-1-placeholder.png` });

  for (const [i, path] of ['/showcase', '/showcase/phone/ticket', '/showcase/phone/after'].entries()) {
    const res = await page.goto(path);
    expect(res!.status()).toBe(404);
    await expect(page.getByText('could not be found')).toBeVisible();
    if (i === 0) await page.screenshot({ path: `${SHOTS}/FLOW-1-step-2-showcase-404.png` });
    if (i === 1) await page.screenshot({ path: `${SHOTS}/FLOW-1-step-3-phone-404.png` });
  }
});
