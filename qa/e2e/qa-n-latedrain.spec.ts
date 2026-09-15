import { expect, test } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const SHOTS = 'qa-artifacts/claude-N-portal/screens';

test.afterAll(async () => { await sql.end(); });

/**
 * v2.md §13.5.1: "The recipient list is computed at send time, not at completion
 * time ... a list frozen two hours after the show would silently omit everyone
 * on that device. Nobody would ever find out."
 *
 * Absent Friend is in the same party as two guests who were scanned live. Their
 * usher's phone drains the next morning.
 */
test('FINDING-1 a late-drained seat in an already-queued party never gets a link', async ({ page }) => {
  // The first batch has been delivered.
  await sql`update email_outbox set status = 'SENT', sent_at = now()
             where template_key = 'feedback_request' and id = 1`;
  const [before] = await sql`
    select body_md like '%NoShowCCCCCCCCCCCCCC3x%' as has_link from email_outbox where id = 1`;
  expect(before.has_link).toBe(false);

  // Absent Friend does have a live check_ins row by now.
  const [ci] = await sql`
    select count(*)::int as n from check_ins k join attendees a on a.id = k.attendee_id
     where a.qr_token = 'NoShowCCCCCCCCCCCCCC3x' and k.reverted_at is null`;
  expect(ci.n).toBe(1);

  await page.goto('/login');
  await page.fill('#code', 'qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
  await page.goto('/admin/concerts/1/shows');
  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Evening Concert' }).first();
  await card.getByRole('button', { name: /generate feedback emails/i }).click();
  await page.waitForTimeout(2500);
  console.log('admin message:', await card.innerText());
  await page.screenshot({ path: `${SHOTS}/FINDING-1-step-1-generate-after-late-drain.png`, fullPage: true });

  const rows = await sql`
    select o.id, o.status, o.body_md like '%NoShowCCCCCCCCCCCCCC3x%' as has_link
      from email_outbox o join registrations r on r.id = o.registration_id
     where r.show_id = 1 and o.template_key = 'feedback_request'`;
  console.log('outbox for show 1 after Generate:', JSON.stringify(rows));
  // The spec requires this person to be reached. They are not.
  expect(rows.some((r) => r.has_link)).toBe(true);
});
