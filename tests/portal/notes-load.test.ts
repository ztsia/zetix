import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';
import { loadPortalNotes, notesAreOpen } from '@/lib/portal/notes';

/**
 * What the notes section is handed to draw (spec/v2.md §13.4).
 *
 * **The property under test is the addressing rule**, which §13.4 states in
 * the one way that is easy to get wrong: behaviour derives from the attendee's
 * *segment*, not from the show. So the fixture below is the shape this concert
 * actually has — one show, one hall, two segments, both audiences — because a
 * fixture with one audience per show cannot tell a correct implementation from
 * the obvious wrong one.
 */

let concertId: number;
let showId: number;
let publicSegmentId: number;
let playerSegmentId: number;
let playerIds: number[];

/** An attendee in the named segment, optionally invited by a player. */
async function seatIn(
  segmentId: number,
  opts: { playerId?: number | null } = {},
): Promise<number> {
  const registrationId = await createRegistration({
    showId,
    segmentId,
    playerId: opts.playerId ?? null,
  });
  await seedAttendees({ registrationId, showId, segmentId, count: 1, allocationType: 'BASE' });
  const [row] = await sql<{ id: string }[]>`
    select id from attendees where registration_id = ${registrationId} limit 1
  `;
  return Number(row.id);
}

const OPEN = { enabled: true, closeAt: null, maxLength: 500 };

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Notes');
  showId = await createShow(concertId, 200);
  publicSegmentId = await createSegment(showId, { capacity: 100, audienceMode: 'PUBLIC' });
  playerSegmentId = await createSegment(showId, {
    capacity: 100, audienceMode: 'PLAYER_INVITED', baseQuota: 1,
  });
  playerIds = await createPlayers(concertId, 3);
});

describe('who the form offers to address', () => {
  it('prefills the inviting player for a player-invited seat', async () => {
    const attendeeId = await seatIn(playerSegmentId, { playerId: playerIds[1] });

    const result = await loadPortalNotes({ attendeeId, concertId, ...OPEN });
    expect(result.state).toBe('OPEN');
    if (result.state === 'OFF') throw new Error('unreachable');
    expect(result.defaultToPlayerId).toBe(playerIds[1]);
  });

  it('prefills nobody for a public seat in the same show', async () => {
    const attendeeId = await seatIn(publicSegmentId);

    const result = await loadPortalNotes({ attendeeId, concertId, ...OPEN });
    if (result.state === 'OFF') throw new Error('unreachable');
    expect(result.defaultToPlayerId).toBeNull();
  });

  /**
   * The case that separates "read the segment" from "read the show". Both
   * seats are in the same hall on the same night; only the segment says which
   * rule applies, and an implementation reading `shows` would give these two
   * the same answer.
   */
  it('gives two seats in one show different answers, by segment', async () => {
    const invited = await seatIn(playerSegmentId, { playerId: playerIds[0] });
    const publik = await seatIn(publicSegmentId);

    const a = await loadPortalNotes({ attendeeId: invited, concertId, ...OPEN });
    const b = await loadPortalNotes({ attendeeId: publik, concertId, ...OPEN });
    if (a.state === 'OFF' || b.state === 'OFF') throw new Error('unreachable');

    expect(a.defaultToPlayerId).toBe(playerIds[0]);
    expect(b.defaultToPlayerId).toBeNull();
  });

  /**
   * A `PUBLIC` registration has no `player_id` in practice, so the case
   * expression is not what makes public seats unaddressed. It is what stops
   * one inheriting a player if an import or an admin edit ever set the column
   * — the segment decides, not the row.
   */
  it('ignores a player set on a public registration', async () => {
    const attendeeId = await seatIn(publicSegmentId, { playerId: playerIds[2] });

    const result = await loadPortalNotes({ attendeeId, concertId, ...OPEN });
    if (result.state === 'OFF') throw new Error('unreachable');
    expect(result.defaultToPlayerId).toBeNull();
  });

  it('offers every active player on the concert, by name', async () => {
    const attendeeId = await seatIn(publicSegmentId);

    const result = await loadPortalNotes({ attendeeId, concertId, ...OPEN });
    if (result.state === 'OFF') throw new Error('unreachable');
    expect(result.players.map((p) => p.id).sort()).toEqual([...playerIds].sort());
    expect(result.players.map((p) => p.name)).toEqual(
      [...result.players.map((p) => p.name)].sort(),
    );
  });

  it('does not offer a deactivated player', async () => {
    await sql`update players set is_active = false where id = ${playerIds[0]}`;
    const attendeeId = await seatIn(publicSegmentId);

    const result = await loadPortalNotes({ attendeeId, concertId, ...OPEN });
    if (result.state === 'OFF') throw new Error('unreachable');
    expect(result.players.map((p) => p.id)).not.toContain(playerIds[0]);
  });

  it('does not offer another concert’s players', async () => {
    const other = await createConcert('Elsewhere');
    const strangers = await createPlayers(other, 2);
    const attendeeId = await seatIn(publicSegmentId);

    const result = await loadPortalNotes({ attendeeId, concertId, ...OPEN });
    if (result.state === 'OFF') throw new Error('unreachable');
    for (const id of strangers) expect(result.players.map((p) => p.id)).not.toContain(id);
  });
});

