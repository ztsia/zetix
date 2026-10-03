import { test } from '@playwright/test';
import { adminLogin } from './qa-y-helpers';
test.use({ viewport: { width: 1440, height: 1000 } });
test('explore', async ({ page }) => {
  test.setTimeout(180000);
  await adminLogin(page);
  await page.goto('/admin/concerts/1/audience'); await page.waitForLoadState('networkidle');
  const cb = page.getByRole('checkbox', { name: 'Select all rows on this page' });
  console.log('outer', await cb.evaluate((e) => e.outerHTML.slice(0, 400)));
  await cb.click();
  await page.waitForTimeout(1000);
  console.log('after', await cb.getAttribute('aria-checked'), await cb.getAttribute('data-checked'));
  console.log(await page.getByRole('status').allInnerTexts());
  await page.goto('/admin/concerts/1/audience/messages'); await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: /Bounced/ }).click();
  await page.waitForTimeout(2000);
  console.log((await page.locator('main').innerText()).slice(-600));
});
