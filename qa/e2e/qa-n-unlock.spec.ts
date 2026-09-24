import { expect, test } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const SHOTS = 'qa-artifacts/claude-N-portal/screens';
test.afterAll(async () => { await sql.end(); });

test('AC-61 the OPEN_TO_ALL fallback is one control on the Shows screen', async ({ page, context }) => {
  await page.goto('/login');
  await page.fill('#code', 'qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
  await page.goto('/admin/concerts/1/shows');

  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Open-ended Gala' }).first();
  await card.getByRole('button', { name: 'Edit show' }).click();
  await page.getByLabel('Portal unlock').selectOption('OPEN_TO_ALL');
  await page.screenshot({ path: `${SHOTS}/AC-61-step-1-unlock-control.png`, fullPage: true });
  await page.getByRole('button', { name: /save|update/i }).last().click();
  await page.waitForTimeout(2000);

  const [show] = await sql`select portal_unlock_mode from shows where id = 3`;
  expect(show.portal_unlock_mode).toBe('OPEN_TO_ALL');

  // A ticket holder on that show who was never scanned now sees the sections.
  const guest = await context.newPage();
  await guest.setViewportSize({ width: 390, height: 844 });
  await sql`update check_ins set reverted_at = now() where show_id = 3`;
  await guest.goto('/t/NoEndTimeHHHHHHHHHH8xx');
  await expect(guest.getByText('Concert Programme')).toBeVisible();
  await guest.screenshot({ path: `${SHOTS}/AC-61-step-2-open-to-all-guest.png`, fullPage: true });
  await sql`update check_ins set reverted_at = null where show_id = 3`;
  await sql`update shows set portal_unlock_mode = null where id = 3`;
});
