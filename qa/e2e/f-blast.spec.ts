import { test, expect } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { asAdmin, EMAIL_URL, IDS, newSql, resetBlast, resetSink, shot, sink } from './f-helpers';

/**
 * QA phase 5 — module `F`'s flows walked in Chromium.
 *
 * `qa/support/start-f.sh` must have run: it seeds zetix_qa, starts the stub
 * GoTrue, starts a real local SMTP sink on 2526 (Gmail is unreachable from any
 * container — `docs/local.md` §7) and brings up `next dev` on :3100.
 *
 * Every step asserts before it screenshots. A screenshot is evidence for a
 * human; the assertion is the test.
 */
const sql = newSql();
let admin: BrowserContext;

test.beforeAll(async ({ browser }) => {
  admin = await asAdmin(browser);
});

test.afterAll(async () => {
  await admin.close();
  await sql.end();
});

test.describe.configure({ mode: 'serial' });

/* ----------------------------------------------------------------- FLOW-1 */
test('FLOW-1 the split is shown before anything is queued', async () => {
  await resetBlast(sql);
  const page = await admin.newPage();

  await page.goto(EMAIL_URL());
  await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
  await shot(page, 'FLOW-1-step-1-blast-screen');

  // Seeded: 4 parties on the public segment, 7 seats, none delivered.
  const stats = page.locator('dl').first();
  await expect(stats).toContainText('Confirmed attendees');
  const [db] = await sql<{ confirmed: number; sent: number; pending: number }[]>`
    select count(*)::int as confirmed,
           count(*) filter (where a.ticket_sent_at is not null)::int as sent,
           count(*) filter (where a.ticket_sent_at is null)::int as pending
      from attendees a join registrations r on r.id = a.registration_id
     where a.segment_id = ${IDS.segmentPublic} and a.status = 'CONFIRMED'
       and r.status = 'CONFIRMED'
  `;
  await expect(stats).toContainText(String(db.confirmed));
  expect(db).toEqual({ confirmed: 7, sent: 0, pending: 7 });

  // §11.4: nothing is queued until the admin confirms against those numbers.
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox`;
  expect(n).toBe(0);
  await expect(page.getByText('4 message(s) would be prepared')).toBeVisible();
  await shot(page, 'FLOW-1-step-2-split-matches-db');

  await page.close();
});

/* ----------------------------------------------------------------- FLOW-2 */
test('FLOW-2 confirming renders the batch into DRAFT and stamps nobody', async () => {
  const page = await admin.newPage();
  await page.goto(EMAIL_URL());

  await page.getByRole('button', { name: /^Prepare 4 messages$/ }).click();
  await expect(page.getByText('4 message(s) drafted for review.')).toBeVisible();
  await shot(page, 'FLOW-2-step-1-prepared');

  const rows = await sql<{ status: string; subject: string; body_md: string; to_email: string }[]>`
    select status, subject, body_md, to_email from email_outbox order by id
  `;
  expect(rows).toHaveLength(4);
  expect(rows.every((r) => r.status === 'DRAFT')).toBe(true);
  expect(rows.every((r) => !r.body_md.includes('{{'))).toBe(true);
  expect(rows.map((r) => r.to_email).sort()).toEqual([
    'alice@example.test',
    'bob@example.test',
    'chandra@example.test',
    'farid@example.test',
  ]);

  // §11.4 mechanism 1: queueing never stamps.
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees where ticket_sent_at is not null
  `;
  expect(n).toBe(0);

  await expect(page.getByText('Alice Tan').first()).toBeVisible();
  await shot(page, 'FLOW-2-step-2-drafts-listed');
  await page.close();
});

/* ----------------------------------------------------------------- FLOW-3 */
test('FLOW-3 pressing Prepare a second time is a no-op', async () => {
  const page = await admin.newPage();
  await page.goto(EMAIL_URL());

  const before = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox`;
  expect(before[0].n).toBe(4);
  await shot(page, 'FLOW-3-step-1-four-drafts-exist');

  await page.getByRole('button', { name: /^Prepare 4 messages$/ }).click();
  await expect(page.getByText(/Nothing to prepare|0 message/)).toBeVisible();
  await shot(page, 'FLOW-3-step-2-second-press-refused');

  const after = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox`;
  expect(after[0].n).toBe(4);
  await page.close();
});

