import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { asAdmin, EMAIL_URL, IDS, newSql, resetBlast, resetSink, sink } from './f-helpers';

/**
 * QA pass for `feat/blast-queue-banner` (module F).
 *
 * Flows are numbered from `qa-artifacts/F-queue-banner/02-flows.md`, which was
 * written from `spec/email.md` §11.2.1 and `spec/surfaces.md` §15.1 before any
 * implementation was read. Screenshots key off the flow number.
 *
 * Independent of `f-queue-banner.spec.ts`, which the branch author wrote.
 */

const sql = newSql();
let admin: BrowserContext;

const SHOTS = 'qa-artifacts/F-queue-banner/screens';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const banner = (page: Page) => page.locator('[data-slot="item"]').first();

async function setSetting(key: string, value: number) {
  await sql`
    insert into system_settings (key, value) values (${key}, ${JSON.stringify(value)}::text::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

/** Two per call with a 3s gap, so "mid-blast" is an instant a test can hit. */
async function slowBlast() {
  await setSetting('email.max_per_dispatch', 2);
  await setSetting('email.inter_message_delay_ms', 3000);
}

async function queueFourParties(page: Page) {
  await page.goto(EMAIL_URL());
  await page.getByRole('button', { name: /^Prepare 4 messages$/ }).click();
  await expect(page.getByRole('button', { name: /^Confirm 4 drafts$/ })).toBeEnabled();
  await page.getByRole('button', { name: /^Confirm 4 drafts$/ }).click();
  await expect(page.getByRole('button', { name: /^Send 4 queued$/ })).toBeEnabled();
}

async function outboxCounts() {
  const rows = await sql<{ status: string; n: number }[]>`
    select status, count(*)::int as n from email_outbox group by status order by status
  `;
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
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
  test.setTimeout(180_000);
  await resetBlast(sql);
  await resetSink();
  await setSetting('email.max_per_dispatch', 25);
  await setSetting('email.max_per_day', 450);
  await setSetting('email.inter_message_delay_ms', 0);
  await setSetting('email.max_attachment_mb', 20);
  await setSetting('email.max_attempts', 3);
});

/* ================================================================== FLOW-8 */
/** AC-2, AC-5 — a DRAFT is not unfinished work and must not raise the banner. */
test('FLOW-8 only DRAFT rows exist — no banner, nothing dispatched', async () => {
  const page = await admin.newPage();
  await page.goto(EMAIL_URL());
  await shot(page, 'FLOW-8-step-1-blast-screen-empty-outbox');

  await page.getByRole('button', { name: /^Prepare 4 messages$/ }).click();
  await expect(page.getByRole('button', { name: /^Confirm 4 drafts$/ })).toBeEnabled();
  expect(await outboxCounts()).toEqual({ DRAFT: 4 });

  await page.goto(`/admin/concerts/${IDS.concertId}/overview`);
  await expect(page.getByText('Unfinished blast')).toHaveCount(0);
  await expect(page.getByText('Blast in progress')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await shot(page, 'FLOW-8-step-2-no-banner-for-drafts');

  expect((await sink()).count).toBe(0);
  await page.close();
});

/* ================================================================== FLOW-1 */
/** AC-8, AC-16, AC-17 — the ordinary blast, start to finish, on the screen. */
test('FLOW-1 admin runs a blast and stays on the screen', async () => {
  const page = await admin.newPage();
  await queueFourParties(page);
  await shot(page, 'FLOW-1-step-1-four-queued');

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await shot(page, 'FLOW-1-step-2-send-confirm-dialog');
  await page.getByRole('button', { name: 'Send now' }).click();

  await expect(banner(page)).toContainText('4 sent, 0 failed of 4', { timeout: 90_000 });
  await shot(page, 'FLOW-1-step-3-finished');

  const received = await sink();
  expect(received.count).toBe(4);
  expect(new Set(received.messages.flatMap((m) => m.rcptTo)).size).toBe(4);
  expect(await outboxCounts()).toEqual({ SENT: 4 });

  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees where ticket_sent_at is not null
  `;
  expect(n, 'every attendee whose PDF went out is stamped').toBe(7);
  await page.close();
});

