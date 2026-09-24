/**
 * QA reviewer's flows for module `M` (qa-artifacts/M-registration-surface/02-flows.md).
 * Written from `docs/spec/` before the implementation was read.
 * Every step asserts, then screenshots.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const seed = JSON.parse(readFileSync('qa-artifacts/m-registration/seed.json', 'utf8')) as {
  concertId: number;
  publicSegmentId: number;
  playerSegmentId: number;
  fullSegmentId: number;
  publicFormId: number;
  playerToken: string;
};

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 1 },
);
test.afterAll(async () => {
  await sql.end();
});

const SHOTS = 'qa-artifacts/M-registration-surface/screens';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true });
const field = (page: Page, path: string) => page.locator(`[id="${path}"]`);
const RUN = Date.now().toString(36);
const addr = (local: string) => `qa-${local}-${RUN}@example.com`;

async function fillRegistrant(page: Page, name: string, email: string) {
  await field(page, 'registrant.contact_name').fill(name);
  await field(page, 'registrant.contact_email').fill(email);
}
async function partyOf(email: string) {
  return sql<{ full_name: string; status: string; allocation_type: string; name_source: string }[]>`
    select a.full_name, a.status::text, a.allocation_type::text, a.name_source::text
      from attendees a join registrations r on r.id = a.registration_id
     where r.contact_email = ${email} and a.deleted_at is null order by a.id`;
}

/* ------------------------------------------------------------------ FLOW-1 */
test.describe('FLOW-1 public registrant registers a party of 3 (phone viewport)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('submits, and the database agrees with the screen', async ({ page }) => {
    const email = addr('flow1');
    await page.goto('/f/qa-public');
    // Step 1 — the form, single column, seat indicator present.
    await expect(page.getByRole('button', { name: 'Submit registration' })).toBeVisible();
    await shot(page, 'FLOW-1-step-1-form.png');

    // Step 2 — registrant is seat #1: the repeater renders cap-1 = 3 rows max.
    await fillRegistrant(page, 'Alice Tan', email);
    await page.getByRole('button', { name: 'Add a guest' }).click();
    await field(page, 'party.0.full_name').fill('Bob Tan');
    await field(page, 'party.1.full_name').fill('Cara Tan');
    await shot(page, 'FLOW-1-step-2-filled.png');

    // Step 3 — submit.
    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText('3 seats confirmed')).toBeVisible();
    await shot(page, 'FLOW-1-step-3-confirmation.png');

    // Step 4 — the database.
    const party = await partyOf(email);
    expect(party.map((r) => r.full_name)).toEqual(['Alice Tan', 'Bob Tan', 'Cara Tan']);
    expect(party.every((r) => r.allocation_type === 'EXTRA')).toBe(true);
    expect(party.every((r) => r.name_source === 'PROVIDED')).toBe(true);

    const [reg] = await sql<{ status: string; verified: boolean; has_token: boolean }[]>`
      select status::text, email_verified_at is not null as verified,
             verification_token is not null as has_token
        from registrations where contact_email = ${email}`;
    expect(reg.status).toBe('CONFIRMED');
    expect(reg.verified).toBe(false);
    expect(reg.has_token).toBe(true);

    const outbox = await sql<{ template_key: string; status: string; registration_id: number }[]>`
      select o.template_key, o.status::text, o.registration_id from email_outbox o
        join registrations r on r.id = o.registration_id
       where r.contact_email = ${email}`;
    expect(outbox.map((o) => o.template_key)).toEqual(['public_verify']);
    expect(outbox[0].status).toBe('DRAFT');
    expect(outbox[0].registration_id).not.toBeNull();
  });
});

/* --------------------------------------------------------- FLOW-2 / FLOW-3 */
test('FLOW-2 + FLOW-3 verification link, then clicked again', async ({ page }) => {
  const email = addr('flow2');
  await page.goto('/f/qa-public');
  await fillRegistrant(page, 'Vera Tan', email);
  await page.getByRole('button', { name: 'Submit registration' }).click();
  await expect(page.getByText('Registration received')).toBeVisible();

  const [row] = await sql<{ verification_token: string }[]>`
    select verification_token from registrations where contact_email = ${email}`;

  await page.goto(`/f/verify?t=${row.verification_token}`);
  await expect(page.getByText(/your email is confirmed/i)).toBeVisible();
  await shot(page, 'FLOW-2-step-1-verified.png');
  const [after] = await sql<{ verified: boolean }[]>`
    select email_verified_at is not null as verified from registrations where contact_email = ${email}`;
  expect(after.verified).toBe(true);

  // FLOW-3 — a second click is harmless, and drafts no second message.
  await page.goto(`/f/verify?t=${row.verification_token}`);
  await expect(page.getByText(/already confirmed/i)).toBeVisible();
  await shot(page, 'FLOW-3-step-1-already.png');
  const outbox = await sql<{ n: number }[]>`
    select count(*)::int as n from email_outbox o join registrations r on r.id = o.registration_id
     where r.contact_email = ${email}`;
  expect(outbox[0].n).toBe(1);
});

