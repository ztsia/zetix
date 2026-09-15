import { expect, test } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const SHOTS = 'qa-artifacts/claude-N-portal/screens';
const SECOND = 'AdmittedTwoBBBBBBBBB2x';

test.use({ viewport: { width: 390, height: 844 } });
test.afterAll(async () => { await sql.end(); });

test('FLOW-11 an incomplete form is refused inline, and writes nothing', async ({ page }) => {
  const before = (await sql`select count(*)::int as n from feedback_responses`)[0].n;
  await page.goto(`/t/${SECOND}`);
  await page.getByRole('button', { name: /send feedback/i }).click();
  await expect(page.getByText('This is required.').first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-1-validation-error.png`, fullPage: true });
  const after = (await sql`select count(*)::int as n from feedback_responses`)[0].n;
  expect(after).toBe(before);
});

test('FLOW-11b hostile input is stored safely or refused, never a 500', async ({ page }) => {
  const long = 'A'.repeat(32_000);
  const nasty = `'); drop table attendees; -- ../../etc/passwd <img src=x onerror=alert(1)>`;
  await page.goto(`/t/${SECOND}`);
  await page.selectOption('#feedback\\.rating', 'good');
  await page.fill('#feedback\\.highlight', long + nasty);
  const errors: string[] = [];
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  await page.getByRole('button', { name: /send feedback|change my answer/i }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-2-hostile-input.png`, fullPage: true });
  expect(errors).toEqual([]);
  const rows = await sql`select count(*)::int as n from attendees`;
  expect(rows[0].n).toBeGreaterThan(0);
  // no script executed / reflected: the page text never contains the raw tag
  expect(await page.content()).not.toContain('onerror=alert(1)>');
});

test('FLOW-11c a submit that arrives after the form closes is refused', async ({ page }) => {
  await sql`delete from feedback_responses where attendee_id in (select id from attendees where qr_token = ${SECOND})`;
  await page.goto(`/t/${SECOND}`);
  await page.selectOption('#feedback\\.rating', 'fine');
  await page.fill('#feedback\\.highlight', 'Answered just as the door shut.');
  await sql`
    insert into system_settings (key, value)
    values ('portal.feedback_close_at', to_jsonb('2026-09-14T00:00:00Z'::text))
    on conflict (key) do update set value = excluded.value`;
  await page.getByRole('button', { name: /send feedback/i }).click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-3-closed-refusal.png`, fullPage: true });
  const rows = await sql`
    select count(*)::int as n from feedback_responses fr
      join attendees a on a.id = fr.attendee_id where a.qr_token = ${SECOND}`;
  expect(rows[0].n).toBe(0);
  await sql`delete from system_settings where key = 'portal.feedback_close_at'`;
});

test('FLOW-14 marking a show COMPLETED by hand queues its feedback email', async ({ page }) => {
  // Somebody was admitted to the Matinee.
  const [att] = await sql`select id from attendees where qr_token = 'UpcomingGGGGGGGGGGG7xx'`;
  await sql`
    insert into check_ins (attendee_id, show_id, scanned_at, source)
    values (${att.id}, 2, now(), 'MANUAL')`;

  await page.goto('/login');
  await page.fill('#code', 'qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
  await page.goto('/admin/concerts/1/shows');
  await page.screenshot({ path: `${SHOTS}/FLOW-14-step-1-shows.png`, fullPage: true });

  const before = (await sql`
    select count(*)::int as n from email_outbox o join registrations r on r.id = o.registration_id
     where r.show_id = 2 and o.template_key = 'feedback_request'`)[0].n;
  expect(before).toBe(0);

  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Matinee' }).first();
  await card.getByRole('button', { name: 'Edit show' }).first().click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/FLOW-14-step-2-dialog.png`, fullPage: true });
  await page.getByLabel('Status').selectOption('COMPLETED');
  await page.getByRole('button', { name: /save|update/i }).last().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/FLOW-14-step-3-completed.png`, fullPage: true });

  const rows = await sql`
    select o.status, o.scheduled_for, o.body_md from email_outbox o
      join registrations r on r.id = o.registration_id
     where r.show_id = 2 and o.template_key = 'feedback_request'`;
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('QUEUED');
  expect(rows[0].body_md).toContain('UpcomingGGGGGGGGGGG7xx');
  const [show] = await sql`select status, portal_unlock_mode from shows where id = 2`;
  expect(show.status).toBe('COMPLETED');
  // decision 39: completion never touches unlock mode
  expect(show.portal_unlock_mode).toBeNull();
});
