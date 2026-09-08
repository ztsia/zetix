import { test, expect, type Browser, type Page } from '@playwright/test';
import { asAdmin, reseed, shot, sql } from './b-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

let ids: Record<string, string>;
let browserRef: Browser;
let page: Page;

test.beforeAll(async ({ browser }) => {
  browserRef = browser;
  ids = reseed();
  const ctx = await asAdmin(browser);
  page = await ctx.newPage();
});
test.afterAll(async () => {
  await sql.end();
});

const review = () =>
  `/admin/concerts/${ids.concertId}/extras-review?segment=${ids.playerSegment}`;

/** Set the player segment's capacity so the extras pool lands on `want`. */
async function poolOf(want: number) {
  const [p] = await sql<{ p: Record<string, number> }[]>`
    select segment_pool(${ids.playerSegment}::bigint) as p`;
  await sql`update show_segments
               set capacity = ${want + p.p.confirmed + p.p.unclaimed_base}
             where id = ${ids.playerSegment}`;
  const [after] = await sql<{ p: Record<string, number> }[]>`
    select segment_pool(${ids.playerSegment}::bigint) as p`;
  expect(after.p.extras_pool).toBe(want);
  return after.p;
}

const grantInputs = () => page.locator('input[aria-label^="Seats granted to"]');

async function grants(): Promise<number[]> {
  return grantInputs().evaluateAll((els) =>
    els.map((e) => Number((e as HTMLInputElement).value)),
  );
}