/* ------------------------------------------------------------------ FLOW-4 */
test('FLOW-4 a bad or absent verification token is refused without a stack trace', async ({ page }) => {
  for (const [n, url] of [['a', '/f/verify?t=deadbeefdeadbeef'], ['b', '/f/verify']] as const) {
    const response = await page.goto(url);
    expect(response?.status()).toBe(200);
    await expect(page.getByText(/not available/i).first()).toBeVisible();
    const visible = await page.locator('body').innerText();
    expect(visible).not.toMatch(/at Object\.|PostgresError|Internal Server Error|\bstack\b/i);
    await shot(page, `FLOW-4-step-1${n}-refused.png`);
  }
});

/* ------------------------------------------------------------------ FLOW-5 */
test('FLOW-5 a blank guest name is refused and writes nothing', async ({ page }) => {
  const email = addr('flow5');
  await page.goto('/f/qa-public');
  await fillRegistrant(page, 'Blank Tan', email);
  await page.getByRole('button', { name: 'Add a guest' }).click();
  await field(page, 'party.0.full_name').fill('   ');
  await field(page, 'party.1.full_name').fill('Real Guest');
  await shot(page, 'FLOW-5-step-1-blank-row.png');
  await page.getByRole('button', { name: 'Submit registration' }).click();
  await page.waitForURL(/\/done\?r=|\/f\/qa-public/, { timeout: 15_000 });
  await shot(page, 'FLOW-5-step-2-outcome.png');
  const party = await partyOf(email);
  // A whitespace-only row is not a person. It must never become a seat, and
  // never a PLACEHOLDER name on a form we control (v2.md §8.1.3, §8.2.1).
  expect(party.map((r) => r.full_name)).toEqual(['Blank Tan', 'Real Guest']);
  expect(party.every((r) => r.name_source === 'PROVIDED')).toBe(true);
});

/* ------------------------------------------------------------------ FLOW-6 */
test('FLOW-6 the public repeater stops at cap - 1 rows (decision 36)', async ({ page }) => {
  await page.goto('/f/qa-public');
  const add = page.getByRole('button', { name: 'Add a guest' });
  // cap = 4, one seat is the registrant, so 3 guest rows and no more.
  for (let i = 0; i < 6; i++) {
    if (await add.isDisabled().catch(() => true)) break;
    await add.click();
  }
  await expect(add).toBeDisabled();
  const rows = await page.locator('[id^="party."][id$=".full_name"]').count();
  await shot(page, 'FLOW-6-step-1-cap.png');
  expect(rows).toBe(3);
});

/* ------------------------------------------------------------------ FLOW-7 */
test('FLOW-7 a full segment says so rather than offering a form', async ({ page }) => {
  await page.goto('/f/qa-full');
  await expect(page.getByRole('button', { name: 'Submit registration' })).toHaveCount(0);
  await shot(page, 'FLOW-7-step-1-full.png');
  await expect(page.getByText(/full/i).first()).toBeVisible();
});

/* ------------------------------------------------------------------ FLOW-8 */
test('FLOW-8 a closed form renders no fields', async ({ page }) => {
  await page.goto('/f/qa-closed');
  await expect(page.getByRole('button', { name: 'Submit registration' })).toHaveCount(0);
  expect(await page.locator('[id="registrant.contact_email"]').count()).toBe(0);
  await shot(page, 'FLOW-8-step-1-closed.png');
});