describe('the three states', () => {
  it('is OFF, and reads nothing, when notes are disabled', async () => {
    const attendeeId = await seatIn(publicSegmentId);
    const result = await loadPortalNotes({
      attendeeId, concertId, enabled: false, closeAt: null, maxLength: 500,
    });
    expect(result).toEqual({ state: 'OFF' });
  });

  it('is OPEN before the close date', async () => {
    const attendeeId = await seatIn(publicSegmentId);
    const result = await loadPortalNotes({
      attendeeId, concertId, enabled: true, maxLength: 500,
      closeAt: new Date('2099-01-01T00:00:00Z'),
    });
    expect(result.state).toBe('OPEN');
  });

  /**
   * §13.2's call for a closed feedback form, applied here for the same reason:
   * someone who left a note last week and comes back to reread it must find
   * it. A section that vanished at the deadline looks exactly like their note
   * having been deleted.
   */
  it('is CLOSED after it, and still carries the note', async () => {
    const attendeeId = await seatIn(publicSegmentId);
    await sql`
      insert into portal_notes
        (concert_id, show_id, attendee_id, body, display_name, moderation_status, wall_status)
      values (${concertId}, ${showId}, ${attendeeId}, 'Lovely evening.', 'Wei Ling',
              'APPROVED', 'PUBLISHED')
    `;

    const result = await loadPortalNotes({
      attendeeId, concertId, enabled: true, maxLength: 500,
      closeAt: new Date('2020-01-01T00:00:00Z'),
    });
    expect(result.state).toBe('CLOSED');
    if (result.state === 'OFF') throw new Error('unreachable');
    expect(result.existing?.body).toBe('Lovely evening.');
    expect(result.existing?.moderationStatus).toBe('APPROVED');
    expect(result.existing?.wallStatus).toBe('PUBLISHED');
  });

  it('returns the attendee’s own note and not their neighbour’s', async () => {
    const mine = await seatIn(publicSegmentId);
    const theirs = await seatIn(publicSegmentId);
    for (const [id, body] of [[mine, 'Mine.'], [theirs, 'Theirs.']] as const) {
      await sql`
        insert into portal_notes
          (concert_id, show_id, attendee_id, body, moderation_status, wall_status)
        values (${concertId}, ${showId}, ${id}, ${body}, 'PENDING', 'NOT_PUBLISHED')
      `;
    }

    const result = await loadPortalNotes({ attendeeId: mine, concertId, ...OPEN });
    if (result.state === 'OFF') throw new Error('unreachable');
    expect(result.existing?.body).toBe('Mine.');
  });

  it('passes the cap through untouched, including when it is unset', async () => {
    const attendeeId = await seatIn(publicSegmentId);
    const capped = await loadPortalNotes({ attendeeId, concertId, ...OPEN, maxLength: 240 });
    const uncapped = await loadPortalNotes({ attendeeId, concertId, ...OPEN, maxLength: null });
    if (capped.state === 'OFF' || uncapped.state === 'OFF') throw new Error('unreachable');
    expect(capped.maxLength).toBe(240);
    expect(uncapped.maxLength).toBeNull();
  });
});

describe('notesAreOpen', () => {
  const now = new Date('2026-09-20T12:00:00Z');

  it('is false whenever notes are disabled, whatever the date says', () => {
    expect(notesAreOpen({ enabled: false, closeAt: null, now })).toBe(false);
    expect(notesAreOpen({ enabled: false, closeAt: new Date('2099-01-01'), now })).toBe(false);
  });

  it('is open indefinitely with no close date', () => {
    expect(notesAreOpen({ enabled: true, closeAt: null, now })).toBe(true);
  });

  it('closes on the far side of the deadline, and not on the near side', () => {
    expect(notesAreOpen({ enabled: true, closeAt: new Date('2026-09-20T12:00:01Z'), now })).toBe(true);
    expect(notesAreOpen({ enabled: true, closeAt: new Date('2026-09-20T11:59:59Z'), now })).toBe(false);
  });

  /** The boundary itself is inclusive: a deadline is a moment notes are still open. */
  it('is open at exactly the close moment', () => {
    expect(notesAreOpen({ enabled: true, closeAt: now, now })).toBe(true);
  });
});
