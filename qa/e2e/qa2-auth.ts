import type { Page } from '@playwright/test';

/** QA re-run helpers: sign in through the real forms against the GoTrue stub. */
export async function loginAdmin(page: Page) {
  await page.goto('/login');
  await page.fill('#code', 'qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
}

export async function loginOperator(page: Page, displayName = 'Wei Ling') {
  await page.goto('/scan/login');
  await page.fill('input[name="displayName"]', displayName);
  await page.fill('input[name="code"]', 'qa-op-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/scan/);
}

export const SEED = {
  concertId: 1,
  show1: 1,
  show2: 2,
  longestName: 'Wilhelmina Aurelia Constance Featherstonehaugh-Villanueva',
};
