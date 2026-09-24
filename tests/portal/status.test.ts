import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';
import { isTokenShaped, ticketStatus } from '@/lib/portal/status';

/**
 * What `/t/{qr_token}` resolves to, against the real database
 * (spec/v2.md §13.2, spec/README.md §4.1).
 *
 * Tokens are minted by module `D`'s own `issueTickets()` rather than written by
 * hand, so these run against the shape the system actually produces.
 *
 * The property under test throughout is that **this page and the door never
 * disagree about a ticket in the same hand.** `manifest_for_show()` reads
 * cancellation off `attendees.status` and existence off `deleted_at`; so does
 * this. Every cancellation route below is exercised through the real mutation
 * that causes it, not by setting the column the page happens to read.
 */

const { issueTickets } = await import('@/lib/tickets/issue');

let concertId: number;
let showId: number;
let segmentId: number;
let registrationId: number;
let token: string;
let attendeeId: number;
/** A second ticket, so "returns the right one" is a real assertion. */
let otherToken: string;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Portal');
  showId = await createShow(concertId, 100);
  await sql`
    update shows
       set name          = 'Evening Concert',
           starts_at     = '2026-09-19T11:30:00Z',
           doors_open_at = '2026-09-19T11:00:00Z',
           venue_name    = 'Victoria Concert Hall',
           venue_address = '11 Empress Pl, Singapore 179558'
     where id = ${showId}
  `;

  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId, showId, segmentId, count: 2, allocationType: 'BASE',
  });
  await issueTickets({ concertId, showId });

  const rows = await sql<{ id: string; qr_token: string }[]>`
    select id, qr_token from attendees order by id
  `;
  attendeeId = Number(rows[0].id);
  token = rows[0].qr_token;
  otherToken = rows[1].qr_token;
});

async function admit(id: number, at: string): Promise<void> {
  await sql`
    insert into check_ins (attendee_id, show_id, scanned_at, source)
    values (${id}, ${showId}, ${at}, 'ONLINE')
  `;
}

describe('a ticket that has been issued', () => {
  it('resolves to the details the page is allowed to show', async () => {
    const status = await ticketStatus(token);
    expect(status).not.toBeNull();
    expect(status!.state).toBe('ISSUED');
    expect(status!.attendeeName).toBe('Guest 1');
    expect(status!.concertName).toBe('Portal');
    expect(status!.timeZone).toBe('Asia/Singapore');
    expect(status!.show.name).toBe('Evening Concert');
    expect(status!.show.venueName).toBe('Victoria Concert Hall');
    expect(status!.show.doorsOpenAt?.toISOString()).toBe('2026-09-19T11:00:00.000Z');
    expect(status!.show.startsAt?.toISOString()).toBe('2026-09-19T11:30:00.000Z');
    expect(status!.admittedAt).toBeNull();
  });

  it('discloses nothing beyond the holder s own seat', async () => {
    /**
     * The credential is a token anyone could be holding, so the shape of what
     * comes back is part of the contract (spec/v2.md §13.3). No segment — a guest does
     * not need to know they were in the "public" block — and no contact email,
     * no player, and no sight of the rest of the party.
     */
    const status = await ticketStatus(token);
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain('PUBLIC');
    expect(serialised).not.toContain('segment');
    expect(serialised).not.toContain('Guest 2');
    expect(Object.keys(status!).sort()).toEqual([
      'admittedAt', 'attendeeName', 'concertId', 'concertName', 'portal', 'qrToken',
      'show', 'showIsOver', 'state', 'ticketCode', 'timeZone',
    ]);

    /**
     * The V2 portal context is configuration and ids, not other people. Pinned
     * key-by-key for the same reason the outer list is: this object is built
     * from a query that joins shows and concerts, and the next person to add a
     * column to either must be made to decide whether it belongs on a page a
     * stranger can open with a guessed token.
     */
    expect(Object.keys(status!.portal).sort()).toEqual([
      'bookletEnabled', 'enabled', 'feedbackCloseAt', 'feedbackEnabled',
      'noteMaxLength', 'notesCloseAt', 'notesEnabled', 'practicalInfoMd',
      'publicWallEnabled', 'publicWallVisibility', 'unlockMode',
    ]);
    expect(Object.keys(status!.show).sort()).toEqual([
      'doorsOpenAt', 'id', 'name', 'startsAt', 'venueAddress', 'venueName',
    ]);
  });

  it('returns the ticket the token names and not its neighbour', async () => {
    expect((await ticketStatus(token))!.attendeeName).toBe('Guest 1');
    expect((await ticketStatus(otherToken))!.attendeeName).toBe('Guest 2');
  });
});

