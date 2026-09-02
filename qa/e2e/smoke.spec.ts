import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Proves the QA harness itself works: browser launches, the dev server comes up
// against the QA database, and screenshots land where the report expects them.
// It is not a test of the product — modules replace this with their own flows.

const SHOTS = 'qa-artifacts/harness/screens';
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test('the app renders in a real browser', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await page.screenshot({ path: `${SHOTS}/smoke-step-1-home.png`, fullPage: true });
});

test('the dev server is talking to a database', async ({ request }) => {
  // A 200 here proves Postgres answered, not merely that Next.js is up.
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(Date.parse(body.db)).not.toBeNaN();
});
