import { execFileSync } from 'node:child_process';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import postgres from 'postgres';

export const QA_URL =
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';

export const sql = postgres(QA_URL, { prepare: false, max: 2 });

export const SHOTS = 'qa-artifacts/B-registrations-extras/screens';

/** Re-run module B's seed so every test starts from the same fixture. */
export function reseed(): Record<string, string> {
  const out = execFileSync('node', ['qa/support/seed-b.mjs'], {
    env: { ...process.env, QA_DATABASE_URL: QA_URL, QA_ADMIN_EMAIL: 'committee@example.test' },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

export async function asAdmin(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

export async function asOperator(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

export const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