describe('a ticket that has been scanned in', () => {
  it('reads as admitted, stamped with the scan', async () => {
    await admit(attendeeId, '2026-09-19T11:12:00Z');
    const status = await ticketStatus(token);
    expect(status!.state).toBe('ADMITTED');
    expect(status!.admittedAt?.toISOString()).toBe('2026-09-19T11:12:00.000Z');
  });

  it('reports the earliest scan when a party was scanned twice', async () => {
    // §12.3 accepts duplicate scans from two offline devices rather than
    // attempting distributed locking, so two rows for one attendee is an
    // expected state, not a corruption.
    await admit(attendeeId, '2026-09-19T11:40:00Z');
    await admit(attendeeId, '2026-09-19T11:12:00Z');
    expect((await ticketStatus(token))!.admittedAt?.toISOString()).toBe(
      '2026-09-19T11:12:00.000Z',
    );
  });

  it('goes back to issued when an admin reverts the scan', async () => {
    /**
     * `check_ins` is append-only and a revert stamps `reverted_at` rather than
     * deleting (decision 7). If this page counted reverted rows, an admin
     * undoing a mis-scan would leave the guest's own ticket insisting they are
     * already inside — while the door, which ignores reverted rows, lets them in.
     */
    await admit(attendeeId, '2026-09-19T11:12:00Z');
    await sql`update check_ins set reverted_at = now() where attendee_id = ${attendeeId}`;
    const status = await ticketStatus(token);
    expect(status!.state).toBe('ISSUED');
    expect(status!.admittedAt).toBeNull();
  });

  it('still reads as admitted when one of two scans was reverted', async () => {
    await admit(attendeeId, '2026-09-19T11:12:00Z');
    await admit(attendeeId, '2026-09-19T11:40:00Z');
    await sql`
      update check_ins set reverted_at = now()
       where attendee_id = ${attendeeId} and scanned_at = '2026-09-19T11:12:00Z'
    `;
    const status = await ticketStatus(token);
    expect(status!.state).toBe('ADMITTED');
    expect(status!.admittedAt?.toISOString()).toBe('2026-09-19T11:40:00.000Z');
  });
});

describe('a ticket that is no longer valid', () => {
  it('reads as cancelled when the seat itself is cancelled', async () => {
    await withDirectAttendeeWrites(
      (tx) => tx`update attendees set status = 'CANCELLED' where id = ${attendeeId}`,
    );
    expect((await ticketStatus(token))!.state).toBe('CANCELLED');
  });

  it('reads as cancelled when the whole registration is cancelled', async () => {
    // Through the real mutation: module B cancels the *registration*, and the
    // 0001 cascade is what carries that down to the seat. A page that joined
    // `registrations` itself would pass this and still drift from the door.
    const { cancelRegistration } = await import('@/lib/registrations/mutations');
    await cancelRegistration(registrationId);
    expect((await ticketStatus(token))!.state).toBe('CANCELLED');
    expect((await ticketStatus(otherToken))!.state).toBe('CANCELLED');
  });

  it('says cancelled even for someone who was already scanned in', async () => {
    /**
     * Both facts are true and §13.2 gives cancellation its own terminal
     * message. "See the front desk" sends them to a human who can see the
     * whole picture; a checked-in badge on a cancelled ticket sends them
     * nowhere.
     */
    await admit(attendeeId, '2026-09-19T11:12:00Z');
    const { cancelRegistration } = await import('@/lib/registrations/mutations');
    await cancelRegistration(registrationId);
    expect((await ticketStatus(token))!.state).toBe('CANCELLED');
  });

  it('agrees with the door about which tickets are cancelled', async () => {
    // The manifest reads cancellation off `attendees.status` and so does this.
    // Comparing them directly is what stops the two drifting apart.
    const { cancelRegistration } = await import('@/lib/registrations/mutations');
    await cancelRegistration(registrationId);
    const door = await sql<{ status: string }[]>`
      select status from attendees where id = ${attendeeId}
    `;
    expect(door[0].status).toBe('CANCELLED');
    expect((await ticketStatus(token))!.state).toBe('CANCELLED');
  });
});

describe('a token that resolves to nothing', () => {
  it('is null for a token nobody was ever issued', async () => {
    expect(await ticketStatus('ZzZzZzZzZzZzZzZzZzZzZz')).toBeNull();
  });

  it('is null for a soft-deleted attendee', async () => {
    // The manifest filters `deleted_at is null` too, so a deleted seat is
    // absent from the door and absent here.
    await withDirectAttendeeWrites(
      (tx) => tx`update attendees set deleted_at = now() where id = ${attendeeId}`,
    );
    expect(await ticketStatus(token)).toBeNull();
  });

  it('is null once the registration is soft-deleted, through the cascade', async () => {
    await sql`update registrations set deleted_at = now() where id = ${registrationId}`;
    expect(await ticketStatus(token)).toBeNull();
    expect(await ticketStatus(otherToken)).toBeNull();
  });

  it('is null for anything that is not token-shaped', async () => {
    /**
     * Only the answer is asserted here, not the shortcut that produces it.
     * {@link isTokenShaped} below covers the guard itself; removing the call
     * from `ticketStatus` changes no result, because a junk token matches no
     * row either way. It earns its place by saving the round trip, which is a
     * cost rather than a behaviour — and claiming a test proves it when it
     * does not is how a suite comes to look greener than it is.
     */
    for (const junk of ['', 'x', '../../etc/passwd', `${token}extra`, token.slice(0, 21), "' or 1=1--"]) {
      expect(await ticketStatus(junk)).toBeNull();
    }
  });

  it('does not match a token that differs only in case', async () => {
    // base62 is case-significant, and `qr_token` is `text`, not `citext`. A
    // case-insensitive match would shrink the keyspace for anyone guessing.
    const flipped = token
      .split('')
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join('');
    if (flipped !== token) expect(await ticketStatus(flipped)).toBeNull();
  });
});

