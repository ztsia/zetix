import { test, expect } from '@playwright/test';
const S = 'qa-artifacts/claude-X-publication/screens';
const SET = process.env.QA_DEMO === 'set';

test(`FLOW-10 demo sign-ins (${SET ? 'set' : 'unset'})`, async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open the demo' }).first().click();
  const dlg = page.locator('dialog[open]');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText('visitor@example.org')).toBeVisible();
  if (SET) {
    await expect(dlg.locator('code', { hasText: '<b>pw&"x</b>' })).toBeVisible();
    expect(await dlg.locator('b', { hasText: /^x$/ }).count()).toBe(0);
    await expect(dlg.getByText('with the code')).toBeVisible();
    expect(await page.locator('aside.zx-usher').count()).toBe(1);
    await page.screenshot({ path: `${S}/FLOW-10-step-2-set.png` });
  } else {
    await expect(dlg.getByRole('link', { name: 'In the README' })).toHaveAttribute('href', /ztsia\/zetix#try-it$/);
    expect(await dlg.getByText('with the code').count()).toBe(0);
    expect(await page.locator('aside.zx-usher').count()).toBe(0);
    await page.screenshot({ path: `${S}/FLOW-10-step-1-unset.png` });
  }
  await dlg.getByRole('link', { name: 'Continue to sign-in' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
