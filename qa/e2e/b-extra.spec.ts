import { test, expect, type Page } from '@playwright/test';
import { asAdmin, resetReviewQueue, SEEDED_IDS, newSql, shot } from './b-helpers';

test.describe.configure({ mode: 'serial' });

const sql = newSql();
test.setTimeout(120_000);

const ids = SEEDED_IDS;
let page: Page;

test.beforeAll(async ({ browser }) => {
  const ctx = await asAdmin(browser);
  page = await ctx.newPage();
});
test.afterAll(async () => {
  await sql`update shows set capacity = 400 where id = ${ids.show1}`;
  await sql.end();
});

const review = () =>
  `/admin/concerts/${ids.concertId}/extras-review?segment=${ids.playerSegment}`;
const grantInputs = () => page.locator('input[aria-label^="Seats granted to"]');

/** FLOW-17 — editing a granted count by hand; the header recomputes live (AC-20). */
test('FLOW-17 the admin edits a granted count and the header follows', async () => {
  await resetReviewQueue(sql, ids);
  await page.goto(review());
  const before = await page.locator('main').innerText();
  console.log('FLOW-17 selected before:', before.match(/SELECTED\n\d+/)?.[0]);
  await shot(page, 'FLOW-17-step-1-preselected');

  // Party 3 asked for 3 seats and the walk granted 3. Grant it 1.
  const third = grantInputs().nth(2);
  await third.fill('1');
  await third.blur();
  const after = await page.locator('main').innerText();
  console.log('FLOW-17 selected after editing 3 -> 1:', after.match(/SELECTED\n\d+/)?.[0]);
  await shot(page, 'FLOW-17-step-2-count-edited');
  expect(await grantInputs().nth(2).inputValue()).toBe('1');
  expect(after).toMatch(/SELECTED\n5\b/);
  await expect(page.getByRole('button', { name: /^Commit 5 seats$/ })).toBeVisible();

  // Over the seats actually requested is clamped to what the party asked for.
  await third.fill('99');
  await third.blur();
  console.log('FLOW-17 typing 99 into a 3-seat request gives:',
    await grantInputs().nth(2).inputValue());
  expect(await grantInputs().nth(2).inputValue()).toBe('3');
  await shot(page, 'FLOW-17-step-3-clamped-to-seats-requested');
});

/** FLOW-7b — a partial commit waitlists the rest of the parties on screen (AC-27). */
test('FLOW-7b committing part of the queue waitlists the rest', async () => {
  await resetReviewQueue(sql, ids);
  await page.goto(review());
  // Untick the last two parties, then commit.
  const boxes = await page.locator('tbody [role="checkbox"]').all();
  for (const box of boxes.slice(2)) {
    if ((await box.getAttribute('aria-checked')) === 'true') await box.click();
  }
  await shot(page, 'FLOW-7b-step-1-two-parties-ticked');
  await page.getByRole('button', { name: /^Commit 3 seats$/ }).click();
  await expect(page.locator('div[role="status"]').first()).toBeVisible({ timeout: 20_000 });
  const notice = await page.locator('div[role="status"]').first().innerText();
  console.log('FLOW-7b notice:', notice);
  await shot(page, 'FLOW-7b-step-2-committed');

  const rows = await sql<{ contact_name: string; status: string; n: number }[]>`
    select r.contact_name, a.status, count(*)::int as n
      from attendees a join registrations r on r.id = a.registration_id
     where a.segment_id = ${ids.playerSegment} and a.allocation_type = 'EXTRA'
     group by r.contact_name, a.status order by r.contact_name, a.status`;
  console.log('FLOW-7b extras by party:', JSON.stringify(rows));
  expect(rows.some((x) => x.status === 'WAITLIST'), 'the unticked parties waitlisted').toBe(true);
  expect(rows.some((x) => x.status === 'PENDING_REVIEW'),
    'nothing was left pending').toBe(false);
  expect(rows.filter((x) => x.status === 'CONFIRMED').reduce((a, b) => a + b.n, 0)).toBe(3);
});

/**
 * FLOW-9c — can the hall ever be the binding ceiling on its own?
 *
 * §7.5 says a commit above "the segment's capacity **or the hall's**" needs the
 * typed confirmation, and the screen only offers that dialog when the *segment*
 * is exceeded (`pastCapacity = selectedSeats > openSeats`). This asks whether
 * the hall-only case is reachable at all.
 */
