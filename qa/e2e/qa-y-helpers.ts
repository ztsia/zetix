import type { Browser, BrowserContext, Page } from '@playwright/test';
import postgres from 'postgres';

export const QA_DB = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
export const sql = postgres(QA_DB, { prepare: false, max: 2 });

export const SHOTS = 'qa-artifacts/claude-Y-surface-fixes/screens';

export async function adminLogin(page: Page, email = 'committee@example.test', password = 'qa-admin-pass') {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

export async function operatorLogin(page: Page, name: string, code: string) {
  await page.goto('/scan/login');
  await page.locator('input[name="displayName"]').fill(name);
  await page.locator('input[name="code"]').fill(code);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 60_000 });
}

export type Who = 'anon' | 'admin' | 'viewer' | 'wei' | 'bob';

export async function contextFor(browser: Browser, who: Who): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  if (who === 'anon') return ctx;
  const page = await ctx.newPage();
  if (who === 'admin') await adminLogin(page);
  if (who === 'viewer') await adminLogin(page, 'mei@example.test', 'qa-viewer-pass');
  if (who === 'wei') await operatorLogin(page, 'Wei Ling', 'qa-op-code');
  if (who === 'bob') await operatorLogin(page, 'Bob', 'qa-op-code-2');
  await page.close();
  return ctx;
}
