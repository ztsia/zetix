import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mintIdentifiers } from '@/lib/tickets/mint';
import { generateTicketCode, parseTicketCode } from '@/lib/tickets/identifiers';
import { resetDb, sql } from '../helpers/db';

/**
 * Only `generateTicketCode` is replaced, and only so a collision can be forced:
 * the real one draws from ~1.05M codes, and the retry branch would otherwise
 * ship untested because the odds cannot be waited for. Every other export —
 * including the token generator, whose properties the suite actually asserts —
 * stays real.
 */
vi.mock('@/lib/tickets/identifiers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tickets/identifiers')>();
  return { ...actual, generateTicketCode: vi.fn(actual.generateTicketCode) };
});
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * Minting, against a real database (spec/tickets.md §10.1).
 *
 * The property that matters most here cannot be tested by reading the code:
 * **a token, once minted, is never replaced.** Decision 28 makes it immutable
 * for the life of the attendee because a guest who kept the first printed copy
 * must still get through the door — and a ticket that has left the building
 * cannot be recalled. So the overwrite paths are probed directly rather than
 * assumed away.
 */

type Fixture = {
  concertId: number;
  showId: number;
  segmentId: number;
  registrationId: number;
};

let fixtureSeq = 0;

async function fixture(count = 3): Promise<Fixture> {
  // `createConcert` derives a unique slug from the name, so two fixtures in one
  // test need two names or the second trips concerts_slug_key.
  const concertId = await createConcert(`Test Concert ${++fixtureSeq}`);
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({ registrationId, showId, segmentId, count, allocationType: 'BASE' });
  return { concertId, showId, segmentId, registrationId };
}

async function identifiers(showId: number) {
  return sql<{ id: string; ticket_code: string | null; qr_token: string | null }[]>`
    select id, ticket_code, qr_token from attendees where show_id = ${showId} order by id
  `;
}

