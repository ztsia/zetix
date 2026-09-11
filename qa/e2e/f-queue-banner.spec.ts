import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { asAdmin, EMAIL_URL, IDS, newSql, resetBlast, resetSink, sink } from './f-helpers';

/**
 * The shell's queue banner and the dispatch loop behind it
 * (spec/email.md §11.2.1, surfaces.md §15.1).
 *
 * These are browser tests rather than suite tests because the property under
 * test **is** the browser: a loop that survives a route change and a banner
 * that survives a reload cannot be observed from `tests/`. What CI can check —
 * that the number on the banner is the number a dispatch delivers — is in
 * `tests/email/queue-banner.test.ts`.
 *
 * The bug being defended against is silence: a blast that stops halfway looks
 * exactly like one that finished.
 */

const sql = newSql();
let admin: BrowserContext;

const SHOTS = 'qa-artifacts/F-queue-banner/screens';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/** The banner is an `Item` in the shell, above the content area on every route. */
const banner = (page: Page) => page.locator('[data-slot="item"]').first();

async function setSetting(key: string, value: number) {
  await sql`
    insert into system_settings (key, value) values (${key}, ${JSON.stringify(value)}::text::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

/**
 * Stretches the blast over more than one dispatch call, so "while it is
 * running" is a real instant rather than a race.
 *
 * **A batch of one would not work**: `email.inter_message_delay_ms` is applied
 * *between* messages inside a batch, so a batch of one never sleeps at all and
 * four parties go out faster than a navigation.
 */
async function slowBlast() {
  await setSetting('email.max_per_dispatch', 2);
  await setSetting('email.inter_message_delay_ms', 3000);
}

/** Prepares and confirms a batch, leaving it QUEUED and unsent — what Send acts on. */
async function queueFourParties(page: Page) {
  await page.goto(EMAIL_URL());
  await page.getByRole('button', { name: /^Prepare 4 messages$/ }).click();
  await expect(page.getByRole('button', { name: /^Confirm 4 drafts$/ })).toBeEnabled();
  await page.getByRole('button', { name: /^Confirm 4 drafts$/ }).click();
  await expect(page.getByRole('button', { name: /^Send 4 queued$/ })).toBeEnabled();
}

test.beforeAll(async ({ browser }) => {
  admin = await asAdmin(browser);
});

test.afterAll(async () => {
  await admin.close();
  await sql.end();
});

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await resetBlast(sql);
  await resetSink();
  await setSetting('email.max_per_dispatch', 25);
  await setSetting('email.max_per_day', 450);
  await setSetting('email.inter_message_delay_ms', 0);
});

/* ------------------------------------------------------------------- QB-1 */
/**
 * The core of §11.2.1. A blast that stopped — tab closed, laptop asleep —
 * leaves `QUEUED` rows behind and no client state at all. The banner has to
 * come back from the database on a cold page load, or the admin's next signal
 * is a registrant asking where their ticket is.
 */
test('QB-1 a cold load over a queued outbox shows the banner and offers Resume', async () => {
  const page = await admin.newPage();
  await queueFourParties(page);
  await page.close();

  // A brand-new context: no client state whatsoever, exactly like reopening the
  // laptop. Not even the blast screen — the banner is on every admin route.
  const fresh = await admin.newPage();
  await fresh.goto(`/admin/concerts/${IDS.concertId}/overview`);

  await expect(banner(fresh)).toContainText('Unfinished blast');
  await expect(banner(fresh)).toContainText('4 message(s) are queued and nothing is sending them');
  await expect(banner(fresh).getByRole('button', { name: 'Resume' })).toBeVisible();
  await shot(fresh, 'QB-1-banner-on-cold-load');

  // And it is not a decoration: Resume delivers.
  await banner(fresh).getByRole('button', { name: 'Resume' }).click();
  await expect(banner(fresh)).toContainText('4 sent, 0 failed of 4', { timeout: 60_000 });
  expect((await sink()).count).toBe(4);
  await shot(fresh, 'QB-1-resume-delivered');

  await fresh.close();
});

/* ------------------------------------------------------------------- QB-2 */
/**
 * **The bug this branch exists to fix.** The loop used to live in the blast
 * screen's component state, so navigating to any other admin page unmounted it
 * and the send died mid-blast, silently.
 *
 * One message per dispatch call with a delay between them stretches four
 * messages over several calls, which is what makes "navigate away while it is
 * running" a real instant rather than a race.
 */
test('QB-2 the send continues, and reports, after navigating to another admin page', async () => {
  await slowBlast();

  const page = await admin.newPage();
  await queueFourParties(page);

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText('Blast in progress');

  // The in-component guard: while the shell is sending, Send cannot start a
  // second loop over the same queue.
  await expect(page.getByRole('button', { name: /queued$/ })).toBeDisabled();

  // Leave the screen that started it — the old failure mode, exactly.
  await page.getByRole('link', { name: 'Registrations' }).click();
  await expect(page.getByRole('heading', { name: 'Registrations' })).toBeVisible();

  // Still sending, on a page that knows nothing about blasts.
  await expect(banner(page)).toContainText('Blast in progress');
  await shot(page, 'QB-2-still-sending-on-another-page');

  await expect(banner(page)).toContainText('4 sent, 0 failed of 4', { timeout: 90_000 });
  expect((await sink()).count, 'the send finished away from the blast screen').toBe(4);
  await shot(page, 'QB-2-finished-away-from-blast-screen');

  await page.close();
});

/* ------------------------------------------------------------------- QB-3 */
/**
 * §11.2.1, not a preference: **Dismiss hides the banner and never stops the
 * send.** A control that silently halts delivery halfway through a blast is
 * worse than no control at all.
 */
test('QB-3 dismiss hides the banner and delivery carries on regardless', async () => {
  await slowBlast();

  const page = await admin.newPage();
  await queueFourParties(page);

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText('Blast in progress');

  await page.getByRole('button', { name: 'Hide this banner' }).click();
  await expect(page.getByText('Blast in progress')).toBeHidden();
  await shot(page, 'QB-3-dismissed');

  // The send was hidden, not stopped.
  await expect
    .poll(async () => (await sink()).count, { timeout: 90_000 })
    .toBe(4);
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from email_outbox where status = 'SENT'
  `;
  expect(n, 'dismiss must never halt delivery').toBe(4);

  await page.close();
});

