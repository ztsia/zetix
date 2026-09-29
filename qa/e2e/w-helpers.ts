import { expect, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import postgres from 'postgres';

export const OUT = 'qa-artifacts/claude-W-home-setup-theme';
export const SHOTS = `${OUT}/screens`;
export const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});

export async function signIn(page: Page, who: 'admin' | 'viewer') {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(who === 'admin' ? 'committee@example.test' : 'mei@example.test');
  await page.locator('input[name="password"]').fill(who === 'admin' ? 'qa-admin-pass' : 'qa-viewer-pass');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.locator('button[type="submit"]').click(),
  ]);
}

export async function newPage(browser: Browser, who: 'admin' | 'viewer' | 'anon', opts: BrowserContextOptions = {}) {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', viewport: { width: 1440, height: 1000 }, ...opts });
  const page = await ctx.newPage();
  if (who !== 'anon') await signIn(page, who);
  return { ctx, page };
}

export async function shot(page: Page, name: string, full = true) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
}

/** The live <html> theme state and a few resolved tokens. */
export async function themeProbe(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    return {
      theme: root.getAttribute('data-theme'),
      dark: root.classList.contains('dark'),
      primary: cs.getPropertyValue('--primary').trim(),
      background: cs.getPropertyValue('--background').trim(),
      destructive: cs.getPropertyValue('--destructive').trim(),
      radius: cs.getPropertyValue('--radius').trim(),
      formAccent: cs.getPropertyValue('--form-accent').trim(),
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });
}

export async function openAppearance(page: Page) {
  await page.getByRole('button', { name: /Appearance/ }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Default' })).toBeVisible();
}