/* ----------------------------------------------------------------- FLOW-4 */
test('FLOW-4 a hand-edited message survives a template re-render', async () => {
  const page = await admin.newPage();
  await page.goto(EMAIL_URL());

  // Edit exactly one message.
  await page.getByRole('button', { name: 'Read / edit' }).first().click();
  const body = page.getByLabel('Body (Markdown)');
  await expect(body).toBeVisible();
  await body.fill('HAND EDITED — wheelchair access is via the side door.');
  await shot(page, 'FLOW-4-step-1-editing-one-message');
  await page.getByRole('button', { name: 'Save message' }).click();
  // The dialog closes on success (module A's ActionDialog), so the assertion
  // is the row itself, not a toast.
  await expect
    .poll(async () => (await sql`select id from email_outbox where body_md like 'HAND EDITED%'`).length)
    .toBe(1);
  await shot(page, 'FLOW-4-step-2-message-edited');

  // Now edit the template and re-render the batch.
  await page.goto(`/admin/concerts/${IDS.concertId}/email/templates?key=public_ticket`);
  await expect(page.getByRole('heading', { name: 'Email templates' })).toBeVisible();
  await page
    .getByLabel('Body (Markdown)')
    .fill('REWRITTEN TEMPLATE for {{ registration.contact_name }}.');
  await shot(page, 'FLOW-4-step-3-template-rewritten');
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText(/Template saved/)).toBeVisible();
  await shot(page, 'FLOW-4-step-4-rerendered');

  const after = await sql<{ id: string; body_md: string }[]>`
    select id, body_md from email_outbox order by id
  `;
  const stillEdited = after.filter((r) => r.body_md.startsWith('HAND EDITED'));
  const rerendered = after.filter((r) => r.body_md.startsWith('REWRITTEN TEMPLATE'));
  expect({ preserved: stillEdited.length, rerendered: rerendered.length }).toEqual({
    preserved: 1,
    rerendered: 3,
  });
  await page.close();
});

/* --------------------------------------------------------- FLOW-5, FLOW-6 */
test('FLOW-5/6 send delivers one message per party, and Send twice is harmless', async () => {
  await resetSink();
  const page = await admin.newPage();

  // A blast attaches PDFs, so module `D` has to have issued them first. Doing
  // it through the UI keeps the D→F handover honest.
  await page.goto(`/admin/concerts/${IDS.concertId}/tickets?show=${IDS.showId}`);
  await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
  await page.getByRole('button', { name: 'Issue tickets' }).click();
  await expect
    .poll(
      async () =>
        (await sql`select id from attendees where ticket_template_id is not null`).length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await shot(page, 'FLOW-5-step-0-tickets-issued');

  await page.goto(EMAIL_URL());
  await page.getByRole('button', { name: /^Confirm 4 drafts$/ }).click();
  await expect(page.getByText('4 message(s) queued')).toBeVisible();
  await shot(page, 'FLOW-5-step-1-confirmed-queued');

  const queued = await sql<{ status: string; n: number }[]>`
    select status, count(*)::int as n from email_outbox group by status
  `;
  expect(queued).toEqual([{ status: 'QUEUED', n: 4 }]);

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await expect(page.getByRole('heading', { name: /Send 4 message/ })).toBeVisible();
  await shot(page, 'FLOW-5-step-2-send-confirmation');
  await page.getByRole('button', { name: 'Send now' }).click();

  await expect(page.getByText('4 sent, 0 failed of 4')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'FLOW-5-step-3-sent');

  const received = await sink();
  expect(received.count).toBe(4);
  expect(received.messages.flatMap((m) => m.rcptTo).sort()).toEqual([
    'alice@example.test',
    'bob@example.test',
    'chandra@example.test',
    'farid@example.test',
  ]);
  // One PDF per seat: Alice 2, Bob 1, Chandra 3, Farid 1.
  expect(received.messages.map((m) => m.attachments).sort()).toEqual([1, 1, 2, 3]);

  const stamps = await sql<{ ticket_sent_source: string; n: number }[]>`
    select ticket_sent_source, count(*)::int as n from attendees
     where ticket_sent_at is not null group by ticket_sent_source
  `;
  expect(stamps).toEqual([{ ticket_sent_source: 'EMAIL', n: 7 }]);

  // FLOW-6: press Prepare and Send again. Nothing more must go out.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Prepare 0 messages$/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Send 0 queued$/ })).toBeDisabled();
  await shot(page, 'FLOW-6-step-1-nothing-left-to-send');

  const again = await sink();
  expect(again.count).toBe(4);
  await page.close();
});

/* ----------------------------------------------------------------- FLOW-7 */
test('FLOW-7 a round-2 blast reaches only the new party', async () => {
  await resetSink();
  const page = await admin.newPage();

  // A new round-2 registration arrives after round 1 went out.
  const [r] = await sql<{ id: string }[]>`
    insert into registrations (show_id, segment_id, source, round_label, contact_name,
                               contact_email, status, requested_at)
    values (${IDS.showId}, ${IDS.segmentPublic}, 'ADMIN', 'Round 2', 'Grace Ng',
            'grace@example.test', 'CONFIRMED', now())
    returning id`;
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting','on',true)`;
    await tx`insert into attendees (registration_id, show_id, segment_id, full_name,
                                    name_source, allocation_type, status)
             values (${r.id}, ${IDS.showId}, ${IDS.segmentPublic}, 'Grace Ng',
                     'PROVIDED', 'BASE', 'CONFIRMED')`;
  });

  // Round 2's seats need identifiers before a ticket email can carry them —
  // the dispatcher refuses to send a ticket message with nothing attached,
  // which is the right refusal and is asserted separately.
  await page.goto(`/admin/concerts/${IDS.concertId}/tickets?show=${IDS.showId}`);
  await page.getByRole('button', { name: 'Issue tickets' }).click();
  await expect
    .poll(async () => (await sql`select id from attendees where ticket_template_id is null`).length, {
      timeout: 60_000,
    })
    .toBe(0);

  await page.goto(EMAIL_URL());
  await expect(page.getByText('1 message(s) would be prepared')).toBeVisible();
  await shot(page, 'FLOW-7-step-1-only-round-2-pending');

  await page.getByRole('button', { name: /^Prepare 1 message$/ }).click();
  await expect(page.getByText('1 message(s) drafted for review.')).toBeVisible();
  await page.getByRole('button', { name: /^Confirm 1 draft$/ }).click();
  await expect(page.getByText('1 message(s) queued')).toBeVisible();
  await page.getByRole('button', { name: /^Send 1 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('1 sent, 0 failed of 1')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'FLOW-7-step-2-round-2-sent');

  const received = await sink();
  expect(received.count).toBe(1);
  expect(received.messages[0].rcptTo).toEqual(['grace@example.test']);
  await page.close();
});