/* ------------------------------------------------------------------- QB-4 */
/**
 * `email.max_per_day` ends the loop with nothing sent and rows still queued.
 * That is neither "sending" nor "stalled", and it must not offer Resume:
 * a button that cannot do anything until tomorrow reads as a broken one.
 */
test('QB-4 the daily cap gets its own state, and no Resume button', async () => {
  const page = await admin.newPage();
  await queueFourParties(page);

  // Nothing has gone out today, so a cap of zero is reached immediately.
  await setSetting('email.max_per_day', 0);

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();

  await expect(banner(page)).toContainText('Daily send limit reached', { timeout: 60_000 });
  await expect(banner(page)).toContainText('4 message(s) will go out tomorrow');
  await expect(banner(page).getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await shot(page, 'QB-4-daily-cap');

  expect((await sink()).count, 'the cap must defer, not send').toBe(0);

  await page.close();
});

/* ------------------------------------------------------------------- QB-5 */
/**
 * A dispatch that dies mid-batch leaves rows in `SENDING`, not `QUEUED`. A
 * banner counting only `QUEUED` would report nothing and hide itself over an
 * outbox that has not delivered — the halted blast looking exactly like a
 * finished one, which is the whole bug.
 */
test('QB-5 rows stranded by a dead dispatch keep the banner up', async () => {
  const page = await admin.newPage();
  await queueFourParties(page);

  // Exactly what a timed-out invocation leaves behind, aged past the reclaim
  // window. The trigger rewrites `updated_at` on every update, so it is stood
  // down for that one statement (see tests/email/dispatch-recovery.test.ts).
  await sql`update email_outbox set status = 'SENDING'`;
  await sql`alter table email_outbox disable trigger email_outbox_set_updated_at`;
  await sql`update email_outbox set updated_at = now() - interval '2 hours' where status = 'SENDING'`;
  await sql`alter table email_outbox enable trigger email_outbox_set_updated_at`;

  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from email_outbox where status = 'QUEUED'
  `;
  expect(n, 'the trap: nothing QUEUED, nothing delivered').toBe(0);

  await page.goto(`/admin/concerts/${IDS.concertId}/overview`);
  await expect(banner(page)).toContainText('Unfinished blast');
  await expect(banner(page)).toContainText('4 message(s)');
  await shot(page, 'QB-5-stranded-rows-still-reported');

  await banner(page).getByRole('button', { name: 'Resume' }).click();
  await expect(banner(page)).toContainText('4 sent, 0 failed of 4', { timeout: 60_000 });
  expect((await sink()).count).toBe(4);

  await page.close();
});

/* ------------------------------------------------------------------- QB-6 */
/**
 * §11.4's guarantee, through the new entry point.
 *
 * The loop now lives in the shell, so an admin with the console open in two
 * tabs has **two** of them, and both offer Resume over the same queue. That is
 * the shape the old single-screen loop could not produce, and pressing Send
 * when unsure whether the first click registered is exactly what an admin does.
 * `for update skip locked` is what has to hold; a double claim is a double send.
 */
test('QB-6 two consoles resuming the same queue send each message once', async () => {
  await slowBlast();

  const first = await admin.newPage();
  await queueFourParties(first);

  // A second console, rendered while the four are still queued, so its banner
  // offers Resume over the same rows.
  const second = await admin.newPage();
  await second.goto(`/admin/concerts/${IDS.concertId}/overview`);
  await expect(banner(second).getByRole('button', { name: 'Resume' })).toBeVisible();

  await first.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await first.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(first)).toContainText('Blast in progress');

  // The second console presses Resume over a queue already being drained.
  await banner(second).getByRole('button', { name: 'Resume' }).click();

  await expect(banner(first)).toContainText('sent,', { timeout: 90_000 });
  await expect
    .poll(async () => (await sink()).count, { timeout: 90_000 })
    .toBe(4);

  const received = await sink();
  expect(received.count, 'two loops over one queue must never double-send').toBe(4);
  const recipients = received.messages.flatMap((m) => m.rcptTo);
  expect(new Set(recipients).size, 'every party got exactly one message').toBe(4);

  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from email_outbox where status = 'SENT'
  `;
  expect(n).toBe(4);

  await first.close();
  await second.close();
});
