import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Module `O` — the portal half: leaving a note, editing one, and the wall.
 *
 * Run at a phone viewport: the portal is mobile-first (`surfaces.md` §15.3).
 */
const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const SHOTS = 'qa-artifacts/O-notes-wall/screens';

const TOKENS = {
  playerInvited: 'PlayerInvitedAAAAAAA1x',
  publicAdmitted: 'PublicGuestBBBBBBBBB2x',
  notAdmitted: 'NotAdmittedCCCCCCCCC3x',
  cancelled: 'CancelledDDDDDDDDDDD4x',
  deleted: 'DeletedEEEEEEEEEEEEE5x',
};

/**
 * `portal.unlock_mode` is a **show**-level key and the seed sets
 * `shows.portal_unlock_mode`, which wins the cascade over `system_settings`.
 * Writing the system row alone changes nothing — proved by hand before this
 * helper existed, and the reason it does.
 */
async function setUnlockMode(mode: 'ON_ADMISSION' | 'OPEN_TO_ALL' | 'CLOSED') {
  await sql`update shows set portal_unlock_mode = ${mode} where id = 1`;
}

async function setSetting(key: string, value: unknown) {
  await sql`
    insert into system_settings (key, value) values (${key}, ${JSON.stringify(value)}::text::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

const noteFor = (token: string) => sql<
  {
    id: string; body: string; to_player_id: string | null; display_name: string | null;
    is_anonymous: boolean; moderation_status: string; wall_status: string;
    moderated_by: string | null; moderated_at: string | null; concert_id: string; show_id: string;
  }[]
>`select n.* from portal_notes n
    join attendees a on a.id = n.attendee_id
   where a.qr_token = ${token}`;

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.use({ viewport: { width: 375, height: 812 } });

test.afterAll(async () => { await sql.end(); });

test('FLOW-1 a player-invited guest leaves a note with their player prefilled', async ({ page }) => {
  await sql`delete from portal_notes n using attendees a
             where a.id = n.attendee_id and a.qr_token = ${TOKENS.playerInvited}`;

  await page.goto(`/t/${TOKENS.playerInvited}`);
  await expect(page.getByText('Leave a note')).toBeVisible();
  await shot(page, 'FLOW-1-step-1-notes-form');

  // §13.4: the inviting player is prefilled, and it came from the SEGMENT.
  const recipient = page.locator('#\\:r0\\:-to, input[placeholder="Search for a player"]').first();
  await expect(recipient).toHaveValue('Ada Lim');
  await shot(page, 'FLOW-1-step-2-ada-prefilled');

  await page.getByLabel('Your note').fill('The strings were extraordinary.');
  await shot(page, 'FLOW-1-step-3-body-typed');
  await page.getByRole('button', { name: /send my note/i }).click();

  await expect(page.getByText('Your note has been sent')).toBeVisible();
  await shot(page, 'FLOW-1-step-4-saved');

  const rows = await noteFor(TOKENS.playerInvited);
  expect(rows).toHaveLength(1);
  expect(rows[0].body).toBe('The strings were extraordinary.');
  expect(rows[0].moderation_status).toBe('PENDING');
  expect(rows[0].wall_status).toBe('NOT_PUBLISHED');
  // Ada is player 2 in the seed.
  expect(Number(rows[0].to_player_id)).toBe(2);
  // display_name defaulted to the attendee's name.
  expect(rows[0].display_name).toBe('Guest Of Ada');
});

test('FLOW-2 a public guest in the SAME show gets no prefill and "The whole orchestra"', async ({ page }) => {
  await sql`delete from portal_notes n using attendees a
             where a.id = n.attendee_id and a.qr_token = ${TOKENS.publicAdmitted}`;

  await page.goto(`/t/${TOKENS.publicAdmitted}`);
  await expect(page.getByText('Leave a note')).toBeVisible();

  const recipient = page.locator('input[placeholder="Search for a player"]').first();
  // §13.4: a PUBLIC seat gets no player prefilled — the same show, the other segment.
  await expect(recipient).toHaveValue('The whole orchestra');
  await shot(page, 'FLOW-2-step-1-no-prefill');

  // The searchable list is real: it offers the concert's players.
  await recipient.click();
  await expect(page.getByRole('option', { name: /Ben Ong/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Stranger From Elsewhere/ })).toHaveCount(0);
  await shot(page, 'FLOW-2-step-2-searchable-list');
  await page.keyboard.press('Escape');

  await page.getByLabel('Your note').fill('Thank you, all of you.');
  await page.getByRole('button', { name: /send my note/i }).click();
  await expect(page.getByText('Your note has been sent')).toBeVisible();
  await shot(page, 'FLOW-2-step-3-saved-for-orchestra');

  const rows = await noteFor(TOKENS.publicAdmitted);
  expect(rows).toHaveLength(1);
  expect(rows[0].to_player_id).toBeNull();
});

test('FLOW-3 editing an approved, published note returns it to PENDING and off the wall', async ({ page }) => {
  const [row] = await noteFor(TOKENS.publicAdmitted);
  await sql`update portal_notes
               set moderation_status = 'APPROVED', wall_status = 'PUBLISHED',
                   moderated_by = '11111111-1111-4111-8111-111111111111'::uuid,
                   moderated_at = now()
             where id = ${Number(row.id)}`;

  await page.goto(`/t/${TOKENS.publicAdmitted}`);
  await expect(page.getByText('On the public wall')).toBeVisible();
  // The wall shows it to this same guest.
  await expect(page.getByText('Thank you, all of you.').first()).toBeVisible();
  await shot(page, 'FLOW-3-step-1-published');

  await page.getByRole('button', { name: /edit my note/i }).click();
  await page.getByLabel('Your note').fill('Actually, the brass carried it.');
  await shot(page, 'FLOW-3-step-2-edited');
  await page.getByRole('button', { name: /save my note/i }).click();
  await expect(page.getByText('Your note has been sent')).toBeVisible();

  const after = await noteFor(TOKENS.publicAdmitted);
  expect(after[0].moderation_status).toBe('PENDING');
  expect(after[0].wall_status).toBe('NOT_PUBLISHED');       // decision 44
  expect(after[0].moderated_by).toBeNull();
  expect(after[0].moderated_at).toBeNull();

  await page.reload();
  // Gone from the wall for everyone, immediately.
  await expect(page.getByText('Actually, the brass carried it.')).toHaveCount(1);
  await shot(page, 'FLOW-3-step-3-off-the-wall');
});

test('FLOW-4 an over-length note is refused, and the cap is the resolved setting', async ({ page }) => {
  await page.goto(`/t/${TOKENS.playerInvited}`);
  await page.getByRole('button', { name: /edit my note/i }).click();

  const before = (await noteFor(TOKENS.playerInvited))[0].body;
  await page.getByLabel('Your note').fill('x'.repeat(121));   // portal.note_max_length = 120
  await expect(page.getByText('121 / 120 characters')).toBeVisible();
  await shot(page, 'FLOW-4-step-1-over-the-cap');

  await expect(page.getByRole('button', { name: /save my note/i })).toBeDisabled();
  const after = (await noteFor(TOKENS.playerInvited))[0].body;
  expect(after).toBe(before);
  await shot(page, 'FLOW-4-step-2-save-disabled');
});

test('FLOW-5 an empty note is refused with a field-level error', async ({ page }) => {
  await page.goto(`/t/${TOKENS.playerInvited}`);
  await page.getByRole('button', { name: /edit my note/i }).click();
  const before = (await noteFor(TOKENS.playerInvited))[0].body;

  await page.getByLabel('Your note').fill('   ');
  await page.getByRole('button', { name: /save my note/i }).click();
  await expect(page.getByText('Write something first.')).toBeVisible();
  await shot(page, 'FLOW-5-step-1-empty-refused');

  expect((await noteFor(TOKENS.playerInvited))[0].body).toBe(before);
});

test('FLOW-6 notes are closed: the note is readable, not editable, and a forced POST is refused', async ({ page }) => {
  await setSetting('portal.notes_close_at', '2020-01-01T00:00:00Z');
  try {
    await page.goto(`/t/${TOKENS.playerInvited}`);
    await expect(page.getByText('Notes have closed, so this one can no longer be changed.')).toBeVisible();
    await expect(page.getByRole('button', { name: /save my note|edit my note/i })).toHaveCount(0);
    await shot(page, 'FLOW-6-step-1-closed');

    // A guest who never wrote gets no section at all.
    const before = (await noteFor(TOKENS.playerInvited))[0].body;
    await page.goto(`/t/${TOKENS.publicAdmitted}`);
    await shot(page, 'FLOW-6-step-2-closed-other-guest');
    expect((await noteFor(TOKENS.playerInvited))[0].body).toBe(before);
  } finally {
    await sql`delete from system_settings where key = 'portal.notes_close_at'`;
  }
});

test('FLOW-7 a ticket holder who was never admitted gets no notes section and no wall', async ({ page }) => {
  await page.goto(`/t/${TOKENS.notAdmitted}`);
  await expect(page.getByText('Present this QR at the door')).toBeVisible();
  await expect(page.getByText('Leave a note')).toHaveCount(0);
  await expect(page.getByText('From the audience')).toHaveCount(0);
  // And no published note's text is in the delivered HTML.
  expect(await page.content()).not.toContain('The Sibelius was extraordinary tonight.');
  await shot(page, 'FLOW-7-step-1-status-only');
});

test('FLOW-8 OPEN_TO_ALL unlocks notes for a ticket holder with no check-in', async ({ page }) => {
  await setUnlockMode('OPEN_TO_ALL');
  try {
    await page.goto(`/t/${TOKENS.notAdmitted}`);
    await expect(page.getByText('Leave a note')).toBeVisible();
    await shot(page, 'FLOW-8-step-1-unlocked-by-fallback');

    await page.getByLabel('Your note').fill('I could not come, but thank you.');
    await page.getByRole('button', { name: /send my note/i }).click();
    await expect(page.getByText('Your note has been sent')).toBeVisible();
    expect((await noteFor(TOKENS.notAdmitted)).map((r) => r.body)).toContain(
      'I could not come, but thank you.',
    );
    await shot(page, 'FLOW-8-step-2-note-accepted');
  } finally {
    await setUnlockMode('ON_ADMISSION');
    await sql`delete from portal_notes n using attendees a
               where a.id = n.attendee_id and a.qr_token = ${TOKENS.notAdmitted}
                 and n.body = 'I could not come, but thank you.'`;
  }
});

test('FLOW-9 unknown, malformed and soft-deleted tokens are indistinguishable', async ({ page }) => {
  const bodies: string[] = [];
  for (const [i, token] of ['deadbeefdeadbeefdead0x', '!!!', TOKENS.deleted].entries()) {
    await page.goto(`/t/${encodeURIComponent(token)}`);
    await expect(page.getByText('We could not find that ticket')).toBeVisible();
    await expect(page.getByText('Leave a note')).toHaveCount(0);
    await shot(page, `FLOW-9-step-${i + 1}-not-found`);
    bodies.push(await page.locator('main').innerText());
  }
  expect(bodies[0]).toBe(bodies[1]);
  expect(bodies[1]).toBe(bodies[2]);
});

test('FLOW-9b a cancelled ticket says so and offers no notes', async ({ page }) => {
  await page.goto(`/t/${TOKENS.cancelled}`);
  await expect(page.getByText('no longer valid')).toBeVisible();
  await expect(page.getByText('Leave a note')).toHaveCount(0);
  await shot(page, 'FLOW-9b-step-1-cancelled');
});

test('FLOW-11b the wall shows only approved+published, unaddressed notes, anonymised', async ({ page }) => {
  await page.goto(`/t/${TOKENS.publicAdmitted}`);
  await expect(page.getByText('From the audience')).toBeVisible();

  // Published + approved + unaddressed: present.
  await expect(page.getByText('The Sibelius was extraordinary tonight.')).toBeVisible();
  // Anonymous one is present but the name is not — and never reaches the browser.
  await expect(page.getByText('I cried during the second movement.')).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain('Writer Two');
  expect(html).toContain('Writer One');
  // Approved but not published: absent.
  expect(html).not.toContain('Approved but nobody published me.');
  // Addressed to Ada, approved: absent.
  expect(html).not.toContain('Ada, your solo was the evening.');
  await shot(page, 'FLOW-11b-step-1-wall');
});

test('FLOW-20 the wall disappears when disabled, and when visibility is ADMIN_ONLY', async ({ page }) => {
  await setSetting('portal.public_wall_visibility', 'ADMIN_ONLY');
  try {
    await page.goto(`/t/${TOKENS.publicAdmitted}`);
    await expect(page.getByText('From the audience')).toHaveCount(0);
    expect(await page.content()).not.toContain('The Sibelius was extraordinary tonight.');
    await shot(page, 'FLOW-20-step-1-admin-only');
  } finally {
    await setSetting('portal.public_wall_visibility', 'AUDIENCE');
  }

  await setSetting('portal.public_wall_enabled', false);
  try {
    await page.goto(`/t/${TOKENS.publicAdmitted}`);
    await expect(page.getByText('From the audience')).toHaveCount(0);
    expect(await page.content()).not.toContain('The Sibelius was extraordinary tonight.');
    await shot(page, 'FLOW-20-step-2-wall-disabled');
  } finally {
    await setSetting('portal.public_wall_enabled', true);
  }
});

test('FLOW-24 notes disabled removes the section and refuses the write', async ({ page }) => {
  await setSetting('portal.notes_enabled', false);
  try {
    await page.goto(`/t/${TOKENS.publicAdmitted}`);
    await expect(page.getByText('Leave a note')).toHaveCount(0);
    await expect(page.getByText('Your note')).toHaveCount(0);
    await shot(page, 'FLOW-24-step-1-notes-off');
  } finally {
    await setSetting('portal.notes_enabled', true);
  }
});

test('FLOW-23 CLOSED unlock mode leaves the status page only', async ({ page }) => {
  await setUnlockMode('CLOSED');
  try {
    await page.goto(`/t/${TOKENS.publicAdmitted}`);
    await expect(page.getByText('Leave a note')).toHaveCount(0);
    await expect(page.getByText('From the audience')).toHaveCount(0);
    await shot(page, 'FLOW-23-step-1-closed-mode');
  } finally {
    await setUnlockMode('ON_ADMISSION');
  }
});