describe('the token shape check', () => {
  it('accepts exactly what module D mints', () => {
    expect(isTokenShaped(token)).toBe(true);
    expect(token).toHaveLength(22);
  });

  it('rejects the near misses', () => {
    expect(isTokenShaped('')).toBe(false);
    expect(isTokenShaped('a'.repeat(21))).toBe(false);
    expect(isTokenShaped('a'.repeat(23))).toBe(false);
    expect(isTokenShaped(`${'a'.repeat(21)}-`)).toBe(false);
    expect(isTokenShaped(`${'a'.repeat(21)}\n`)).toBe(false);
  });
});

/**
 * The four settings `O`'s sections read, through the cascade and never off a
 * column (§2.2).
 *
 * These are asserted here rather than in the notes tests because the question
 * is about *this query*: every one of them rides on the same single round trip
 * the portal gets on venue wifi, and a key added to the resolve block without a
 * test is a key that silently resolves to null for ever.
 */
describe('the notes and wall settings', () => {
  const setSetting = async (key: string, value: unknown) => {
    await sql`
      insert into system_settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (key) do update set value = excluded.value
    `;
  };

  it('are all off, and all null, when nobody has configured the concert', async () => {
    const { portal } = (await ticketStatus(token))!;
    expect(portal.notesEnabled).toBe(false);
    expect(portal.publicWallEnabled).toBe(false);
    expect(portal.notesCloseAt).toBeNull();
    expect(portal.noteMaxLength).toBeNull();
    expect(portal.publicWallVisibility).toBeNull();
  });

  it('resolve from the system level when set there', async () => {
    await setSetting('portal.notes_enabled', true);
    await setSetting('portal.notes_close_at', '2026-09-26T16:00:00Z');
    await setSetting('portal.note_max_length', 500);
    await setSetting('portal.public_wall_enabled', true);
    await setSetting('portal.public_wall_visibility', 'AUDIENCE');

    const { portal } = (await ticketStatus(token))!;
    expect(portal.notesEnabled).toBe(true);
    expect(portal.notesCloseAt?.toISOString()).toBe('2026-09-26T16:00:00.000Z');
    expect(portal.noteMaxLength).toBe(500);
    expect(portal.publicWallEnabled).toBe(true);
    expect(portal.publicWallVisibility).toBe('AUDIENCE');
  });

  it('let the concert override the system', async () => {
    await setSetting('portal.notes_enabled', true);
    await sql`
      update concerts
         set defaults = jsonb_build_object('portal.notes_enabled', false)
       where id = ${concertId}
    `;
    expect((await ticketStatus(token))!.portal.notesEnabled).toBe(false);
  });

  /**
   * **Only `true` is true, and only a positive integer is a cap.** Every one of
   * these opens a section of the portal or bounds what it accepts, and the
   * failure direction that matters is the one that publishes something early or
   * refuses every note with no explanation. A hand-edited row is the shape
   * these guard against — the settings screen cannot produce any of them.
   */
  it('read a malformed value as unset rather than guessing at it', async () => {
    await setSetting('portal.notes_enabled', 'true');
    await setSetting('portal.public_wall_enabled', 1);
    await setSetting('portal.public_wall_visibility', 'EVERYONE');
    await setSetting('portal.notes_close_at', 'next Tuesday');
    await setSetting('portal.note_max_length', 0);

    const { portal } = (await ticketStatus(token))!;
    expect(portal.notesEnabled).toBe(false);
    expect(portal.publicWallEnabled).toBe(false);
    expect(portal.publicWallVisibility).toBeNull();
    expect(portal.notesCloseAt).toBeNull();
    expect(portal.noteMaxLength).toBeNull();
  });

  it('reads a negative or fractional length as unset', async () => {
    for (const bad of [-1, 2.5]) {
      await setSetting('portal.note_max_length', bad);
      expect((await ticketStatus(token))!.portal.noteMaxLength).toBeNull();
    }
  });
});
