import { test, expect } from '@playwright/test';

/**
 * Module R re-verification — the residual Trash oracle (finding 11): a
 * message's label is its subject, which can quote an address. A viewer's search
 * of deleted messages now matches by id only, so a full guess finds nothing.
 * Seed (ad hoc): a deleted outbox row with subject 'Re: daniel.subject@example.test'.
 */
test('viewer: trashed message subject is masked on screen and not searchable', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.204' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await page.goto('/admin/concerts/1/trash?kind=message');
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('daniel.subject@example.test');
  expect(text).toMatch(/Re: d•••@e•••\.test/);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-14-step-4-trash-message-subject-masked.png', fullPage: true });
  await page.goto('/admin/concerts/1/trash?kind=message&q=daniel.subject%40example.test');
  await expect(page.getByText(/Re: d•••@e•••\.test/)).toHaveCount(0);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-14-step-5-trash-message-full-guess-misses.png', fullPage: true });
  await page.goto('/admin/concerts/1/trash?kind=message&q=daniel.subject%40example.tesx');
  await expect(page.getByText(/Re: d•••@e•••\.test/)).toHaveCount(0);
  await page.screenshot({ path: 'qa-artifacts/claude-R-roles-accounts/screens/FLOW-14-step-6-trash-message-wrong-guess-misses.png', fullPage: true });
});