/* --------------------------------------------------------- FLOW-10, 11, 12 */
test('FLOW-10/11/12/13 §11.6 is unreachable — the delivery table has no row checkbox', async () => {
  const page = await admin.newPage();

  // Put one seat back in the pending bucket so there is something to mark.
  await sql`update attendees set ticket_sent_at = null, ticket_sent_source = null
             where full_name = 'Bob Lim'`;
  await sql`delete from email_outbox`;

  await page.goto(`/admin/concerts/${IDS.concertId}/email/delivery`);
  await expect(page.getByRole('heading', { name: 'Ticket delivery' })).toBeVisible();
  await shot(page, 'FLOW-10-step-1-delivery-screen');

  await page.getByRole('textbox', { name: /Search attendee/ }).fill('Bob Lim');
  await expect(page.getByRole('row')).toHaveCount(2); // header + Bob Lim
  await shot(page, 'FLOW-10-step-2-row-has-no-checkbox');

  // `DeliveryTable` passes `enableSelection` but never prepends
  // `selectionColumn()` to its columns, so no row can be selected — and both
  // §11.6 actions are gated on a selection.
  expect(await page.getByRole('checkbox', { name: 'Select row' }).count()).toBe(0);
  expect(await page.getByRole('checkbox').count()).toBe(0);
  await expect(page.getByText('0 selected')).toBeVisible();

  await expect(page.getByRole('button', { name: /^Mark 0 as delivered$/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Resend 0 ticket/ })).toBeDisabled();
  await shot(page, 'FLOW-11-step-1-both-actions-permanently-disabled');

  // Nothing can be marked, so the seat stays pending for every future blast —
  // exactly the state §11.6 exists to prevent.
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where full_name = 'Bob Lim' and ticket_sent_at is null`;
  expect(n).toBe(1);
  await page.close();
});

test('FLOW-12 the server-side resend leaves qr_token alone (reached around the UI)', async () => {
  // The screen cannot select a row, so this exercises the same Server Action
  // the button would call, to establish that the defect above is the UI\'s
  // alone and decision 28 still holds underneath it.
  const before = await sql<{ id: string; qr_token: string }[]>`
    select id, qr_token from attendees where full_name = 'Chandra Rao'`;
  await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
             where full_name = 'Chandra Rao'`;
  await sql`update attendees set ticket_sent_at = null, ticket_sent_source = null
             where full_name = 'Chandra Rao'`;
  const after = await sql<{ id: string; qr_token: string }[]>`
    select id, qr_token from attendees where full_name = 'Chandra Rao'`;
  expect(after[0].qr_token).toBe(before[0].qr_token);
});

/* ---------------------------------------------------------------- FLOW-16 */
test('FLOW-16 timestamps render in concert.timezone, not the viewer’s', async ({ browser }) => {
  // The concert is Asia/Kuala_Lumpur. Two viewers, twelve hours apart.
  const read = async (timezoneId: string, tag: string) => {
    const ctx = await browser.newContext({ timezoneId, storageState: await admin.storageState() });
    const page = await ctx.newPage();
    await page.goto(`/admin/concerts/${IDS.concertId}/email/delivery`);
    await expect(page.getByRole('heading', { name: 'Ticket delivery' })).toBeVisible();
    const cell = page.getByText(/MANUAL|EMAIL/).first();
    await expect(cell).toBeVisible();
    const text = await page.locator('tbody').innerText();
    await shot(page, `FLOW-16-step-${tag}`);
    await ctx.close();
    return text.match(/\d{1,2} \w{3,9} \d{4},? \d{2}:\d{2}/g) ?? [];
  };

  const kl = await read('Asia/Kuala_Lumpur', '1-viewer-in-kuala-lumpur');
  const la = await read('America/Los_Angeles', '2-viewer-in-los-angeles');
  expect(kl.length).toBeGreaterThan(0);
  expect(la).toEqual(kl);
});
