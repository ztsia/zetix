import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Module `M` — the public registration surface, end to end.
 *
 * **`K` deferred these specs to this branch deliberately.** It drove its
 * renderer on a temporary `/qa-harness` page, deleted it, and left a note that
 * shipping the real `/f/{slug}` is the moment to write them — because a
 * permanently-red spec is worse than none, and a `/qa-harness` route in a public
 * route group would be an unauthenticated page rendering arbitrary forms.
 *
 * Every flow here **reads the database back**. A page that renders and a page
 * that writes correctly are different claims, and this module's whole job is the
 * second one: seats through `claim_seats()`, a receipt in `form_responses`, and
 * a verification gate that decides whether anyone gets a ticket.
 *
 * Run `qa/support/start-m.sh` first.
 */

const seed = JSON.parse(
  readFileSync('qa-artifacts/m-registration/seed.json', 'utf8'),
) as {
  publicSegmentId: number;
  playerSegmentId: number;
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

/**
 * Controls are addressed by their **field id**, not their label.
 *
 * `K`'s renderer ids every control `<blockId>.<fieldKey>` — the same path
 * `validateAnswers` keys its errors by — which makes it the one stable handle on
 * this surface. The visible label carries a required marker (`Full name*`), so
 * an exact label match never matches and a loose one would quietly match the
 * wrong control the day a form adds a similarly-named question.
 */
const field = (page: Page, path: string) => page.locator(`[id="${path}"]`);

/**
 * A fresh address per run.
 *
 * `zetix_qa` is recreated by `scripts/qa-db.sh` but **not** between runs of this
 * spec, and these flows write real registrations. A fixed address means the
 * second run asserts against the first run's rows — which is how
 * "expected 0, received 1" showed up here rather than as a bug in the code.
 */
const RUN = Date.now().toString(36);
const addr = (local: string) => `${local}-${RUN}@example.com`;

/**
 * **Fixture addresses use `example.com`, not `example.test`.**
 *
 * `.test` is a reserved TLD that resolves nowhere, so the submit path's address
 * check refuses it — correctly, and on the first attempt every time. Using it
 * here would mean every happy-path flow silently testing the *warning* path.
 * `example.com` is IANA-reserved and answers, so it exercises the real check
 * rather than dodging it; and if DNS is unreachable the check fails open, so
 * these flows pass either way.
 */

async function fillRegistrant(page: Page, name: string, email: string) {
  await field(page, 'registrant.contact_name').fill(name);
  await field(page, 'registrant.contact_email').fill(email);
}

async function partyOf(email: string) {
  return sql<{ full_name: string; status: string; allocation_type: string }[]>`
    select a.full_name, a.status::text, a.allocation_type::text
      from attendees a join registrations r on r.id = a.registration_id
     where r.contact_email = ${email} and a.deleted_at is null
     order by a.id
  `;
}

test.describe('the public form', () => {
  test('a solo registrant can submit without touching the guest rows', async ({ page }) => {
    /**
     * **The regression this test exists for.** `emptyAnswers` seeds every
     * repeater with one row, so the default state of a public form is one blank
     * guest — and a required guest name made that unsubmittable. Somebody
     * registering alone is the most ordinary thing this form does.
     */
    await page.goto('/f/qa-public');
    await fillRegistrant(page, 'Solo Tan', addr('solo'));
    await page.getByRole('button', { name: 'Submit registration' }).click();

    await expect(page.getByText('Registration received')).toBeVisible();
    expect(await partyOf(addr('solo'))).toEqual([
      { full_name: 'Solo Tan', status: 'CONFIRMED', allocation_type: 'EXTRA' },
    ]);
  });

  test('the registrant is seat #1 alongside their guests', async ({ page }) => {
    await page.goto('/f/qa-public');
    await fillRegistrant(page, 'Alice Tan', addr('alice'));
    await page.getByRole('button', { name: 'Add a guest' }).click();
    await field(page, 'party.0.full_name').fill('Bob Tan');
    await field(page, 'party.1.full_name').fill('Cara Tan');
    await page.getByRole('button', { name: 'Submit registration' }).click();

    await expect(page.getByText('3 seats confirmed')).toBeVisible();
    const party = await partyOf(addr('alice'));
    expect(party.map((row) => row.full_name)).toEqual(['Alice Tan', 'Bob Tan', 'Cara Tan']);
    // §8.1.2 — a PUBLIC segment has no base, and no new allocation type exists.
    expect(party.every((row) => row.allocation_type === 'EXTRA')).toBe(true);
  });

  test('a registration is written with its receipt and verification token', async ({ page }) => {
    await page.goto('/f/qa-public');
    await fillRegistrant(page, 'Receipt Tan', addr('receipt'));
    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText('Registration received')).toBeVisible();

    const [row] = await sql<
      { source: string; has_token: boolean; verified: boolean; raw_kept: boolean }[]
    >`
      select r.source::text,
             r.verification_token is not null as has_token,
             r.email_verified_at is not null as verified,
             fr.raw is not null as raw_kept
        from registrations r join form_responses fr on fr.id = r.form_response_id
       where r.contact_email = ${addr('receipt')}
    `;
    expect(row.source).toBe('FORM');
    // Public form → gated. The seat is confirmed regardless (§8.1.4).
    expect(row.has_token).toBe(true);
    expect(row.verified).toBe(false);
    expect(row.raw_kept).toBe(true);
  });

  test('a bad address is warned about once and accepted on the retry', async ({ page }) => {
    await page.goto('/f/qa-public');
    const typoAddress = `typo-${RUN}@gmail.con`;
    await fillRegistrant(page, 'Typo Tan', typoAddress);

    // The typo nudge is live, before anything is submitted.
    await expect(page.getByText('Did you mean gmail.com?')).toBeVisible();

    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText(/could not find the mail server/i)).toBeVisible();
    expect(await partyOf(typoAddress)).toHaveLength(0);

    // Submitting again goes through: nobody is locked out of a scarce seat by a
    // DNS answer.
    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText('Registration received')).toBeVisible();
    expect(await partyOf(typoAddress)).toHaveLength(1);
  });

  test('the typo suggestion can be applied in one click', async ({ page }) => {
    await page.goto('/f/qa-public');
    await fillRegistrant(page, 'Fix Tan', `fix-${RUN}@gmial.com`);
    await page.getByRole('button', { name: 'Use gmail.com' }).click();
    await expect(field(page, 'registrant.contact_email')).toHaveValue(`fix-${RUN}@gmail.com`);
  });
});