/* ================================================================== FLOW-2 */
/** AC-1, AC-6, AC-7 — the loop outlives the screen that started it. */
test('FLOW-2 the blast continues after navigating to another admin page', async () => {
  await slowBlast();
  const page = await admin.newPage();
  await queueFourParties(page);

  const dispatches: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/outbox/dispatch')) dispatches.push(new Date().toISOString());
  });

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText('Blast in progress');
  // AC-11: Resume is offered only when nothing is sending.
  await expect(banner(page).getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await shot(page, 'FLOW-2-step-1-sending-on-blast-screen');

  await page.getByRole('link', { name: 'Registrations' }).click();
  await expect(page.getByRole('heading', { name: 'Registrations' })).toBeVisible();
  await expect(banner(page)).toContainText('Blast in progress');
  await expect(banner(page).getByRole('button', { name: 'Resume' })).toHaveCount(0);
  const duringNav = dispatches.length;
  await shot(page, 'FLOW-2-step-2-still-sending-on-registrations');

  await expect(banner(page)).toContainText('4 sent, 0 failed of 4', { timeout: 120_000 });
  expect(dispatches.length, 'dispatch calls kept firing after the navigation').toBeGreaterThan(
    duringNav,
  );
  expect((await sink()).count).toBe(4);
  expect(await outboxCounts()).toEqual({ SENT: 4 });
  await shot(page, 'FLOW-2-step-3-finished-away-from-blast-screen');
  await page.close();
});

/* ================================================================== FLOW-3 */
/**
 * AC-3, AC-4, AC-9 — the reload case, which the branch's own suite does not
 * cover. A reload destroys the loop; the spec's claim is that the *banner*
 * survives because its source of truth is `email_outbox`.
 */
test('FLOW-3 reload mid-blast — the banner comes back from the database', async () => {
  await slowBlast();
  const page = await admin.newPage();
  await queueFourParties(page);

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText('Blast in progress');
  await shot(page, 'FLOW-3-step-1-sending-before-reload');

  await page.reload();
  // The loop is gone with the page; the banner must not be.
  await expect(banner(page)).toBeVisible();
  const text = await banner(page).innerText();
  expect(text, `banner after reload:\n${text}`).toMatch(/Unfinished blast|Messages mid-send/);
  expect(text).not.toContain('0 message(s)');
  await shot(page, 'FLOW-3-step-2-banner-after-reload');

  // Whatever it says is queued, Resume must deliver — and the total across the
  // interrupted run and the resumed one is still exactly four.
  await expect
    .poll(async () => (await outboxCounts()).SENDING ?? 0, { timeout: 60_000 })
    .toBe(0);
  await page.reload();
  const beforeResume = (await sink()).count;
  console.log('QA FLOW-3 delivered before Resume:', beforeResume, await outboxCounts());
  await banner(page).getByRole('button', { name: 'Resume' }).click();
  await expect
    .poll(async () => (await outboxCounts()).SENT ?? 0, { timeout: 120_000 })
    .toBe(4);
  await shot(page, 'FLOW-3-step-3-resumed-to-completion');

  expect((await sink()).count, 'no message lost and none sent twice').toBe(4);
  expect(new Set((await sink()).messages.flatMap((m) => m.rcptTo)).size).toBe(4);
  expect(await outboxCounts()).toEqual({ SENT: 4 });
  await page.close();
});

/* ================================================================== FLOW-4 */
/** AC-9, AC-10 — a stalled queue found on a cold load, and Resume drains it. */
test('FLOW-4 stalled queue on a cold load, Resume drains it', async () => {
  const page = await admin.newPage();
  await queueFourParties(page);
  await page.close();

  const fresh = await admin.newPage();
  await fresh.goto(`/admin/concerts/${IDS.concertId}/overview`);
  await expect(banner(fresh)).toContainText('Unfinished blast');
  await expect(banner(fresh)).toContainText('4 message(s) are queued and nothing is sending them');
  await shot(fresh, 'FLOW-4-step-1-stalled-banner-on-cold-load');

  await banner(fresh).getByRole('button', { name: 'Resume' }).click();
  await expect(banner(fresh)).toContainText('4 sent, 0 failed of 4', { timeout: 90_000 });
  await shot(fresh, 'FLOW-4-step-2-resumed');
  expect((await sink()).count).toBe(4);
  await fresh.close();
});

/* ================================================================== FLOW-5 */
/** AC-12 — Resume double-clicked must not double-send. */
test('FLOW-5 Resume double-clicked sends each message once', async () => {
  await slowBlast();
  const page = await admin.newPage();
  await queueFourParties(page);
  await page.goto(`/admin/concerts/${IDS.concertId}/overview`);

  const resume = banner(page).getByRole('button', { name: 'Resume' });
  await expect(resume).toBeVisible();
  await shot(page, 'FLOW-5-step-1-before-double-click');

  // Two clicks in the same task, so both land before React can re-render and
  // hide the button — which is what an impatient double-click actually does.
  const clicks = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Resume',
    ) as HTMLButtonElement | undefined;
    if (!btn) return 0;
    btn.click();
    btn.click();
    return 2;
  });
  expect(clicks, 'both clicks were delivered to the live Resume button').toBe(2);

  await expect
    .poll(async () => (await outboxCounts()).SENT ?? 0, { timeout: 120_000 })
    .toBe(4);
  await page.waitForTimeout(4000);
  const received = await sink();
  expect(received.count, 'two clicks must not double-send').toBe(4);
  expect(new Set(received.messages.flatMap((m) => m.rcptTo)).size).toBe(4);
  expect(await outboxCounts()).toEqual({ SENT: 4 });
  await shot(page, 'FLOW-5-step-2-exactly-four-delivered');
  await page.close();
});