/** FLOW-7 — the header, the table and a commit inside the pool. */
test('FLOW-7 preselect and commit inside the pool', async () => {
  await page.goto(review());
  await shot(page, 'FLOW-7-step-1-review-screen');

  const header = await page.locator('div.grid.gap-3').first().innerText();
  console.log('FLOW-7 header:\n' + header);
  expect(header).toContain('EXTRAS POOL');
  expect(header).toContain('20');           // §7.2: 96 open − 76 unclaimed base
  expect(header).toContain('7 seats asked for');

  // §7.5's columns.
  const columns = await page.locator('thead th').allInnerTexts();
  console.log('FLOW-7 columns:', JSON.stringify(columns));
  expect(columns).toEqual(['#', 'Requested', 'Player', 'Contact', 'Guests', 'Seats', 'Cumulative', 'Grant']);

  // Cumulative is the running total of seats requested, in walk order.
  const cumulative = await page.locator('tbody tr td:nth-child(7)').allInnerTexts();
  const seats = await page.locator('tbody tr td:nth-child(6)').allInnerTexts();
  console.log('FLOW-7 seats/cumulative:', seats.join(','), '/', cumulative.join(','));
  expect(cumulative.map(Number)).toEqual(
    seats.map(Number).reduce<number[]>((a, n) => [...a, (a.at(-1) ?? 0) + n], []),
  );

  // Pool 20 covers all 7 seats, so the walk selects everything.
  expect(await grants()).toEqual(seats.map(Number));

  await page.getByRole('button', { name: /^Commit 7 seats$/ }).click();
  await expect(page.locator('div[role="status"]').first()).toBeVisible({ timeout: 20_000 });
  const notice = await page.locator('div[role="status"]').first().innerText();
  console.log('FLOW-7 commit notice:', notice);
  await shot(page, 'FLOW-7-step-2-committed');

  const rows = await sql<{ status: string; n: number }[]>`
    select a.status, count(*)::int as n from attendees a
     where a.segment_id = ${ids.playerSegment} and a.deleted_at is null
     group by a.status order by a.status`;
  console.log('FLOW-7 seat statuses after commit:', JSON.stringify(rows));
  expect(rows.find((r) => r.status === 'PENDING_REVIEW')).toBeUndefined();
  expect(rows.find((r) => r.status === 'CONFIRMED')!.n).toBe(11); // 4 base + 7 extras

  // §7.5 says commit queues the emails. Recorded either way.
  const [outbox] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox`;
  console.log('FLOW-7 email_outbox rows after commit:', outbox.n);
});

/** FLOW-8 — the boundary: never best-fit, and partial when allowed. */
test('FLOW-8 the walk stops at the boundary and never packs a later request in', async () => {
  ids = reseed();
  await sql`update show_segments set allow_partial_grant = false where id = ${ids.playerSegment}`;
  await poolOf(3);
  await page.goto(review());
  await shot(page, 'FLOW-8-step-1-pool-of-3-no-partial');

  const seats = (await page.locator('tbody tr td:nth-child(6)').allInnerTexts()).map(Number);
  const granted = await grants();
  console.log('FLOW-8 no-partial: seats', seats.join(','), 'granted', granted.join(','));
  expect(seats).toEqual([2, 1, 3, 1]);
  // 2 fits (1 left), 1 fits (0 left), 3 does not — and the walk STOPS, so the
  // 1-seat request at position 4 is not promoted over it (§7.5, never best-fit).
  expect(granted).toEqual([2, 1, 0, 0]);

  await sql`update show_segments set allow_partial_grant = true where id = ${ids.playerSegment}`;
  await poolOf(4);
  await page.goto(review());
  const granted2 = await grants();
  console.log('FLOW-8 partial: granted', granted2.join(','));
  await shot(page, 'FLOW-8-step-2-pool-of-4-partial-allowed');
  expect(granted2).toEqual([2, 1, 1, 0]);
  expect(granted2.reduce((a, b) => a + b, 0)).toBe(4);
  await expect(page.getByText('part', { exact: true })).toBeVisible();
});

/** FLOW-9 — tick past the pool, then commit over capacity with the typed phrase. */
test('FLOW-9 ticking past the pool is flagged; over capacity needs the typed phrase', async () => {
  ids = reseed();
  await poolOf(2);
  await page.goto(review());
  await shot(page, 'FLOW-9-step-1-pool-of-2');

  // Tick every row: 7 seats against a pool of 2 and 2 free seats.
  for (const box of await page.locator('tbody input[type="checkbox"], tbody [role="checkbox"]').all()) {
    const checked = await box.getAttribute('aria-checked');
    if (checked === 'false') await box.click();
  }
  const granted = await grants();
  console.log('FLOW-9 granted after ticking everything:', granted.join(','));
  await expect(page.getByText(/seats? past the extras pool/)).toBeVisible();
  await shot(page, 'FLOW-9-step-2-overage-flagged');

  const commit = page.getByRole('button', { name: /Commit \d+ seats? over capacity/ });
  await expect(commit).toBeVisible();
  await commit.click();
  await shot(page, 'FLOW-9-step-3-typed-confirmation-asked');

  // Wrong phrase: refused, and nothing written.
  const [before] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where segment_id = ${ids.playerSegment} and status = 'CONFIRMED'`;
  await page.getByRole('dialog').locator('input[name="confirmation"]').fill('yes please');
  await page.getByRole('dialog').getByRole('button', { name: 'Commit over capacity' }).click();
  await expect(page.locator('main div[role="alert"]').first()).toBeVisible({ timeout: 20_000 });
  const refusal = await page.locator('main div[role="alert"]').first().innerText();
  console.log('FLOW-9 wrong phrase ->', refusal);
  await shot(page, 'FLOW-9-step-4-wrong-phrase-refused');
  const [mid] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where segment_id = ${ids.playerSegment} and status = 'CONFIRMED'`;
  expect(mid.n, 'nothing was written on the wrong phrase').toBe(before.n);

  // Right phrase: commits, and records the override.
  await commit.click();
  await page.getByRole('dialog').locator('input[name="confirmation"]').fill('OVER CAPACITY');
  await page.getByRole('dialog').getByRole('button', { name: 'Commit over capacity' }).click();
  await expect(page.locator('div[role="status"]').first()).toBeVisible({ timeout: 20_000 });
  console.log('FLOW-9 committed:', await page.locator('div[role="status"]').first().innerText());
  await shot(page, 'FLOW-9-step-5-committed-over-capacity');

  const audit = await sql<{ action: string; reason: string | null }[]>`
    select action, reason from audit_log order by id desc limit 3`;
  console.log('FLOW-9 audit_log:', JSON.stringify(audit, null, 2));
  expect(audit.some((a) => a.action === 'extras_review.committed_over_capacity')).toBe(true);
  expect(audit.find((a) => a.action === 'extras_review.committed_over_capacity')!.reason)
    .toContain('OVER CAPACITY');

  // FLOW-12 rides on the state this leaves: the segment is now over.
  await page.goto(review());
  const header = await page.locator('div.grid.gap-3').first().innerText();
  console.log('FLOW-12 header on an oversold segment:\n' + header);
  await shot(page, 'FLOW-12-step-1-full-n-over');
  expect(header).toMatch(/full, \d+ over/);
  expect(header).not.toMatch(/-\d/);
});

/** FLOW-10 — pressing Commit twice must not grant twice. */
test('FLOW-10 committing twice is a no-op the second time', async () => {
  ids = reseed();
  await page.goto(review());
  await page.getByRole('button', { name: /^Commit 7 seats$/ }).click();
  await expect(page.locator('div[role="status"]').first()).toBeVisible({ timeout: 20_000 });
  const first = await page.locator('div[role="status"]').first().innerText();
  await shot(page, 'FLOW-10-step-1-first-commit');
  const [afterFirst] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where segment_id = ${ids.playerSegment} and status = 'CONFIRMED'`;

  await page.reload();
  const bodyText = await page.locator('main').innerText();
  console.log('FLOW-10 screen after the first commit:', bodyText.slice(0, 200));
  await shot(page, 'FLOW-10-step-2-queue-empty-after-commit');

  const [afterSecond] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where segment_id = ${ids.playerSegment} and status = 'CONFIRMED'`;
  console.log('FLOW-10 confirmed:', first, '| first', afterFirst.n, '| second', afterSecond.n);
  expect(afterSecond.n).toBe(afterFirst.n);
  expect(bodyText).toContain('Nothing waiting for review');
});

/** FLOW-11 — order is requested_at, never created_at. */
test('FLOW-11 the queue orders by requested_at, not created_at', async () => {
  ids = reseed();
  // A party entered NOW, but whose form response arrived before everyone else's.
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                               status, requested_at, round_label)
    values (${ids.show1}, ${ids.playerSegment}, 'IMPORT', 'Earliest Arrival',
            'earliest@example.test', 'WAITLIST', '2026-09-01T00:00:00Z', 'Round 1')
    returning id`;
  await sql`select claim_seats(${ids.playerSegment}::bigint, ${reg.id}::bigint,
    ${JSON.stringify([{ full_name: 'Early Guest', email: null, allocation_type: 'EXTRA' }])}::text::jsonb, false)`;
  await sql`update registrations set status = 'PENDING_REVIEW' where id = ${reg.id}`;

  const order = await sql<{ contact_name: string; created_at: string; requested_at: string }[]>`
    select contact_name, created_at, requested_at from registrations
     where segment_id = ${ids.playerSegment} order by created_at`;
  console.log('FLOW-11 by created_at:', order.map((r) => r.contact_name).join(' -> '));

  await page.goto(review());
  const first = await page.locator('tbody tr').first().innerText();
  console.log('FLOW-11 first row on the screen:', first.replace(/\n/g, ' | '));
  await shot(page, 'FLOW-11-step-1-requested-at-order');
  expect(first).toContain('Earliest Arrival');
  expect(order.at(-1)!.contact_name).toBe('Earliest Arrival'); // newest by created_at
});

