import type { Page } from '@playwright/test';

export const SHOTS = 'qa-artifacts/claude-S-audience-workspace-rs/screens';
export const DB = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}