/* ================================================================== FLOW-6 */
/** AC-13, AC-14, AC-15 — Dismiss hides, and must never stop, the send. */
test('FLOW-6 Dismiss hides the banner and delivery carries on', async () => {
  await slowBlast();
  const page = await admin.newPage();
  await queueFourParties(page);

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText('Blast in progress');
  await shot(page, 'FLOW-6-step-1-sending');

  await page.getByRole('button', { name: 'Hide this banner' }).click();
  await expect(page.getByText('Blast in progress')).toHaveCount(0);
  await shot(page, 'FLOW-6-step-2-dismissed');

  await expect
    .poll(async () => (await sink()).count, { timeout: 120_000 })
    .toBe(4);
  expect(await outboxCounts(), 'dismiss must never halt delivery').toEqual({ SENT: 4 });
  await shot(page, 'FLOW-6-step-3-delivered-anyway');

  // AC-15: no unconfirmed control that halts delivery exists on the banner.
  await page.goto(`/admin/concerts/${IDS.concertId}/overview`);
  await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0);
  await page.close();
});

/* ================================================================== FLOW-7 */
/** AC-16, AC-18 — Send twice, and Prepare over a queued batch. */
test('FLOW-7 Send pressed twice, and Prepare over a queued batch', async () => {
  const page = await admin.newPage();
  await queueFourParties(page);
  await shot(page, 'FLOW-7-step-1-four-queued');

  // Prepare again while the batch is QUEUED — the partial unique index has to
  // make this a no-op, not a second set of drafts.
  await page.getByRole('button', { name: /^Prepare/ }).click();
  await page.waitForTimeout(1500);
  expect(await outboxCounts(), 'no second draft per registration').toEqual({ QUEUED: 4 });
  await shot(page, 'FLOW-7-step-2-reprepare-is-a-noop');

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText('4 sent, 0 failed of 4', { timeout: 90_000 });

  // Second press. Nothing is queued now, so the control must be unavailable.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Send 0 queued$/ })).toBeDisabled();
  await shot(page, 'FLOW-7-step-3-second-send-unavailable');
  expect((await sink()).count).toBe(4);
  await page.close();
});

/* ================================================================== FLOW-9 */
/** AC-20 — the daily cap is its own state, and offers no dead Resume. */
test('FLOW-9 daily cap reached gets its own state', async () => {
  const page = await admin.newPage();
  await queueFourParties(page);
  await setSetting('email.max_per_day', 0);

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText('Daily send limit reached', { timeout: 60_000 });
  await expect(banner(page)).toContainText('4 message(s) will go out tomorrow');
  await expect(banner(page).getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await shot(page, 'FLOW-9-step-1-daily-cap-state');
  expect((await sink()).count, 'the cap defers, it does not send').toBe(0);

  // ...but it must not survive a reload as a dead end either: the rows are
  // still queued, so a reloaded console has to say something true about them.
  await page.reload();
  const text = await banner(page).innerText();
  await shot(page, 'FLOW-9-step-2-after-reload');
  expect(text, `banner after reload:\n${text}`).toContain('message(s)');
  await page.close();
});

/* ================================================================= FLOW-12 */
/**
 * AC-28 and the phantom-Resume question. A failure puts the row back in
 * `QUEUED` with `scheduled_for` in the future (backoff). `outboxBacklog()`
 * counts it as `resumable`, so the banner offers Resume — but `claimBatch()`
 * will not touch a row whose `scheduled_for` is ahead of now.
 */
test('FLOW-12 a failed send: no stamp, and what Resume does about the backoff', async () => {
  const page = await admin.newPage();
  await queueFourParties(page);

  // Force every send to fail at the attachment-size gate: an operational value,
  // set through the cascade, so nothing in `src/` is touched.
  await setSetting('email.max_attachment_mb', 0);

  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText(/failed/, { timeout: 90_000 });
  await shot(page, 'FLOW-12-step-1-failures-reported');

  expect((await sink()).count, 'nothing was delivered').toBe(0);
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees where ticket_sent_at is not null
  `;
  expect(n, 'a failed send stamps nothing (§11.4 point 4)').toBe(0);

  await expect
    .poll(async () => (await outboxCounts()).SENDING ?? 0, { timeout: 60_000 })
    .toBe(0);

  const rows = await sql<{ status: string; attempts: number; future: boolean; err: string }[]>`
    select status, attempts, scheduled_for > now() as future, coalesce(last_error,'') as err
      from email_outbox order by id
  `;
  console.log('QA outbox after failure:', JSON.stringify(rows, null, 2));
  expect(rows.every((r) => r.status === 'QUEUED' && r.future)).toBe(true);
  expect(rows.every((r) => r.err.length > 0)).toBe(true);

  // Now the banner on a cold load, over four rows that are backing off.
  await page.goto(`/admin/concerts/${IDS.concertId}/overview`);
  const text = await banner(page).innerText();
  console.log('QA banner over a backing-off queue:', JSON.stringify(text));
  await shot(page, 'FLOW-12-step-2-banner-over-backoff');

  const hasResume = await banner(page).getByRole('button', { name: 'Resume' }).count();
  let delivered = 0;
  if (hasResume > 0) {
    const before = await sink();
    await banner(page).getByRole('button', { name: 'Resume' }).click();
    await page.waitForTimeout(5000);
    const after = await sink();
    delivered = after.count - before.count;
    const still = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where status = 'QUEUED'
    `;
    console.log(
      `QA Resume over a backing-off queue: sink ${before.count} -> ${after.count}, ` +
        `still QUEUED = ${still[0].n}, banner now = ${JSON.stringify(
          await banner(page).innerText(),
        )}`,
    );
    await shot(page, 'FLOW-12-step-3-after-pressing-resume');
  }

  /**
   * The branch's own rule, from `blast-queue.tsx`: "a control that does nothing
   * reads as a broken one" — which is why the daily cap was given its own state
   * instead of a Resume. A row inside its retry backoff is the same situation
   * and did not get the same treatment.
   */
  expect(
    hasResume === 0 || delivered > 0,
    'Resume is offered over a queue that `claimBatch()` will not touch, and does nothing',
  ).toBe(true);
  await page.close();
});