/* ------------------------------------------------------ FLOW-9 and FLOW-10 */
test('FLOW-9 player claims base and extra; FLOW-10 the base repeater shows what is left', async ({ page }) => {
  await page.goto(`/f/qa-player?k=${seed.playerToken}`);
  await expect(field(page, 'registrant.contact_name')).toHaveValue('Vera Player');
  // The repeater grows on demand; what matters is the ceiling it stops at.
  const addBase = page.getByRole('button', { name: /Add a base seat|Add a seat|Add a guest/ }).first();
  for (let i = 0; i < 6; i++) {
    if (await addBase.isDisabled().catch(() => true)) break;
    await addBase.click();
  }
  const baseRowsBefore = await page.locator('[id^="base."][id$=".full_name"]').count();
  await shot(page, 'FLOW-9-step-1-prefilled.png');
  console.log('FLOW-9 base rows offered:', baseRowsBefore);
  expect(baseRowsBefore).toBe(2); // base_quota 2, nothing claimed yet

  await field(page, 'base.0.full_name').fill('Base Guest One');
  await page.getByRole('button', { name: 'Submit registration' }).click();
  await expect(page.getByText('Registration received')).toBeVisible();
  await shot(page, 'FLOW-9-step-2-confirmation.png');

  const party = await sql<{ full_name: string; allocation_type: string }[]>`
    select a.full_name, a.allocation_type::text from attendees a
      join registrations r on r.id = a.registration_id
     where r.player_id is not null and a.deleted_at is null order by a.id`;
  expect(party.find((r) => r.full_name === 'Base Guest One')?.allocation_type).toBe('BASE');
  // The player is not a seat (decision 3).
  expect(party.some((r) => r.full_name === 'Vera Player')).toBe(false);

  // §8.1.4 — player forms do not verify.
  const [reg] = await sql<{ has_token: boolean }[]>`
    select verification_token is not null as has_token from registrations
     where player_id is not null order by id desc limit 1`;
  expect(reg.has_token).toBe(false);

  // FLOW-10 — coming back, the base repeater offers only what is left.
  await page.goto(`/f/qa-player?k=${seed.playerToken}`);
  const addBase2 = page.getByRole('button', { name: /Add a base seat|Add a seat|Add a guest/ }).first();
  for (let i = 0; i < 6; i++) {
    if (await addBase2.isDisabled().catch(() => true)) break;
    await addBase2.click();
  }
  const baseRowsAfter = await page.locator('[id^="base."][id$=".full_name"]').count();
  console.log('FLOW-10 base rows offered after claiming 1 of 2:', baseRowsAfter);
  await shot(page, 'FLOW-10-step-1-remaining.png');
  expect(baseRowsAfter).toBe(1);
});

/* ----------------------------------------------------------------- FLOW-11 */
test('FLOW-11 an unknown player token reveals no player data', async ({ page }) => {
  await page.goto('/f/qa-player?k=not-a-real-token');
  await expect(page.getByText(/did not recognise/i)).toBeVisible();
  const body = await page.content();
  expect(body).not.toContain('Vera Player');
  await shot(page, 'FLOW-11-step-1-unknown-token.png');
});

/* -------------------------------------------------- FLOW-15 and FLOW-16 */
test('FLOW-15 no add control on the edit screen; FLOW-16 extras go to the back of the queue', async ({ page }) => {
  const email = addr('flow15');
  await page.goto('/f/qa-public');
  await fillRegistrant(page, 'Editor Tan', email);
  await page.getByRole('button', { name: 'Submit registration' }).click();
  await expect(page.getByText('Registration received')).toBeVisible();

  const [response] = await sql<{ edit_token: string }[]>`
    select fr.edit_token from form_responses fr join registrations r on r.form_response_id = fr.id
     where r.contact_email = ${email}`;
  await page.goto(`/f/qa-public/edit?r=${response.edit_token}`);
  await expect(page.getByRole('heading', { name: 'Change your registration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a guest' })).toHaveCount(0);
  await shot(page, 'FLOW-15-step-1-no-add-control.png');

  // FLOW-16 — request extras: a NEW registration with a NEW requested_at.
  const [before] = await sql<{ requested_at: string }[]>`
    select requested_at::text from registrations where contact_email = ${email}`;
  await page.getByRole('button', { name: 'Add a name' }).click();
  await page.getByLabel('Extra guest 1').fill('Latecomer Tan');
  await page.getByRole('button', { name: /Request 1 extra seat/ }).click();
  await expect(page.getByText(/extra seat/i).first()).toBeVisible();
  await shot(page, 'FLOW-16-step-1-requested.png');

  const regs = await sql<{ id: number; requested_at: string }[]>`
    select id, requested_at::text from registrations where contact_email = ${email} order by id`;
  expect(regs.length).toBe(2);
  expect(new Date(regs[1].requested_at).getTime()).toBeGreaterThan(new Date(before.requested_at).getTime());
});

/* ----------------------------------------------------------------- FLOW-18 */
test('FLOW-18 a wrong edit token renders nothing about anybody', async ({ page }) => {
  const response = await page.goto('/f/qa-public/edit?r=nosuchtoken');
  expect(response?.status()).toBe(200);
  await expect(page.getByText(/not available/i).first()).toBeVisible();
  await shot(page, 'FLOW-18-step-1-refused.png');
});

/* ----------------------------------------------------------------- FLOW-20 */
test('FLOW-20 anonymous is refused the unverified admin screen', async ({ page }) => {
  await page.goto(`/admin/concerts/${seed.concertId}/registrations/unverified`);
  await expect(page).toHaveURL(/\/login/);
  const body = await page.content();
  expect(body).not.toMatch(/@example\.com/);
  await shot(page, 'FLOW-20-step-1-anonymous-refused.png');
});

