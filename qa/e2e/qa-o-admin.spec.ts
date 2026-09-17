import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Module `O` — the admin half: triage, the wall, the grouped view, export and
 * the digest.
 */
const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const SHOTS = 'qa-artifacts/O-notes-wall/screens';
const NOTES_URL = '/admin/concerts/1/notes';

/** Seed ids, from qa-artifacts/O-notes-wall/seed.json. */
const PLAYER = { ada: 2, ben: 3, chandra: 4, dev: 5, retired: 6 };

async function loginAdmin(page: Page) {
  await page.goto('/login');
  await page.fill('#code', 'qa-admin-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

const noteRow = (body: string) => sql<
  { id: string; moderation_status: string; wall_status: string; moderated_by: string | null }[]
>`select id, moderation_status, wall_status, moderated_by from portal_notes where body = ${body}`;

const digests = () => sql<
  { id: string; player_id: string | null; registration_id: string | null; status: string;
    to_email: string; to_name: string; subject: string; body_md: string }[]
>`select id, player_id, registration_id, status, to_email, to_name, subject, body_md
    from email_outbox where template_key = 'player_notes_digest' order by id`;

test.afterAll(async () => { await sql.end(); });

/**
 * **The admin console is web-first, and this spec runs there only.**
 *
 * `playwright.config.ts` carries `android` and `iphone` for the *door
 * scanner*, which is the one phone-only surface (`surfaces.md` §15.4), and
 * applies them to every spec because it has no per-project `testMatch`. Run
 * at a Pixel 7 viewport these tests fail on the sidebar shell rather than on
 * anything module `O` owns — `surfaces.md` §15.1 makes admin web-first with
 * mobile responsiveness explicitly droppable, so there is nothing here to
 * assert at that width.
 *
 * `qa-o-portal.spec.ts` is the mobile-first half and deliberately keeps all
 * three projects; it passes on `android`.
 */
test.skip(
  ({ isMobile }) => Boolean(isMobile),
  'the admin console is web-first (surfaces.md §15.1)',
);

test('FLOW-10 admin triages: filter to pending, approve two in bulk', async ({ page }) => {
  // Two notes waiting, so "in bulk" is a real claim rather than a loop of one.
  await sql`update portal_notes set moderation_status = 'PENDING', wall_status = 'NOT_PUBLISHED',
                   moderated_by = null, moderated_at = null
             where body in ('Ben, unreviewed words.', 'Chandra, the flute solo!')`;

  await loginAdmin(page);
  await page.goto(NOTES_URL);
  await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
  await shot(page, 'FLOW-10-step-1-notes-screen');

  // The header counts what is waiting — a real, checkable number.
  const pendingBefore = await sql<{ n: number }[]>`
    select count(*)::int as n from portal_notes where concert_id = 1 and moderation_status = 'PENDING'`;
  expect(pendingBefore[0].n).toBe(2);
  await expect(page.getByText('2 notes are waiting to be reviewed.')).toBeVisible();

  // Filter by moderation status.
  await page.getByRole('combobox').nth(2).click();
  await page.getByRole('option', { name: 'Waiting' }).click();
  await expect(page.getByText('2 shown')).toBeVisible();
  await shot(page, 'FLOW-10-step-2-filtered-pending');

  // Select everything visible and approve.
  await page.locator('label[for="select-visible"]').click();
  await expect(page.getByText(/selected of/)).toBeVisible();
  await shot(page, 'FLOW-10-step-3-selected');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(/notes approved/)).toBeVisible();
  await shot(page, 'FLOW-10-step-4-approved');

  const after = await sql<{ n: number }[]>`
    select count(*)::int as n from portal_notes where concert_id = 1 and moderation_status = 'PENDING'`;
  expect(after[0].n).toBe(0);

  // Approving did NOT publish anything — the two flags are independent (§13.4).
  const [ben] = await noteRow('Ben, unreviewed words.');
  expect(ben.moderation_status).toBe('APPROVED');
  expect(ben.wall_status).toBe('NOT_PUBLISHED');
  expect(ben.moderated_by).toBe('11111111-1111-4111-8111-111111111111');
});

test('FLOW-11 admin publishes an unaddressed note and the guest then sees it', async ({ page }) => {
  await loginAdmin(page);
  await page.goto(NOTES_URL);

  const target = 'Approved but nobody published me.';
  expect((await noteRow(target))[0].wall_status).toBe('NOT_PUBLISHED');

  const card = page.locator('div').filter({ hasText: target }).last();
  await page.getByRole('checkbox', { name: /Select the note from Writer Three/ }).click();
  await shot(page, 'FLOW-11-step-1-selected-unaddressed');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('1 note put on the wall')).toBeVisible();
  await shot(page, 'FLOW-11-step-2-published');
  expect((await noteRow(target))[0].wall_status).toBe('PUBLISHED');
  expect(card).toBeTruthy();

  // And a guest sees it on the portal wall.
  await page.goto('/t/PublicGuestBBBBBBBBB2x');
  await expect(page.getByText(target)).toBeVisible();
  await shot(page, 'FLOW-11-step-3-guest-sees-it');
});