/* ============================================================ FLOW-10 / 11 */
/** AC-24, AC-25 — the shell that carries the banner, and the endpoint it drives. */
test('FLOW-10/11 anonymous and OPERATOR are refused the shell and the dispatcher', async ({
  browser,
}) => {
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const anonDispatch = await anon.request.post('/api/outbox/dispatch');
  expect(anonDispatch.status()).toBe(401);
  expect(await anonDispatch.text()).toContain('unauthorized');
  await anonPage.goto(`/admin/concerts/${IDS.concertId}/overview`);
  expect(anonPage.url()).toContain('/login');
  await expect(anonPage.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await shot(anonPage, 'FLOW-10-step-1-anonymous-refused');
  await anon.close();

  const op = await browser.newContext();
  const opPage = await op.newPage();
  await opPage.goto('/scan/login');
  await opPage.getByLabel('Display name').fill('Wei Ling');
  await opPage.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    opPage.waitForURL((u) => !u.pathname.startsWith('/scan/login')),
    opPage.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  const opDispatch = await op.request.post('/api/outbox/dispatch');
  expect(opDispatch.status(), 'an OPERATOR must not be able to drain the outbox').toBe(401);
  await opPage.goto(`/admin/concerts/${IDS.concertId}/overview`);
  expect(opPage.url(), 'an OPERATOR never reaches the admin shell').not.toContain('/admin');
  await expect(opPage.getByText('Unfinished blast')).toHaveCount(0);
  await shot(opPage, 'FLOW-11-step-1-operator-refused');
  await op.close();
});

/* ================================================================= FLOW-13 */
/** AC-26 — timestamps render in `concert.timezone`, never the viewer's. */
test('FLOW-13 timestamps do not move with the browser timezone', async ({ browser }) => {
  const page = await admin.newPage();
  await queueFourParties(page);
  await page.getByRole('button', { name: /^Send 4 queued$/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(banner(page)).toContainText('4 sent', { timeout: 90_000 });
  await page.close();

  const state = await admin.storageState();
  const read = async (timezoneId: string) => {
    const ctx = await browser.newContext({ storageState: state, timezoneId });
    const p = await ctx.newPage();
    await p.goto(EMAIL_URL());
    await expect(p.getByText('Sent', { exact: true }).first()).toBeVisible();
    const cells = await p.locator('table tbody tr td').allInnerTexts();
    await shot(p, `FLOW-13-step-${timezoneId === 'Asia/Singapore' ? 1 : 2}-${timezoneId.replace(/\//g, '-')}`);
    await p.close();
    await ctx.close();
    return cells.filter((c) => /\d{1,2}:\d{2}/.test(c));
  };

  const sg = await read('Asia/Singapore');
  const ny = await read('America/New_York');
  console.log('QA timestamps SG:', JSON.stringify(sg), '\nQA timestamps NY:', JSON.stringify(ny));
  expect(ny, 'rendered in concert.timezone, not the viewer’s').toEqual(sg);
});
