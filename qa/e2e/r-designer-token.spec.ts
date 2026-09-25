import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * Module R — the ticket designer previews against a real attendee. Does a
 * VIEWER receive that attendee's qr_token (spec/v3.md §28: "A viewer holds no
 * access token")? The default show in the sweep had no issued seats, so this
 * asks for the show that does.
 */
test('viewer opens the ticket designer against a show with issued tickets', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.254' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  const res = await page.request.get('/admin/concerts/1/tickets/templates/2?show=1');
  const body = await res.text();
  const tokens = [...new Set(body.match(/QRSECRET\d+/g) ?? [])];
  const links = [...new Set(body.match(/\/t\/[A-Za-z0-9_-]{8,}/g) ?? [])];
  const emails = [...new Set(body.match(/[A-Za-z0-9._%+-]+@example\.test/g) ?? [])];
  const around = body.indexOf('QRSECRET');
  writeFileSync('qa-artifacts/claude-R-roles-accounts/designer-token.txt',
    `status ${res.status()}\ntokens ${JSON.stringify(tokens)}\nlinks ${JSON.stringify(links)}\nemails ${JSON.stringify(emails)}\ncontext: ${around >= 0 ? body.slice(around - 300, around + 120) : '-'}\n`);
  console.log(res.status(), tokens, links, emails);
  await page.goto('/admin/concerts/1/tickets/templates/2?show=1');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-4-step-11-designer-real-attendee.png', fullPage: true });
  expect(tokens).toEqual([]);
  expect(links).toEqual([]);
});