test('FLOW-20b an OPERATOR is refused the unverified admin screen', async ({ page }) => {
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill('Wei Ling');
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 30_000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await shot(page, 'FLOW-20b-step-1-operator-signed-in.png');

  await page.goto(`/admin/concerts/${seed.concertId}/registrations/unverified`);
  await shot(page, 'FLOW-20b-step-2-refused.png');
  expect(page.url()).not.toContain('/registrations/unverified');
  const body = await page.content();
  expect(body).not.toMatch(/Unverified registrations/);
  expect(body).not.toMatch(/@example\.com/);
});

/* ----------------------------------------------------------------- FLOW-19 */
test('FLOW-19 admin sees only registrations past the grace window', async ({ page }) => {
  // One old unverified party, one fresh one.
  const oldEmail = addr('stale');
  const [seg] = await sql<{ id: number; show_id: number }[]>`
    select id, show_id from show_segments where id = ${seed.publicSegmentId}`;
  await sql`
    insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                               status, requested_at, verification_token)
    values (${seg.show_id}, ${seg.id}, 'FORM', 'Stale Tan', ${oldEmail}, 'CONFIRMED',
            now() - interval '100 hours', 'stale-token-for-qa')`;

  await page.goto('/login');
  expect(await page.locator('input[type="email"]').count()).toBe(0);
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await shot(page, 'FLOW-19-step-1-admin-signed-in.png');

  await page.goto(`/admin/concerts/${seed.concertId}`);
  await page.goto(`/admin/concerts/${seed.concertId}/registrations/unverified`);
  console.log('FLOW-19 url:', page.url());
  console.log('FLOW-19 body:', (await page.locator('body').innerText()).slice(0, 400));
  await expect(page.getByRole('heading', { name: 'Unverified registrations' })).toBeVisible();
  await expect(page.getByText('Stale Tan')).toBeVisible();
  await shot(page, 'FLOW-19-step-2-list.png');
});

/* ----------------------------------------------------------------- FLOW-21 */
test('FLOW-21 the confirmation renders show times in concert.timezone, not the viewer zone', async ({ browser }) => {
  const shown: string[] = [];
  for (const [n, tz] of [['a', 'Asia/Singapore'], ['b', 'America/New_York']] as const) {
    const context = await browser.newContext({ timezoneId: tz });
    const page = await context.newPage();
    const email = addr(`tz-${n}`);
    await page.goto('/f/qa-public');
    await field(page, 'registrant.contact_name').fill(`Zone ${n}`);
    await field(page, 'registrant.contact_email').fill(email);
    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText('Registration received')).toBeVisible();
    const text = await page.locator('body').innerText();
    const match = text.match(/\b\d{1,2}[:.]\d{2}\s?(am|pm|AM|PM)?\b/);
    shown.push(match ? match[0] : 'NONE');
    await shot(page, `FLOW-21-step-1${n}-${tz.replace('/', '-')}.png`);
    await context.close();
  }
  console.log('FLOW-21 confirmation times:', shown);
  expect(shown[0]).not.toBe('NONE');
  expect(shown[0]).toBe(shown[1]);
});

/* ----------------------------------------------------------------- FLOW-22 */
test('FLOW-22 an unknown slug is handled, not a 500', async ({ page }) => {
  const response = await page.goto('/f/no-such-form-at-all');
  expect(response?.status()).toBe(200);
  await expect(page.getByText(/not available/i).first()).toBeVisible();
  await shot(page, 'FLOW-22-step-1-unknown-slug.png');
});

/* ------------------------------------------- the seat indicator (AC-17/18) */
test('AC-17/18 the indicator shows an exact figure above the threshold and a band below', async ({ page }) => {
  await page.goto('/f/qa-public');
  const bodyA = await page.locator('body').innerText();
  await shot(page, 'AC-18-step-1-exact.png');
  expect(bodyA).toMatch(/\d+ seats? left/);

  // Drop the pool below form.seat_indicator_exact_below (seeded at 5).
  await sql`update show_segments set capacity = (
      select count(*)::int + 3 from attendees a where a.segment_id = ${seed.publicSegmentId}
        and a.status = 'CONFIRMED' and a.deleted_at is null)
    where id = ${seed.publicSegmentId}`;
  await page.goto('/f/qa-public');
  const bodyB = await page.locator('body').innerText();
  await shot(page, 'AC-17-step-1-band.png');
  console.log('AC-17 body indicator:', bodyB.match(/(Only a few seats left|\d+ seats? left)/)?.[0]);
  expect(bodyB).toMatch(/Only a few seats left/);
  expect(bodyB).not.toMatch(/\b3 seats left\b/);
});