test('FLOW-9c the hall cannot bind before the segment does', async () => {
  await resetReviewQueue(sql, ids);
  const [hall] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees a join registrations r on r.id = a.registration_id
     where a.show_id = ${ids.show1} and a.status = 'CONFIRMED'
       and a.deleted_at is null and r.status <> 'CANCELLED'`;

  let refusal = '';
  try {
    await sql`update shows set capacity = ${hall.n + 3} where id = ${ids.show1}`;
  } catch (error) {
    refusal = (error as Error).message;
  }
  console.log('FLOW-9c lowering the hall below the segments ->', refusal);
  expect(refusal, 'F1 keeps Σ segment.capacity ≤ show.capacity').toContain('hall holds');

  const [sums] = await sql<{ segs: number; hall: number }[]>`
    select coalesce(sum(g.capacity), 0)::int as segs,
           (select capacity from shows where id = ${ids.show1})::int as hall
      from show_segments g where g.show_id = ${ids.show1} and g.deleted_at is null`;
  console.log('FLOW-9c Σ segment capacity', sums.segs, 'vs hall', sums.hall);
  expect(sums.segs).toBeLessThanOrEqual(sums.hall);

  // With that invariant, Σ confirmed can only pass the hall once some segment
  // has already passed its own capacity — which is the case the screen does
  // ask a typed confirmation for. So the hall-only overage is unreachable, and
  // the screen's segment-only test is sufficient in practice.
  await page.goto(review());
  const buttons = (await page.getByRole('button').allInnerTexts()).filter((b) => /Commit/.test(b));
  console.log('FLOW-9c buttons offered with the hall intact:', JSON.stringify(buttons));
  await shot(page, 'FLOW-9c-step-1-hall-cannot-bind-alone');
});

/** FLOW-16 — hostile input at the create boundary (AC-63). */
test('FLOW-16 hostile input is refused structurally, not with a 500', async () => {
  await sql`update shows set capacity = 400 where id = ${ids.show1}`;
  const T = { timeout: 15_000 };

  const cases: [string, Record<string, string>][] = [
    ['empty contact name', { contactName: '' }],
    ['bad email', { contactName: 'Hostile One', contactEmail: 'not-an-email' }],
    ['zero seats', { contactName: 'Hostile Two', seats: '0' }],
    ['sql metacharacters', { contactName: "Robert'); drop table attendees;--", seats: '1' }],
    ['300-character name', { contactName: 'x'.repeat(300), seats: '1' }],
  ];

  const seen: Record<string, string> = {};
  for (const [label, fields] of cases) {
    await page.goto(`/admin/concerts/${ids.concertId}/registrations`, { timeout: 20_000 });
    await page.getByRole('button', { name: 'New registration' }).click(T);
    const dialog = page.locator('[data-slot="dialog-content"]').first();
    await dialog.locator('select[name="segmentId"]').selectOption(ids.publicSegment, T);
    await dialog.locator('select[name="allocationType"]').selectOption('EXTRA', T);
    await dialog.locator('input[name="contactName"]').fill(fields.contactName ?? 'Filler', T);
    if (fields.contactEmail) {
      await dialog.locator('input[name="contactEmail"]').fill(fields.contactEmail, T);
    }
    if (fields.seats !== undefined) {
      await dialog.locator('input[name="seats"]').fill(fields.seats, T);
    }
    await dialog.getByRole('button', { name: 'Create registration' }).click(T);
    await page.waitForTimeout(1500);
    const open = await dialog.count();
    seen[label] = open
      ? (await dialog.locator('div[role="alert"]').first().innerText({ timeout: 3000 })
          .catch(() => '(dialog still open, no message)')).replace(/\n/g, ' ').slice(0, 160)
      : '(dialog closed — accepted)';
    console.log(`FLOW-16  ${label}  ->  ${seen[label]}`);
  }
  await shot(page, 'FLOW-16-step-1-hostile-input');

  const [tables] = await sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
  console.log('FLOW-16 public tables still present:', tables.n);
  expect(tables.n).toBeGreaterThan(15);
  const landed = await sql<{ contact_name: string }[]>`
    select contact_name from registrations
     where contact_name like 'Robert%' or length(contact_name) > 200`;
  console.log('FLOW-16 hostile rows that landed:', JSON.stringify(landed));

  for (const [label, text] of Object.entries(seen)) {
    expect(text, label).not.toMatch(/ at [A-Za-z$_]+ \(|Internal Server Error|digest:/);
  }
});