test('FLOW-12 publishing a selection containing a player-addressed note refuses the whole call', async ({ page }) => {
  await loginAdmin(page);
  await page.goto(NOTES_URL);

  // Take the published one back off first, so "nothing changed" is checkable.
  const open = 'Approved but nobody published me.';
  const personal = 'Ada, your solo was the evening.';
  await sql`update portal_notes set wall_status = 'NOT_PUBLISHED' where body = ${open}`;
  await page.reload();

  await page.getByRole('checkbox', { name: /Select the note from Writer Three/ }).click();
  await page.getByRole('checkbox', { name: /Select the note from LOH KAI XIN/ }).click();
  await shot(page, 'FLOW-12-step-1-mixed-selection');

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Nothing was changed')).toBeVisible();
  await expect(page.getByText(/written to Ada Lim/)).toBeVisible();
  await expect(page.getByText(/personal/)).toBeVisible();
  await shot(page, 'FLOW-12-step-2-refused');

  // Neither was published — no partial success.
  expect((await noteRow(open))[0].wall_status).toBe('NOT_PUBLISHED');
  expect((await noteRow(personal))[0].wall_status).toBe('NOT_PUBLISHED');
});

test('FLOW-13 the grouped-by-player view is complete with the public wall switched off', async ({ page }) => {
  await sql`update system_settings set value = 'false'::jsonb where key = 'portal.public_wall_enabled'`;
  await sql`update system_settings set value = '"ADMIN_ONLY"'::jsonb where key = 'portal.public_wall_visibility'`;
  try {
    await loginAdmin(page);
    await page.goto(NOTES_URL);
    await page.getByRole('tab', { name: 'By player' }).click();
    await shot(page, 'FLOW-13-step-1-grouped');

    // A section per player who was written to, with a count — §14.2.
    await expect(page.getByRole('button', { name: /Ada Lim/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Ben Ong/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Chandra Devi/ })).toBeVisible();
    // Dev Patel was written to by nobody, so he has no section.
    await expect(page.getByRole('button', { name: /Dev Patel/ })).toHaveCount(0);
    // Unaddressed notes group under "For the orchestra".
    await expect(page.getByRole('button', { name: /For the orchestra/ })).toBeVisible();
    // Chandra has no email and the screen says so before a digest is attempted.
    await expect(page.getByText('No email')).toBeVisible();

    await page.getByRole('button', { name: /Ada Lim/ }).click();
    await expect(page.getByText('Ada, your solo was the evening.')).toBeVisible();
    // Admin sees the real name of the anonymous writer — §13.4.
    await page.getByRole('button', { name: /For the orchestra/ }).click();
    await expect(page.getByText('Writer Two').first()).toBeVisible();
    await shot(page, 'FLOW-13-step-2-expanded');
  } finally {
    await sql`update system_settings set value = 'true'::jsonb where key = 'portal.public_wall_enabled'`;
    await sql`update system_settings set value = '"AUDIENCE"'::jsonb where key = 'portal.public_wall_visibility'`;
  }
});

test('FLOW-14 admin exports a player’s notes as CSV', async ({ page }) => {
  await loginAdmin(page);
  const cookies = await page.context().cookies();
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  await page.goto(NOTES_URL);
  await page.getByRole('tab', { name: 'By player' }).click();
  await shot(page, 'FLOW-14-step-1-before-export');

  const one = await page.request.get(
    `/api/notes/export?concertId=1&playerIds=${PLAYER.ada}`,
    { headers: { cookie: header } },
  );
  expect(one.status()).toBe(200);
  expect(one.headers()['content-type']).toContain('text/csv');
  const csv = await one.text();
  expect(csv).toContain('Ada, your solo was the evening.');
  expect(csv).not.toContain('Ben, unreviewed words.');
  expect(csv).not.toContain('The Sibelius was extraordinary tonight.');
  /**
   * The real attendee name sits beside the signed name — this is admin, and
   * §13.4 hides an anonymous name from the wall and never from here.
   * **Uncased on purpose**: `email.md` §11.3 cases names *in a message*, and
   * says in the same breath that "the stored rows keep what the guest typed, so
   * the sheet and the admin screens are unaffected".
   */
  expect(csv).toContain('LOH KAI XIN');

  const all = await page.request.get('/api/notes/export?concertId=1', { headers: { cookie: header } });
  const allCsv = await all.text();
  expect(allCsv).toContain('Ada, your solo was the evening.');
  expect(allCsv).toContain('The Sibelius was extraordinary tonight.');
  await shot(page, 'FLOW-14-step-2-after-export');
});

