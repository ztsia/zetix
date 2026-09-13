import { test, expect, type Page } from '@playwright/test';
import { asAdmin, SEEDED_IDS, newSql, shot } from './b-helpers';

test.describe.configure({ mode: 'serial' });

const sql = newSql();
test.setTimeout(120_000);

let ids: Record<string, string>;
let page: Page;
let cancelScreenText = '';

test.beforeAll(async ({ browser }) => {
  ids = SEEDED_IDS;
  const ctx = await asAdmin(browser);
  page = await ctx.newPage();
});
test.afterAll(async () => {
  await sql.end();
});

const regs = () => `/admin/concerts/${ids.concertId}/registrations`;

async function openParty(name: string) {
  await page.goto(regs());
  await page.locator('tr', { hasText: name }).first().click();
  await expect(page.getByRole('dialog').getByText(name).first()).toBeVisible();
}

/** FLOW-1 — manual registration against a segment whose form window is closed. */
test('FLOW-1 manual registration bypasses the form window', async () => {
  await page.goto(regs());
  await shot(page, 'FLOW-1-step-1-registrations-table');

  // Prove the form window really is shut before the admin bypasses it.
  await sql`insert into registration_forms (segment_id, kind, round_label, title, slug, schema, status, opens_at, closes_at)
    values (${ids.playerSegment}, 'PLAYER', 'Round 1', 'Closed form', 'closed-form-b', '{}'::jsonb, 'CLOSED',
            '2026-08-01T00:00:00Z', '2026-08-20T00:00:00Z')`;
  const [form] = await sql<{ status: string; closes_at: string }[]>`
    select status, closes_at from registration_forms where slug = 'closed-form-b'`;
  expect(form.status).toBe('CLOSED');

  await page.getByRole('button', { name: 'New registration' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('select[name="segmentId"]').selectOption(ids.playerSegment);
  await dialog.locator('input[name="contactName"]').fill('Late Arrival');
  await dialog.locator('input[name="contactEmail"]').fill('late@example.test');
  await dialog.locator('select[name="allocationType"]').selectOption('EXTRA');
  await dialog.locator('input[name="seats"]').fill('2');
  await dialog.locator('textarea[name="guestNames"]').fill('Guest One\nGuest Two');
  await shot(page, 'FLOW-1-step-2-new-registration-dialog');

  await dialog.getByRole('button', { name: 'Create registration' }).click();
  await expect(page.locator('tr', { hasText: 'Late Arrival' })).toBeVisible({ timeout: 15_000 });
  console.log('FLOW-1 row:', await page.locator('tr', { hasText: 'Late Arrival' }).innerText());
  await shot(page, 'FLOW-1-step-3-created');

  const rows = await sql<{ source: string; status: string; n: number }[]>`
    select r.source, r.status, count(a.id)::int as n
      from registrations r join attendees a on a.registration_id = r.id
     where r.contact_name = 'Late Arrival' group by r.source, r.status`;
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe('ADMIN');
  expect(rows[0].n).toBe(2);
});

/** FLOW-2 — a seat with no name tickets as a placeholder, and is not an error. */
test('FLOW-2 an unnamed seat is a placeholder, not an error', async () => {
  await page.goto(regs());
  await page.getByRole('button', { name: 'New registration' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('select[name="segmentId"]').selectOption(ids.publicSegment);
  await dialog.locator('input[name="contactName"]').fill('Nameless Party');
  await dialog.locator('select[name="allocationType"]').selectOption('EXTRA');
  await dialog.locator('input[name="seats"]').fill('2');
  await dialog.locator('textarea[name="guestNames"]').fill('Only One Named');
  await shot(page, 'FLOW-2-step-1-one-name-two-seats');
  await dialog.getByRole('button', { name: 'Create registration' }).click();
  await expect(page.locator('tr', { hasText: 'Nameless Party' })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'FLOW-2-step-2-saved-without-error');
  await expect(page.locator('main div[role="alert"], [data-slot="dialog-content"] div[role="alert"]')).toHaveCount(0);

  const seats = await sql<{ full_name: string; name_source: string }[]>`
    select a.full_name, a.name_source from attendees a
      join registrations r on r.id = a.registration_id
     where r.contact_name = 'Nameless Party' order by a.id`;
  console.log('FLOW-2 seats:', JSON.stringify(seats));
  expect(seats.map((s) => s.name_source).sort()).toEqual(['PLACEHOLDER', 'PROVIDED']);
  expect(seats.find((s) => s.name_source === 'PLACEHOLDER')!.full_name)
    .toBe('Guest of Nameless Party');

  await openParty('Nameless Party');
  await shot(page, 'FLOW-2-step-3-placeholder-in-the-sheet');
});

/** FLOW-3 — adding a seat to a full segment must not oversell. */
test('FLOW-3 adding a seat to a full segment is refused, not oversold', async () => {
  await sql`update show_segments set capacity = (
      select count(*) from attendees a join registrations r on r.id = a.registration_id
       where a.segment_id = ${ids.publicSegment} and a.status = 'CONFIRMED'
         and a.deleted_at is null and r.status <> 'CANCELLED')
    where id = ${ids.publicSegment}`;
  const [pool] = await sql<{ p: Record<string, number> }[]>`
    select segment_pool(${ids.publicSegment}::bigint) as p`;
  expect(pool.p.open_seats).toBe(0);
  const before = pool.p.confirmed;

  await openParty('Alice Tan');
  await shot(page, 'FLOW-3-step-1-party-in-a-full-segment');
  await page.getByRole('button', { name: 'Add seats' }).click();
  const dialog = page.getByRole('dialog').last();
  await dialog.locator('input[name="seats"]').fill('1');
  await dialog.getByRole('button', { name: /Add/ }).last().click();
  await expect(page.locator('div[role="status"], div[role="alert"]').first())
    .toBeVisible({ timeout: 15_000 });
  const said = await page.locator('div[role="status"], div[role="alert"]').first().innerText();
  console.log('FLOW-3 the admin sees:', said);
  await shot(page, 'FLOW-3-step-2-refused-or-waitlisted');

  const [after] = await sql<{ p: Record<string, number> }[]>`
    select segment_pool(${ids.publicSegment}::bigint) as p`;
  expect(after.p.confirmed, 'nothing was confirmed past capacity').toBe(before);
  expect(after.p.over).toBe(0);

  await sql`update show_segments set capacity = 300 where id = ${ids.publicSegment}`;
});

/** FLOW-4 — cancel: seats freed, "N seats freed, M waiting", ticket_sent_at kept. */
test('FLOW-4 cancelling frees the seats and keeps the delivery record', async () => {
  // Give the party a delivered ticket and a queued email first.
  const [reg] = await sql<{ id: string }[]>`
    select id from registrations where contact_name = 'Daniel Wong'`;
  await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
             where registration_id = ${reg.id}`;
  await sql`insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
    values (${reg.id}, 'public_ticket', 'daniel@example.test', 'Your ticket', 'body', 'QUEUED'),
           (${reg.id}, 'reminder', 'daniel@example.test', 'Reminder', 'body', 'SENT')`;
  const [poolBefore] = await sql<{ p: Record<string, number> }[]>`
    select segment_pool(${ids.publicSegment}::bigint) as p`;

  await openParty('Daniel Wong');
  await shot(page, 'FLOW-4-step-1-confirmed-party');
  await page.getByRole('button', { name: 'Cancel registration' }).first().click();
  await shot(page, 'FLOW-4-step-2-cancel-confirmation');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel registration' }).click();
  await expect(page.getByRole('dialog').getByText('cancelled').first()).toBeVisible({ timeout: 15_000 });
  cancelScreenText = await page.locator('body').innerText();
  console.log('FLOW-4 what the admin is shown after cancelling:\n' +
    cancelScreenText.split('\n').filter(Boolean).slice(0, 40).join(' | '));
  await shot(page, 'FLOW-4-step-3-seats-freed-message');

  const [poolAfter] = await sql<{ p: Record<string, number> }[]>`
    select segment_pool(${ids.publicSegment}::bigint) as p`;
  expect(poolAfter.p.confirmed).toBe(poolBefore.p.confirmed - 2);

  const seats = await sql<{ status: string; ticket_sent_at: string | null; qr_token: string }[]>`
    select status, ticket_sent_at, qr_token from attendees where registration_id = ${reg.id}`;
  expect(seats.every((s) => s.status === 'CANCELLED')).toBe(true);
  expect(seats.every((s) => s.ticket_sent_at !== null), 'ticket_sent_at survives').toBe(true);

  const outbox = await sql<{ template_key: string; status: string }[]>`
    select template_key, status from email_outbox where registration_id = ${reg.id} order by id`;
  console.log('FLOW-4 outbox:', JSON.stringify(outbox));
  expect(outbox.find((o) => o.template_key === 'public_ticket')!.status).toBe('CANCELLED');
  expect(outbox.find((o) => o.template_key === 'reminder')!.status).toBe('SENT');

  // Nothing was auto-promoted (§7.9).
  const [promoted] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where segment_id = ${ids.publicSegment} and status = 'CONFIRMED'
       and updated_at > now() - interval '5 seconds' and registration_id <> ${reg.id}`;
  expect(promoted.n, 'no auto-promotion').toBe(0);
});

/** FLOW-5 — restore into a segment that filled meanwhile. */
test('FLOW-5 restoring into a full segment does not oversell', async () => {
  const [reg] = await sql<{ id: string }[]>`
    select id from registrations where contact_name = 'Daniel Wong'`;
  await sql`update show_segments set capacity = (
      select count(*) from attendees a join registrations r on r.id = a.registration_id
       where a.segment_id = ${ids.publicSegment} and a.status = 'CONFIRMED'
         and a.deleted_at is null and r.status <> 'CANCELLED')
    where id = ${ids.publicSegment}`;
  const [before] = await sql<{ p: Record<string, number> }[]>`
    select segment_pool(${ids.publicSegment}::bigint) as p`;
  expect(before.p.open_seats).toBe(0);

  await page.goto(regs());
  await page.locator('select[aria-label="Filter by status"]').selectOption('CANCELLED');
  await shot(page, 'FLOW-5-step-1-cancelled-filter');
  await page.locator('tr', { hasText: 'Daniel Wong' }).first().click();
  await page.getByRole('button', { name: /Restore/ }).click();
  await expect(page.locator('div[role="status"]').first()).toBeVisible({ timeout: 15_000 });
  const notice = await page.locator('div[role="status"]').first().innerText();
  console.log('FLOW-5 notice:', notice);
  await shot(page, 'FLOW-5-step-2-restored-but-waitlisted');

  const [after] = await sql<{ p: Record<string, number> }[]>`
    select segment_pool(${ids.publicSegment}::bigint) as p`;
  expect(after.p.confirmed, 'no seat was confirmed past capacity').toBe(before.p.confirmed);
  expect(after.p.over).toBe(0);

  const seats = await sql<{ status: string }[]>`
    select status from attendees where registration_id = ${reg.id}`;
  expect(seats.every((s) => s.status === 'WAITLIST'), 'restored as WAITLIST').toBe(true);

  await sql`update show_segments set capacity = 300 where id = ${ids.publicSegment}`;
});

/** FLOW-6 — move a registration between segments; attendees follow. */
test('FLOW-6 moving a registration takes its seats and keeps their tokens', async () => {
  const [reg] = await sql<{ id: string }[]>`
    select id from registrations where contact_name = 'Alice Tan'`;
  const tokensBefore = await sql<{ id: string; qr_token: string }[]>`
    select id, qr_token from attendees where registration_id = ${reg.id} order by id`;

  await openParty('Alice Tan');
  await shot(page, 'FLOW-6-step-1-before-the-move');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  const dialog = page.getByRole('dialog').last();
  await dialog.locator('select[name="segmentId"]').selectOption(ids.matineeSegment);
  await shot(page, 'FLOW-6-step-2-move-dialog');
  await dialog.getByRole('button', { name: 'Move registration' }).click();
  await expect(page.locator('tr', { hasText: 'Alice Tan' }).first())
    .toContainText('Matinee Show', { timeout: 15_000 });
  console.log('FLOW-6 row after the move:',
    await page.locator('tr', { hasText: 'Alice Tan' }).first().innerText());
  await shot(page, 'FLOW-6-step-3-moved');

  const seats = await sql<{ segment_id: string; show_id: string; qr_token: string; id: string }[]>`
    select id, segment_id, show_id, qr_token from attendees
     where registration_id = ${reg.id} order by id`;
  expect(seats.every((s) => s.segment_id === ids.matineeSegment)).toBe(true);
  expect(seats.every((s) => s.show_id === ids.show2)).toBe(true);
  expect(seats.map((s) => s.qr_token)).toEqual(tokensBefore.map((s) => s.qr_token));
});

/**
 * §7.9: "Admin sees 'N seats freed, M waiting'." The action composes exactly
 * that sentence; this asserts it reaches a human. Last in the file so the rest
 * of the flows run regardless.
 */
test('FLOW-4b the "N seats freed, M waiting" line reaches the admin', async () => {
  console.log('FLOW-4b searching the cancel screen for the §7.9 line');
  expect(cancelScreenText, 'spec/allocation.md §7.9')
    .toMatch(/\d+ seats? freed, \d+ waiting/);
});