describe('minting ticket identifiers', () => {
  beforeEach(async () => {
    await resetDb();
    fixtureSeq = 0;
    vi.mocked(generateTicketCode).mockReset();
    const actual = await vi.importActual<typeof import('@/lib/tickets/identifiers')>(
      '@/lib/tickets/identifiers',
    );
    vi.mocked(generateTicketCode).mockImplementation(actual.generateTicketCode);
  });

  it('gives every confirmed attendee in the show a code and a token', async () => {
    const { showId } = await fixture(3);

    const result = await mintIdentifiers({ showId });

    expect(result.minted).toBe(3);
    expect(result.alreadyIssued).toBe(0);
    expect(result.attempts).toBe(1);

    const rows = await identifiers(showId);
    for (const row of rows) {
      expect(row.qr_token).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(parseTicketCode(row.ticket_code!)?.normalised).toBe(row.ticket_code);
    }
  });

  it('gives every attendee a different token and a different code', async () => {
    // A party of N is N tickets, one per attendee (decision 31) — not a shared
    // "admits 4" QR. Two attendees sharing a token means the second is refused
    // at the door as already admitted.
    const { showId } = await fixture(25);
    await mintIdentifiers({ showId });

    const rows = await identifiers(showId);
    expect(new Set(rows.map((r) => r.qr_token)).size).toBe(25);
    expect(new Set(rows.map((r) => r.ticket_code)).size).toBe(25);
  });

  it('is idempotent — a second call mints nothing and changes nothing', async () => {
    // This runs immediately before a blast, and an admin will press it twice.
    const { showId } = await fixture(4);
    await mintIdentifiers({ showId });
    const before = await identifiers(showId);

    const again = await mintIdentifiers({ showId });

    expect(again.minted).toBe(0);
    expect(again.alreadyIssued).toBe(4);
    expect(await identifiers(showId)).toEqual(before);
  });

  it('never replaces a token that already exists', async () => {
    // Decision 28, stated as a test rather than a comment. Minting again with a
    // different prefix would be the natural way to trip this.
    const { showId } = await fixture(3);
    await mintIdentifiers({ showId }, { prefix: 'ORC' });
    const before = await identifiers(showId);

    await mintIdentifiers({ showId }, { prefix: 'LCO' });

    const after = await identifiers(showId);
    expect(after.map((r) => r.qr_token)).toEqual(before.map((r) => r.qr_token));
    expect(after.map((r) => r.ticket_code)).toEqual(before.map((r) => r.ticket_code));
  });

  it('does not overwrite a token when two mints race', async () => {
    // The selection filters `qr_token is null`, so the ordinary path never
    // reaches an already-minted row and the `where` on the update looks
    // redundant. It is not: between the select and the update, another request
    // — an impatient admin double-clicking before a blast — can mint the same
    // rows. Without the second guard that update replaces a token which may
    // already be on a printed ticket, and decision 28 is broken silently.
    //
    // Removing `and a.qr_token is null` from the update must turn this red.
    const { showId } = await fixture(5);

    const [first, second] = await Promise.all([
      mintIdentifiers({ showId }),
      mintIdentifiers({ showId }),
    ]);

    const rows = await identifiers(showId);
    expect(rows.every((r) => r.qr_token !== null)).toBe(true);
    // Every attendee minted exactly once between the two calls, never twice.
    expect(first.minted + second.minted).toBe(5);
    expect(new Set(rows.map((r) => r.qr_token)).size).toBe(5);
  });

  it('mints only the attendees that are missing identifiers', async () => {
    const { showId } = await fixture(4);
    const rows = await identifiers(showId);
    await withDirectAttendeeWrites(
      (tx) => tx`
        update attendees set qr_token = 'AAAAAAAAAAAAAAAAAAAAAA', ticket_code = 'ORC-AAAA'
         where id = ${Number(rows[0].id)}
      `,
    );

    const result = await mintIdentifiers({ showId });

    expect(result.minted).toBe(3);
    expect(result.alreadyIssued).toBe(1);
    const after = await identifiers(showId);
    expect(after[0].qr_token).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('skips attendees who hold no seat yet', async () => {
    // WAITLIST and PENDING_REVIEW rows have not been granted (spec/allocation.md
    // §7.5). A scannable ticket for an ungranted seat is worse than no ticket.
    const concertId = await createConcert();
    const showId = await createShow(concertId, 100);
    const segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
    const registrationId = await createRegistration({ showId, segmentId });
    await seedAttendees({
      registrationId, showId, segmentId, count: 2, allocationType: 'BASE',
    });
    await seedAttendees({
      registrationId, showId, segmentId, count: 1,
      allocationType: 'EXTRA', status: 'PENDING_REVIEW',
    });
    await seedAttendees({
      registrationId, showId, segmentId, count: 1,
      allocationType: 'EXTRA', status: 'WAITLIST',
    });

    const result = await mintIdentifiers({ showId });

    expect(result.minted).toBe(2);
    const rows = await sql<{ status: string; qr_token: string | null }[]>`
      select status, qr_token from attendees where show_id = ${showId}
    `;
    for (const row of rows) {
      expect(Boolean(row.qr_token), `${row.status} should not be ticketed`).toBe(
        row.status === 'CONFIRMED',
      );
    }
  });

  it('scopes to a segment when asked', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 200);
    const a = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
    const b = await createSegment(showId, { capacity: 50, audienceMode: 'PLAYER_INVITED' });
    const regA = await createRegistration({ showId, segmentId: a });
    const regB = await createRegistration({ showId, segmentId: b });
    await seedAttendees({
      registrationId: regA, showId, segmentId: a, count: 2, allocationType: 'BASE',
    });
    await seedAttendees({
      registrationId: regB, showId, segmentId: b, count: 2, allocationType: 'BASE',
    });

    const result = await mintIdentifiers({ segmentId: a });

    expect(result.minted).toBe(2);
    const rows = await sql<{ segment_id: string; qr_token: string | null }[]>`
      select segment_id, qr_token from attendees where show_id = ${showId}
    `;
    for (const row of rows) {
      expect(Boolean(row.qr_token)).toBe(Number(row.segment_id) === a);
    }
  });

  it('mints nothing for an empty id list rather than everything', async () => {
    // `in ()` is a syntax error, and the tempting shortcut — dropping the clause
    // when the list is empty — would mint across every concert in the database.
    const { showId } = await fixture(3);

    const result = await mintIdentifiers({ attendeeIds: [] });

    expect(result.minted).toBe(0);
    const rows = await identifiers(showId);
    expect(rows.every((r) => r.qr_token === null)).toBe(true);
  });

  it('refuses to run with no scope at all', async () => {
    await fixture(2);
    await expect(mintIdentifiers({})).rejects.toThrow(/needs a scope/);
  });

  it('leaves a cancelled registration alone without clearing what it holds', async () => {
    // §7.9: a delivered ticket stays delivered so the door can say "cancelled —
    // refer to desk" rather than "not found".
    const { showId, registrationId } = await fixture(2);
    await mintIdentifiers({ showId });
    const before = await identifiers(showId);

    await sql`update registrations set status = 'CANCELLED' where id = ${registrationId}`;
    const result = await mintIdentifiers({ showId });

    expect(result.minted).toBe(0);
    expect(await identifiers(showId)).toEqual(before);
  });

  it('survives a ticket_code collision by retrying with fresh values', async () => {
    // Four Crockford symbols is ~1.05M codes, so a collision is a real
    // low-percentage event at lifetime scale rather than a theoretical one, and
    // the retry is the only thing between it and a failed pre-blast mint.
    //
    // The odds cannot be waited for, so the generator is forced to hand back an
    // already-taken code once. Without this the retry branch ships untested.
    const other = await fixture(1);
    const taken = 'ORC-ZZZZ';
    await withDirectAttendeeWrites(
      (tx) => tx`
        update attendees set ticket_code = ${taken}, qr_token = 'BBBBBBBBBBBBBBBBBBBBBB'
         where show_id = ${other.showId}
      `,
    );

    const { showId } = await fixture(1);
    vi.mocked(generateTicketCode).mockReturnValueOnce(taken);

    const result = await mintIdentifiers({ showId });

    expect(result.attempts).toBe(2);
    expect(result.minted).toBe(1);
    const rows = await identifiers(showId);
    expect(rows[0].ticket_code).not.toBe(taken);
    expect(parseTicketCode(rows[0].ticket_code!)).not.toBeNull();
  });

  it('gives up rather than looping forever when every code collides', async () => {
    // Exhausting the attempts means something is actually wrong — a `random`
    // that stopped being random — and an admin needs an error the night before
    // a blast, not a hung request.
    const other = await fixture(1);
    const taken = 'ORC-ZZZZ';
    await withDirectAttendeeWrites(
      (tx) => tx`
        update attendees set ticket_code = ${taken}, qr_token = 'CCCCCCCCCCCCCCCCCCCCCC'
         where show_id = ${other.showId}
      `,
    );

    const { showId } = await fixture(1);
    vi.mocked(generateTicketCode).mockReturnValue(taken);

    await expect(mintIdentifiers({ showId })).rejects.toThrow();

    const rows = await identifiers(showId);
    expect(rows[0].qr_token).toBeNull();
  });
});