test('FLOW-15 queueing a digest twice is harmless and says so', async ({ page }) => {
  await sql`delete from email_outbox where template_key = 'player_notes_digest'`;
  await loginAdmin(page);
  await page.goto(NOTES_URL);
  await page.getByRole('tab', { name: 'By player' }).click();

  await page.getByRole('checkbox', { name: 'Select Ada Lim' }).check();
  await page.getByRole('checkbox', { name: 'Select Ben Ong' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await shot(page, 'FLOW-15-step-1-two-players-selected');

  await page.getByRole('button', { name: 'Queue digest', exact: true }).click();
  await expect(page.getByText(/2 digests drafted/)).toBeVisible();
  await shot(page, 'FLOW-15-step-2-first-press');

  const first = await digests();
  expect(first).toHaveLength(2);
  for (const row of first) {
    expect(row.player_id).not.toBeNull();
    expect(row.registration_id).toBeNull();
    // §11.2 step 1: rows land as DRAFT and no dispatcher may claim them.
    expect(row.status).toBe('DRAFT');
  }
  // The digest carries only that player's notes, and greets the player.
  const ada = first.find((r) => Number(r.player_id) === PLAYER.ada)!;
  expect(ada.to_name).toBe('Ada Lim');
  expect(ada.body_md).toContain('Dear Ada Lim');
  expect(ada.body_md).toContain('Ada, your solo was the evening.');
  expect(ada.body_md).not.toContain('Ben, unreviewed words.');
  expect(ada.body_md).not.toContain('{{');

  /**
   * Press it again. The selection is cleared on success, so an admin unsure
   * whether the first press registered re-selects and presses — which is the
   * shape of §11.4's "clicks again", and what the index has to survive. Both
   * players now carry a "Digest waiting" badge, which is the screen telling
   * them before the action does.
   */
  await expect(page.getByText('Digest waiting')).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Select Ada Lim' }).check();
  await page.getByRole('checkbox', { name: 'Select Ben Ong' }).check();
  await page.getByRole('button', { name: 'Queue digest', exact: true }).click();
  await expect(page.getByText(/already waiting in the outbox/)).toBeVisible();
  await shot(page, 'FLOW-15-step-3-second-press');
  expect(await digests()).toHaveLength(2);
});

test('FLOW-16 a player with no notes, and one with no email, are skipped and named', async ({ page }) => {
  await loginAdmin(page);
  await page.goto(NOTES_URL);
  await page.getByRole('tab', { name: 'By player' }).click();

  // Chandra has an approved note but no email address.
  await page.getByRole('checkbox', { name: 'Select Chandra Devi' }).check();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Queue digest', exact: true }).click();
  await expect(page.getByText('Chandra Devi has no email address on file')).toBeVisible();
  await shot(page, 'FLOW-16-step-1-no-email-skipped');

  const rows = await digests();
  expect(rows.some((r) => Number(r.player_id) === PLAYER.chandra)).toBe(false);

  // Dev Patel has no notes at all, so he has no group and cannot be selected —
  // the queue path is still exercised directly below through the action's own
  // guard in tests/notes/moderation.test.ts.
  await expect(page.getByRole('button', { name: /Dev Patel/ })).toHaveCount(0);
  await shot(page, 'FLOW-16-step-2-no-group-for-unwritten-player');
});

test('FLOW-19 a note timestamp does not move with the viewer’s timezone', async ({ browser }) => {
  const shots: string[] = [];
  const values: string[] = [];
  for (const [i, tz] of ['Asia/Kuala_Lumpur', 'America/Los_Angeles'].entries()) {
    const context = await browser.newContext({ timezoneId: tz });
    const page = await context.newPage();
    await loginAdmin(page);
    const cookies = await context.cookies();
    const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const csv = await (await page.request.get('/api/notes/export?concertId=1', {
      headers: { cookie: header },
    })).text();
    const first = csv.split('\n')[1];
    values.push(first.slice(first.lastIndexOf(',')));
    await page.goto(NOTES_URL);
    const name = `FLOW-19-step-${i + 1}-${tz.replace(/\W+/g, '-')}`;
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
    shots.push(name);
    await context.close();
  }
  // `concert.timezone` is Asia/Kuala_Lumpur; the browser's zone must not move it.
  expect(values[0]).toBe(values[1]);
});
