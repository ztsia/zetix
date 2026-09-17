import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Leaving and editing a note (spec/v2.md §13.4).
 *
 * **The property under test is that the action trusts nothing but the token.**
 * A Server Action is reachable without ever loading the page, so every gate the
 * section draws itself behind is re-asked — and the two that matter most are
 * the ones a payload could otherwise lie about: which attendee is writing, and
 * which player they may address.
 *
 * The database is real. `revalidatePath` is the only stub — it needs a request
 * scope these tests do not have, and it is not what any of this is testing.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { submitNoteAction } = await import('@/app/(portal)/t/[token]/notes-actions');
const { issueTickets } = await import('@/lib/tickets/issue');

let concertId: number;
let showId: number;
let publicSegmentId: number;
let token: string;
let attendeeId: number;
let playerIds: number[];

async function setSetting(key: string, value: unknown): Promise<void> {
  await sql`
    insert into system_settings (key, value)
    values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

/** Everything configured so that a submit should succeed. Each test breaks one thing. */
async function configureForSuccess(): Promise<void> {
  await setSetting('portal.enabled', true);
  await setSetting('portal.unlock_mode', 'OPEN_TO_ALL');
  await setSetting('portal.notes_enabled', true);
  await setSetting('portal.note_max_length', 500);
}

const notes = () => sql<
  {
    id: string;
    body: string;
    to_player_id: string | null;
    display_name: string | null;
    is_anonymous: boolean;
    moderation_status: string;
    wall_status: string;
    moderated_by: string | null;
    moderated_at: string | null;
    attendee_id: string;
    concert_id: string;
    show_id: string;
  }[]
>`select * from portal_notes`;

const NOTE = { body: 'The strings were wonderful.', toPlayerId: null, displayName: null, isAnonymous: false };

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Notes');
  showId = await createShow(concertId, 100);
  publicSegmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  playerIds = await createPlayers(concertId, 3);

  const registrationId = await createRegistration({ showId, segmentId: publicSegmentId });
  await seedAttendees({
    registrationId, showId, segmentId: publicSegmentId, count: 1, allocationType: 'BASE',
  });
  await issueTickets({ concertId, showId });

  const rows = await sql<{ id: string; qr_token: string }[]>`select id, qr_token from attendees`;
  attendeeId = Number(rows[0].id);
  token = rows[0].qr_token;

  await configureForSuccess();
});

describe('the happy path', () => {
  it('stores the note against the attendee the token names', async () => {
    expect(await submitNoteAction(token, NOTE)).toEqual({ ok: true, errors: {} });

    const [row] = await notes();
    expect(row.body).toBe('The strings were wonderful.');
    expect(Number(row.attendee_id)).toBe(attendeeId);
    expect(Number(row.concert_id)).toBe(concertId);
    expect(Number(row.show_id)).toBe(showId);
    expect(row.to_player_id).toBeNull();
  });

  it('starts every note PENDING and off the wall', async () => {
    await submitNoteAction(token, NOTE);
    const [row] = await notes();
    expect(row.moderation_status).toBe('PENDING');
    /**
     * Decision 6: publishing is *always* an explicit admin action. A note that
     * arrived already PUBLISHED would put an attendee's words in front of the
     * audience with nobody having read them.
     */
    expect(row.wall_status).toBe('NOT_PUBLISHED');
  });

  it('defaults the display name to the attendee, and keeps one that was given', async () => {
    await submitNoteAction(token, NOTE);
    expect((await notes())[0].display_name).toBe('Guest 1');

    await submitNoteAction(token, { ...NOTE, displayName: '  Wei Ling  ' });
    expect((await notes())[0].display_name).toBe('Wei Ling');
  });

  it('trims the body and refuses one that is only whitespace', async () => {
    const blank = await submitNoteAction(token, { ...NOTE, body: '   \n  ' });
    expect(blank.ok).toBe(false);
    expect(blank.errors.body).toBe('Write something first.');
    expect(await notes()).toHaveLength(0);

    await submitNoteAction(token, { ...NOTE, body: '  padded  ' });
    expect((await notes())[0].body).toBe('padded');
  });

  it('records anonymity without losing the name', async () => {
    await submitNoteAction(token, { ...NOTE, displayName: 'Wei Ling', isAnonymous: true });
    const [row] = await notes();
    /**
     * §13.4: anonymity "hides it on the wall but never from admin". So the name
     * is stored and the *wall* is what withholds it — dropping it here would
     * take it from the admin too, and the grouped view is how notes get back to
     * the player they were written for.
     */
    expect(row.is_anonymous).toBe(true);
    expect(row.display_name).toBe('Wei Ling');
  });
});

describe('one note per attendee', () => {
  it('edits the existing row rather than writing a second', async () => {
    await submitNoteAction(token, NOTE);
    await submitNoteAction(token, { ...NOTE, body: 'Second thoughts.' });

    const rows = await notes();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('Second thoughts.');
  });

  /**
   * §13.4's own rule, and the reason it exists: "otherwise moderation reviews
   * one text and the wall publishes another".
   */
  it('returns an approved note to PENDING when it is edited', async () => {
    await submitNoteAction(token, NOTE);
    await sql`
      update portal_notes
         set moderation_status = 'APPROVED', moderated_at = now()
       where attendee_id = ${attendeeId}
    `;

    await submitNoteAction(token, { ...NOTE, body: 'Actually, the brass.' });
    const [row] = await notes();
    expect(row.moderation_status).toBe('PENDING');
    expect(row.moderated_at).toBeNull();
  });

  /**
   * The half §13.4 does not spell out and the rule is useless without: an
   * edited note that stayed PUBLISHED puts unreviewed text in front of the
   * audience immediately, which is worse than the case the sentence was
   * written for.
   */
  it('takes an edited note off the wall', async () => {
    await submitNoteAction(token, NOTE);
    await sql`
      update portal_notes
         set moderation_status = 'APPROVED', wall_status = 'PUBLISHED'
       where attendee_id = ${attendeeId}
    `;

    await submitNoteAction(token, { ...NOTE, body: 'Something entirely different.' });
    const [row] = await notes();
    expect(row.wall_status).toBe('NOT_PUBLISHED');
    expect(row.moderation_status).toBe('PENDING');
  });
});

describe('who a note may be addressed to', () => {
  it('accepts a player on this concert', async () => {
    await submitNoteAction(token, { ...NOTE, toPlayerId: playerIds[1] });
    expect(Number((await notes())[0].to_player_id)).toBe(playerIds[1]);
  });

  /**
   * The check the foreign key cannot make. `to_player_id` references `players`,
   * which says nothing about *which concert* — so without this, one edited
   * field puts a note into any player's digest in the database.
   */
  it('drops a player who belongs to another concert', async () => {
    const otherConcert = await createConcert('Elsewhere');
    const [stranger] = await createPlayers(otherConcert, 1);

    const result = await submitNoteAction(token, { ...NOTE, toPlayerId: stranger });
    expect(result.ok).toBe(true);
    expect((await notes())[0].to_player_id).toBeNull();
  });

  it('drops a player who has been deactivated', async () => {
    await sql`update players set is_active = false where id = ${playerIds[0]}`;
    await submitNoteAction(token, { ...NOTE, toPlayerId: playerIds[0] });
    /**
     * The note survives and becomes one for the whole orchestra. The guest did
     * nothing wrong and their words should not be lost to an admin's roster
     * edit between the page loading and the save.
     */
    expect((await notes())[0].to_player_id).toBeNull();
  });

  it('drops an id that is not a player at all', async () => {
    await submitNoteAction(token, { ...NOTE, toPlayerId: 999_999 });
    expect((await notes())[0].to_player_id).toBeNull();
  });
});

describe('the gates, each broken in turn', () => {
  const REFUSAL = 'Notes are not being accepted for this concert.';

  it('refuses when the portal is off', async () => {
    await setSetting('portal.enabled', false);
    const result = await submitNoteAction(token, NOTE);
    expect(result.ok).toBe(false);
    expect(result.errors._form).toBe(REFUSAL);
    expect(await notes()).toHaveLength(0);
  });

  it('refuses when notes are off, though the portal is on', async () => {
    await setSetting('portal.notes_enabled', false);
    expect((await submitNoteAction(token, NOTE)).errors._form).toBe(REFUSAL);
    expect(await notes()).toHaveLength(0);
  });

  it('refuses once notes have closed', async () => {
    await setSetting('portal.notes_close_at', '2020-01-01T00:00:00Z');
    expect((await submitNoteAction(token, NOTE)).errors._form).toBe(REFUSAL);
    expect(await notes()).toHaveLength(0);
  });

  it('accepts while the close date is still ahead', async () => {
    await setSetting('portal.notes_close_at', '2099-01-01T00:00:00Z');
    expect((await submitNoteAction(token, NOTE)).ok).toBe(true);
  });

  it('refuses a guest the unlock rule has not admitted', async () => {
    await setSetting('portal.unlock_mode', 'ON_ADMISSION');
    expect((await submitNoteAction(token, NOTE)).errors._form).toBe(REFUSAL);
    expect(await notes()).toHaveLength(0);
  });

  it('accepts the same guest once they have been scanned in', async () => {
    await setSetting('portal.unlock_mode', 'ON_ADMISSION');
    await sql`
      insert into check_ins (attendee_id, show_id, scanned_at, source)
      values (${attendeeId}, ${showId}, now(), 'ONLINE')
    `;
    expect((await submitNoteAction(token, NOTE)).ok).toBe(true);
  });

  it('refuses a cancelled ticket', async () => {
    await sql`update attendees set status = 'CANCELLED' where id = ${attendeeId}`;
    expect((await submitNoteAction(token, NOTE)).errors._form).toBe(REFUSAL);
    expect(await notes()).toHaveLength(0);
  });

  it('refuses a token that names nobody', async () => {
    expect((await submitNoteAction('n0tar3alt0k3nabcdefghi', NOTE)).errors._form).toBe(REFUSAL);
    expect((await submitNoteAction('', NOTE)).errors._form).toBe(REFUSAL);
    expect(await notes()).toHaveLength(0);
  });
});

describe('the length cap', () => {
  it('refuses a body past portal.note_max_length, and says the numbers', async () => {
    await setSetting('portal.note_max_length', 10);
    const result = await submitNoteAction(token, { ...NOTE, body: 'x'.repeat(11) });
    expect(result.ok).toBe(false);
    expect(result.errors.body).toBe('Please keep this to 10 characters — yours is 11.');
    expect(await notes()).toHaveLength(0);
  });

  it('accepts a body exactly at the cap', async () => {
    await setSetting('portal.note_max_length', 10);
    expect((await submitNoteAction(token, { ...NOTE, body: 'x'.repeat(10) })).ok).toBe(true);
  });

  it('measures the trimmed body, not what was typed around it', async () => {
    await setSetting('portal.note_max_length', 5);
    expect((await submitNoteAction(token, { ...NOTE, body: '   hello   ' })).ok).toBe(true);
  });
});

describe('the signature', () => {
  /**
   * A sanity bound on an input, not an operational value — the same
   * distinction `savePracticalInfoAction` draws for its textarea. What it
   * stops is the name field used as a second note body, rendered at every
   * other guest on the wall. `portal.note_max_length` is the cap that *is*
   * operational, and it governs the note.
   */
  it('refuses a display name used as a second note body', async () => {
    const result = await submitNoteAction(token, { ...NOTE, displayName: 'x'.repeat(121) });
    expect(result.ok).toBe(false);
    expect(result.errors.displayName).toContain('120');
    expect(await notes()).toHaveLength(0);
  });

  it('accepts a name at the bound', async () => {
    expect((await submitNoteAction(token, { ...NOTE, displayName: 'x'.repeat(120) })).ok).toBe(true);
  });

  /**
   * The cap is checked after the default is applied, so an attendee whose own
   * row carries an implausibly long name is refused rather than writing a row
   * the wall cannot render. Reachable: `full_name` is `text`, and import
   * writes it.
   */
  it('measures the name that will actually be stored', async () => {
    await sql`update attendees set full_name = ${'y'.repeat(200)} where id = ${attendeeId}`;
    const result = await submitNoteAction(token, { ...NOTE, displayName: null });
    expect(result.ok).toBe(false);
    expect(result.errors.displayName).toBeTruthy();
  });
});

describe('a payload that lies', () => {
  /**
   * The pair `N` left as the template. Neither field exists in the action's
   * schema, so the point is that adding them changes nothing: the attendee
   * comes from the token and the concert comes from the attendee.
   */
  it('ignores an attendee id in the payload', async () => {
    const other = await createRegistration({ showId, segmentId: publicSegmentId });
    await seedAttendees({
      registrationId: other, showId, segmentId: publicSegmentId, count: 1, allocationType: 'BASE',
    });
    const [victim] = await sql<{ id: string }[]>`
      select id from attendees where id <> ${attendeeId} limit 1
    `;

    await submitNoteAction(token, { ...NOTE, attendeeId: Number(victim.id) });
    const rows = await notes();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].attendee_id)).toBe(attendeeId);
  });

  it('ignores a concert id in the payload', async () => {
    const elsewhere = await createConcert('Elsewhere');
    await submitNoteAction(token, { ...NOTE, concertId: elsewhere });
    expect(Number((await notes())[0].concert_id)).toBe(concertId);
  });

  it('refuses a payload with no body at all', async () => {
    expect((await submitNoteAction(token, {})).ok).toBe(false);
    expect((await submitNoteAction(token, null)).ok).toBe(false);
    expect((await submitNoteAction(token, { body: 42 })).ok).toBe(false);
    expect(await notes()).toHaveLength(0);
  });
});