test.describe('the player form', () => {
  test('prefills from the token and books base and extra separately', async ({ page }) => {
    await page.goto(`/f/qa-player?k=${seed.playerToken}`);
    await expect(field(page, 'registrant.contact_name')).toHaveValue('Vera Player');

    // Both repeaters already show one row: `emptyAnswers` seeds one wherever
    // the cap has room, so there is no add button to press for the first seat.
    await field(page, 'base.0.full_name').fill('Base Guest');
    await field(page, 'extras.0.full_name').fill('Extra Guest');
    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText('Registration received')).toBeVisible();

    const party = await partyOf('vera@example.com');
    expect(party.find((r) => r.full_name === 'Base Guest')?.allocation_type).toBe('BASE');
    expect(party.find((r) => r.full_name === 'Extra Guest')?.allocation_type).toBe('EXTRA');
    // A player is a performer, not audience (decision 3).
    expect(party.some((r) => r.full_name === 'Vera Player')).toBe(false);
  });

  test('an unrecognised token still lets someone register', async ({ page }) => {
    await page.goto('/f/qa-player?k=not-a-real-token');
    await expect(page.getByText('We did not recognise that link')).toBeVisible();
    // And the form beneath it is still usable — a mistyped link is not a dead end.
    await expect(page.getByRole('button', { name: 'Submit registration' })).toBeVisible();
  });
});