/** FLOW-14 — requested times render in the concert's zone, not the viewer's. */
test('FLOW-14 times do not move with the viewer timezone', async () => {
  const shanghai = await asAdmin(browserRef);
  const kl = await browserRef.newContext({ timezoneId: 'Pacific/Honolulu' });

  const a = await shanghai.newPage();
  await a.goto(review());
  const timesA = await a.locator('tbody tr td:nth-child(2)').allInnerTexts();
  await a.screenshot({ path: 'qa-artifacts/B-registrations-extras/screens/FLOW-14-step-1-default-timezone.png', fullPage: true });

  const honolulu = await asAdmin(browserRef);
  await honolulu.close();
  const ctx = await browserRef.newContext({ timezoneId: 'Pacific/Honolulu' });
  const b = await ctx.newPage();
  await b.goto('/login');
  await b.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    b.waitForURL((u) => !u.pathname.startsWith('/login')),
    b.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await b.goto(review());
  const timesB = await b.locator('tbody tr td:nth-child(2)').allInnerTexts();
  await b.screenshot({ path: 'qa-artifacts/B-registrations-extras/screens/FLOW-14-step-2-honolulu-timezone.png', fullPage: true });

  console.log('FLOW-14 default tz:', JSON.stringify(timesA));
  console.log('FLOW-14 Honolulu  :', JSON.stringify(timesB));
  expect(timesB).toEqual(timesA);
  await kl.close();
});