test.describe('the states that are not a form', () => {
  test('a closed form says so', async ({ page }) => {
    await page.goto('/f/qa-closed');
    // `.first()`: the heading and the body both say it, and a strict locator
    // matching two elements is a failing test rather than a passing one.
    await expect(page.getByText(/has closed/i).first()).toBeVisible();
  });

  test('a full segment says so rather than offering a form', async ({ page }) => {
    await page.goto('/f/qa-full');
    await expect(page.getByText(/is full/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit registration' })).toHaveCount(0);
  });

  /**
   * **A 500 here was a real bug**, found by loading the page rather than by any
   * test: `segment_pool()` raises its own refusal for a segment with no
   * capacity, separately from the repeater caps `loadFormBySlug` checks, and
   * this page turned that raise into a stack trace on a public URL.
   */
  test('a segment configured with nothing refuses instead of crashing', async ({ page }) => {
    const response = await page.goto('/f/qa-unset');
    expect(response?.status()).toBe(200);
    await expect(page.getByText(/not open yet/i).first()).toBeVisible();
  });

  test('an unknown slug is not found, and does not say why', async ({ page }) => {
    const response = await page.goto('/f/no-such-form');
    expect(response?.status()).toBe(200);
    await expect(page.getByText(/not available/i).first()).toBeVisible();
  });
});

test.describe('verification', () => {
  test('the link confirms the address and says the seats were never at stake', async ({ page }) => {
    await page.goto('/f/qa-public');
    await fillRegistrant(page, 'Verify Tan', addr('verify'));
    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText('Registration received')).toBeVisible();

    const [row] = await sql<{ verification_token: string }[]>`
      select verification_token from registrations where contact_email = ${addr('verify')}
    `;
    await page.goto(`/f/verify?t=${row.verification_token}`);
    await expect(page.getByText(/your email is confirmed/i)).toBeVisible();
    await expect(page.getByText(/seats were confirmed when you registered/i)).toBeVisible();

    const [after] = await sql<{ verified: boolean }[]>`
      select email_verified_at is not null as verified from registrations
       where contact_email = ${addr('verify')}
    `;
    expect(after.verified).toBe(true);

    // Clicking twice is not an error — people forward the mail to themselves.
    await page.goto(`/f/verify?t=${row.verification_token}`);
    await expect(page.getByText(/already confirmed/i)).toBeVisible();
  });

  test('a junk token gets the same answer as an unknown form', async ({ page }) => {
    await page.goto('/f/verify?t=not-a-token');
    await expect(page.getByText(/not available/i).first()).toBeVisible();
  });
});

test.describe('editing a response', () => {
  test('corrects a name, releases a seat, and refuses to add one', async ({ page }) => {
    await page.goto('/f/qa-public');
    await fillRegistrant(page, 'Edit Tan', addr('edit'));
    await page.getByRole('button', { name: 'Add a guest' }).click();
    await field(page, 'party.0.full_name').fill('Keep Tan');
    await field(page, 'party.1.full_name').fill('Drop Tan');
    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText('3 seats confirmed')).toBeVisible();

    const [response] = await sql<{ edit_token: string }[]>`
      select fr.edit_token from form_responses fr
        join registrations r on r.form_response_id = fr.id
       where r.contact_email = ${addr('edit')}
    `;

    await page.goto(`/f/qa-public/edit?r=${response.edit_token}`);
    await expect(page.getByRole('heading', { name: 'Change your registration' })).toBeVisible();

    /**
     * **There is no add control.** That is the §8.3.1 rule made structural: an
     * edit form that can claim inventory is a second, unpoliced allocation path.
     * The only "add" on this screen belongs to the extra-seat *request*, which
     * is a new entry at the back of the queue.
     */
    await expect(page.getByRole('button', { name: 'Add a name' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a guest' })).toHaveCount(0);

    await page.getByLabel('Seat 2 name').fill('Kept Tan');
    await page.getByRole('button', { name: 'Release' }).nth(2).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/changes have been saved/i)).toBeVisible();

    const party = await partyOf(addr('edit'));
    expect(party.map((r) => r.full_name)).toEqual(['Edit Tan', 'Kept Tan']);

    const [dropped] = await sql<{ status: string }[]>`
      select a.status::text from attendees a
        join registrations r on r.id = a.registration_id
       where r.contact_email = ${addr('edit')} and a.full_name = 'Drop Tan'
    `;
    expect(dropped.status).toBe('CANCELLED');
  });

  test('the superseded edit link stops working', async ({ page }) => {
    await page.goto('/f/qa-public');
    await fillRegistrant(page, 'Chain Tan', addr('chain'));
    await page.getByRole('button', { name: 'Submit registration' }).click();
    await expect(page.getByText('Registration received')).toBeVisible();

    const [response] = await sql<{ edit_token: string }[]>`
      select fr.edit_token from form_responses fr
        join registrations r on r.form_response_id = fr.id
       where r.contact_email = ${addr('chain')}
    `;

    await page.goto(`/f/qa-public/edit?r=${response.edit_token}`);
    await page.getByLabel('Full name').fill('Chained Tan');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/changes have been saved/i)).toBeVisible();

    // The old link is now a superseded response and must not reopen.
    await page.goto(`/f/qa-public/edit?r=${response.edit_token}`);
    await expect(page.getByText(/not available/i).first()).toBeVisible();
  });
});
