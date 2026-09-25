import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createSegment,
  createShow,
} from '../helpers/fixtures';
import { ensureConcertTemplates, resolveTemplateForShow } from '@/lib/tickets/seed-templates';
import { purposeFor } from '@/lib/email/templates';
import {
  addAttendees,
  cancelRegistration,
  createRegistration,
  moveRegistration,
  removeAttendee,
  renameAttendee,
  restoreRegistration,
  updateRegistrationDetails,
  type NewSeat,
} from '@/lib/registrations/mutations';

/**
 * Manual registrations, attendee editing, cancellation and restore
 * (spec/allocation.md §7.6, §7.9).
 *
 * These run against a real local Postgres because the behaviour under test is
 * mostly the database's: the cancel cascade, the deferred composite foreign key
 * that lets a move happen at all, and the engine deciding what a manually
 * created party actually gets.
 */

type Seat = {
  id: number;
  status: string;
  allocation_type: string;
  full_name: string;
  name_source: string;
  segment_id: number;
  show_id: number;
  deleted_at: string | null;
  qr_token: string | null;
  ticket_sent_at: string | null;
};

async function seatsOf(registrationId: number): Promise<Seat[]> {
  const rows = await sql<Seat[]>`
    select id, status, allocation_type, full_name, name_source, segment_id,
           show_id, deleted_at, qr_token, ticket_sent_at
      from attendees where registration_id = ${registrationId} order by id
  `;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

async function registrationRow(id: number) {
  const [row] = await sql<{ status: string; segment_id: string; show_id: string }[]>`
    select status, segment_id, show_id from registrations where id = ${id}
  `;
  return row;
}

/** A public segment with room, in a hall with room. */
async function publicSegment(opts: { hall?: number; capacity?: number } = {}) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, opts.hall ?? 20);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: opts.capacity ?? 10,
    extrasPolicy: 'AUTO_FCFS',
  });
  return { concertId, showId, segmentId };
}

const guests = (n: number, type: 'BASE' | 'EXTRA' = 'EXTRA'): NewSeat[] =>
  Array.from({ length: n }, (_, i) => ({
    fullName: `Guest ${i + 1}`,
    allocationType: type,
  }));

describe('createRegistration', () => {
  beforeEach(resetDb);

  it('creates a party and grants its seats through the engine', async () => {
    const { segmentId } = await publicSegment();

    const result = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      contactEmail: 'alice@example.test',
      seats: guests(3),
    });

    expect(result.granted.extra).toBe(3);
    expect((await registrationRow(result.registrationId)).status).toBe('CONFIRMED');
    const seats = await seatsOf(result.registrationId);
    expect(seats).toHaveLength(3);
    expect(seats.every((s) => s.status === 'CONFIRMED')).toBe(true);
  });

  it('records the source as ADMIN and keeps the requested_at it was given', async () => {
    const { segmentId } = await publicSegment();
    const requestedAt = new Date('2026-09-01T02:30:00.000Z');

    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Late Arrival',
      requestedAt,
      seats: guests(1),
    });

    const [row] = await sql<{ source: string; requested_at: Date }[]>`
      select source, requested_at from registrations where id = ${registrationId}
    `;
    expect(row.source).toBe('ADMIN');
    // The FCFS key is what the admin said it was, not the moment they typed it:
    // a request entered late still belongs where it arrived in the queue (§7.4).
    expect(new Date(row.requested_at).toISOString()).toBe(requestedAt.toISOString());
  });

  /**
   * §7.6: "Admin can create a registration against any segment **bypassing form
   * windows**". A closed form, or no form at all, must not stop it.
   */
  it('creates against a segment whose form is closed', async () => {
    const { segmentId } = await publicSegment();
    await sql`
      insert into registration_forms (segment_id, kind, title, slug, status, closes_at)
      values (${segmentId}, 'PUBLIC', 'Round 1', 'round-1', 'CLOSED', now() - interval '2 days')
    `;

    const result = await createRegistration({
      segmentId,
      contactName: 'After The Cutoff',
      seats: guests(2),
    });

    expect(result.granted.extra).toBe(2);
  });

  it('holds extras for review in a REVIEW segment, consuming no seat', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 20);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 10,
      baseQuota: 1,
      extrasPolicy: 'REVIEW',
    });
    const [playerId] = await createPlayers(concertId, 1);

    const result = await createRegistration({
      segmentId,
      playerId,
      contactName: 'Player One',
      seats: [
        { fullName: 'Player One', allocationType: 'BASE' },
        ...guests(2),
      ],
    });

    expect(result.granted.base).toBe(1);
    expect(result.pending).toBe(2);
    const [pool] = await sql<{ segment_pool: { confirmed: number } }[]>`
      select segment_pool(${segmentId}::bigint)
    `;
    expect(pool.segment_pool.confirmed).toBe(1);
    expect((await registrationRow(result.registrationId)).status).toBe('CONFIRMED');
  });

  it('waitlists a party that does not fit, and says so', async () => {
    const { segmentId } = await publicSegment({ hall: 2, capacity: 2 });

    const result = await createRegistration({
      segmentId,
      contactName: 'Too Many',
      seats: guests(3),
    });

    expect(result.granted.extra).toBe(0);
    expect(result.waitlisted).toBe(3);
    expect((await registrationRow(result.registrationId)).status).toBe('WAITLIST');
  });

  it('seats a party past the hall when the override is taken', async () => {
    const { segmentId } = await publicSegment({ hall: 2, capacity: 2 });

    const result = await createRegistration({
      segmentId,
      contactName: 'Guest Of Honour',
      seats: guests(3),
      override: true,
    });

    expect(result.granted.extra).toBe(3);
  });

  it('refuses a party of nobody', async () => {
    const { segmentId } = await publicSegment();
    await expect(
      createRegistration({ segmentId, contactName: 'Nobody', seats: [] }),
    ).rejects.toThrow(/at least one seat/);
  });

  it('names an unnamed seat after the contact rather than leaving it blank', async () => {
    const { segmentId } = await publicSegment();

    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: [{ allocationType: 'EXTRA' }],
    });

    const [seat] = await seatsOf(registrationId);
    expect(seat.full_name).toBe('Guest of Alice Tan');
    expect(seat.name_source).toBe('PLACEHOLDER');
  });
});

describe('attendee editing', () => {
  beforeEach(resetDb);

  it('adds a seat to an existing party without disturbing the others', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(2),
    });
    const before = await seatsOf(registrationId);

    const result = await addAttendees(registrationId, [
      { fullName: 'Fourth Guest', allocationType: 'EXTRA' },
    ]);

    expect(result.confirmed).toBe(1);
    const after = await seatsOf(registrationId);
    expect(after).toHaveLength(3);
    // The added-guest case of email.md §11.4 depends on the existing seats
    // being left exactly as they were.
    expect(after.slice(0, 2).map((s) => s.id)).toEqual(before.map((s) => s.id));
  });

  it('keeps a confirmed party confirmed when an added seat waitlists', async () => {
    const { segmentId } = await publicSegment({ hall: 2, capacity: 2 });
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(2),
    });

    const result = await addAttendees(registrationId, [
      { fullName: 'One Too Many', allocationType: 'EXTRA' },
    ]);

    expect(result.waitlisted).toBe(1);
    expect((await registrationRow(registrationId)).status).toBe('CONFIRMED');
  });

  it('refuses to add a seat to a cancelled registration', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Gone',
      seats: guests(1),
    });
    await cancelRegistration(registrationId);

    await expect(
      addAttendees(registrationId, [{ fullName: 'Nope', allocationType: 'EXTRA' }]),
    ).rejects.toThrow(/cancelled/);
  });

  it('renames a seat, and reverts to the placeholder when the name is cleared', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(1),
    });
    const [seat] = await seatsOf(registrationId);

    await renameAttendee(seat.id, '  Bernard Lim  ');
    expect((await seatsOf(registrationId))[0]).toMatchObject({
      full_name: 'Bernard Lim',
      name_source: 'PROVIDED',
    });

    await renameAttendee(seat.id, '   ');
    expect((await seatsOf(registrationId))[0]).toMatchObject({
      full_name: 'Guest of Alice Tan',
      name_source: 'PLACEHOLDER',
    });
  });

  it('flags a delivered ticket for reissue when the printed name changes', async () => {
    const { concertId, showId, segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(1),
    });
    const [seat] = await seatsOf(registrationId);

    // A delivered ticket, pinned to one of module D's real seeded templates —
    // which all print `attendee.full_name`. A hand-rolled layout here would
    // only test this file's idea of the §10.2 format.
    await ensureConcertTemplates(concertId);
    const template = await resolveTemplateForShow(showId);
    await sql`
      update attendees
         set ticket_template_id = ${template.id},
             ticket_template_version = ${template.version},
             ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
       where id = ${seat.id}
    `;

    await renameAttendee(seat.id, 'Corrected Name');

    const [row] = await sql<{ needs_reissue: boolean }[]>`
      select needs_reissue from attendees where id = ${seat.id}
    `;
    expect(row.needs_reissue).toBe(true);
  });

  it('removes a seat by soft delete, returning it to the segment', async () => {
    const { segmentId } = await publicSegment({ hall: 3, capacity: 3 });
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(3),
    });
    const seats = await seatsOf(registrationId);

    await removeAttendee(seats[2].id);

    const [pool] = await sql<{ segment_pool: { confirmed: number; extras_pool: number } }[]>`
      select segment_pool(${segmentId}::bigint)
    `;
    expect(pool.segment_pool.confirmed).toBe(2);
    expect(pool.segment_pool.extras_pool).toBe(1);

    const removed = (await seatsOf(registrationId)).find((s) => s.id === seats[2].id);
    // Soft delete only (decision 7) — the row and its token survive.
    expect(removed).toMatchObject({ status: 'CANCELLED' });
    expect(removed?.deleted_at).not.toBeNull();
  });

  it('edits contact details without touching the seats', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      contactEmail: 'alice@example.test',
      seats: guests(2),
    });

    await updateRegistrationDetails(registrationId, {
      contactName: 'Alice Tan',
      contactEmail: 'alice.tan@example.test',
      contactPhone: '+60 12-345 6789',
      roundLabel: 'Round 2',
    });

    const [row] = await sql<{ contact_email: string; round_label: string }[]>`
      select contact_email, round_label from registrations where id = ${registrationId}
    `;
    expect(row).toMatchObject({
      contact_email: 'alice.tan@example.test',
      round_label: 'Round 2',
    });
    expect(await seatsOf(registrationId)).toHaveLength(2);
  });
});

describe('moveRegistration', () => {
  beforeEach(resetDb);

  async function twoSegments() {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 20);
    const player = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 10,
      baseQuota: 1,
      extrasPolicy: 'AUTO_FCFS',
      name: 'Player invited',
    });
    const publicId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
      name: 'Public',
    });
    return { concertId, showId, player, publicId };
  }

  it('moves the registration and its seats together', async () => {
    const { showId, player, publicId } = await twoSegments();
    const { registrationId } = await createRegistration({
      segmentId: publicId,
      contactName: 'Alice Tan',
      seats: guests(3),
    });

    const result = await moveRegistration(registrationId, player);

    expect(result.movedSeats).toBe(3);
    expect(await registrationRow(registrationId)).toMatchObject({
      segment_id: String(player),
      show_id: String(showId),
    });
    const seats = await seatsOf(registrationId);
    expect(seats.every((s) => Number(s.segment_id) === player)).toBe(true);
  });

  it('keeps every qr_token through the move', async () => {
    const { player, publicId } = await twoSegments();
    const { registrationId } = await createRegistration({
      segmentId: publicId,
      contactName: 'Ticket Holder',
      seats: guests(2),
    });
    await sql`
      update attendees set qr_token = 'tok-' || id, ticket_code = 'TC' || id
       where registration_id = ${registrationId}
    `;
    const before = await seatsOf(registrationId);

    await moveRegistration(registrationId, player);

    const after = await seatsOf(registrationId);
    expect(after.map((s) => s.qr_token)).toEqual(before.map((s) => s.qr_token));
  });

  /**
   * A BASE seat means "part of a player's entitlement", and a PUBLIC segment
   * owes nobody one — `segment_pool()` does not count base there at all.
   */
  it('converts a BASE seat to EXTRA when moving into a public segment', async () => {
    const { concertId, player, publicId } = await twoSegments();
    const [playerId] = await createPlayers(concertId, 1);
    const { registrationId } = await createRegistration({
      segmentId: player,
      playerId,
      contactName: 'Player One',
      seats: [{ fullName: 'Player One', allocationType: 'BASE' }],
    });

    await moveRegistration(registrationId, publicId);

    expect((await seatsOf(registrationId))[0].allocation_type).toBe('EXTRA');
  });

  it('refuses a move into a segment with no room, naming the numbers', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 20);
    const roomy = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
      name: 'Public',
    });
    const tiny = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 1,
      baseQuota: 1,
      extrasPolicy: 'AUTO_FCFS',
      name: 'Player invited',
    });
    const { registrationId } = await createRegistration({
      segmentId: roomy,
      contactName: 'Party Of Three',
      seats: guests(3),
    });

    // The database's own sentence, which the dialog renders verbatim.
    await expect(moveRegistration(registrationId, tiny)).rejects.toThrow(
      /already has 3 confirmed seats/,
    );
    // Refused whole: nothing moved.
    expect(await registrationRow(registrationId)).toMatchObject({
      segment_id: String(roomy),
    });
  });

  it('moves into a full segment when the override is taken', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 20);
    const roomy = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
      name: 'Public',
    });
    const tiny = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 1,
      baseQuota: 1,
      extrasPolicy: 'AUTO_FCFS',
      name: 'Player invited',
    });
    const { registrationId } = await createRegistration({
      segmentId: roomy,
      contactName: 'Party Of Three',
      seats: guests(3),
    });

    const result = await moveRegistration(registrationId, tiny, { override: true });

    expect(result.movedSeats).toBe(3);
    expect(await registrationRow(registrationId)).toMatchObject({
      segment_id: String(tiny),
    });
  });

  it('refuses a move to another concert', async () => {
    const { publicId } = await twoSegments();
    const otherConcert = await createConcert('Other Concert');
    const otherShow = await createShow(otherConcert, 20);
    const elsewhere = await createSegment(otherShow, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const { registrationId } = await createRegistration({
      segmentId: publicId,
      contactName: 'Alice Tan',
      seats: guests(1),
    });

    await expect(moveRegistration(registrationId, elsewhere)).rejects.toThrow(
      /within its own concert/,
    );
  });

  it('is a no-op when the destination is where it already is', async () => {
    const { publicId } = await twoSegments();
    const { registrationId } = await createRegistration({
      segmentId: publicId,
      contactName: 'Alice Tan',
      seats: guests(1),
    });

    expect(await moveRegistration(registrationId, publicId)).toMatchObject({
      movedSeats: 0,
    });
  });
});

describe('cancelRegistration', () => {
  beforeEach(resetDb);

  it('frees the seats and reports what is waiting', async () => {
    const { segmentId } = await publicSegment({ hall: 4, capacity: 4 });
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(3),
    });
    // A party that could not fit behind them.
    await createRegistration({
      segmentId,
      contactName: 'Waiting Party',
      seats: guests(2),
    });

    const result = await cancelRegistration(registrationId);

    expect(result.seatsFreed).toBe(3);
    expect(result.seatsWaiting).toBe(2);
    const [pool] = await sql<{ segment_pool: { extras_pool: number } }[]>`
      select segment_pool(${segmentId}::bigint)
    `;
    expect(pool.segment_pool.extras_pool).toBe(4);
  });

  it('cancels every seat in the party', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(2),
    });

    await cancelRegistration(registrationId);

    expect((await registrationRow(registrationId)).status).toBe('CANCELLED');
    expect((await seatsOf(registrationId)).every((s) => s.status === 'CANCELLED')).toBe(
      true,
    );
  });

  /**
   * §7.9: cancelling "never clears `ticket_sent_at` — a ticket that was
   * delivered was delivered, and the door needs to know the code exists so it
   * can show 'cancelled — refer to desk' rather than 'not found'".
   */
  it('leaves ticket_sent_at and qr_token alone', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(1),
    });
    await sql`
      update attendees set qr_token = 'tok-kept', ticket_code = 'TCKEPT',
             ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
       where registration_id = ${registrationId}
    `;

    await cancelRegistration(registrationId);

    const [seat] = await seatsOf(registrationId);
    expect(seat.qr_token).toBe('tok-kept');
    expect(seat.ticket_sent_at).not.toBeNull();
  });

  it('withdraws pending outbox messages but not one already sent or in flight', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(1),
    });
    const other = await createRegistration({
      segmentId,
      contactName: 'Someone Else',
      seats: guests(1),
    });
    for (const [key, status] of [
      ['extras_granted', 'DRAFT'],
      ['public_ticket', 'QUEUED'],
      ['reminder', 'SENT'],
    ] as const) {
      await sql`
        insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md,
                                  status)
        values (${registrationId}, ${purposeFor(key)}::message_purpose, ${key},
                'alice@example.test', 'Subject', 'Body', ${status})
      `;
    }
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md,
                                status)
      values (${other.registrationId}, 'TICKETS', 'public_ticket', 'other@example.test', 'S', 'B',
              'QUEUED')
    `;

    const result = await cancelRegistration(registrationId);

    expect(result.outboxCancelled).toBe(2);
    const rows = await sql<{ template_key: string; status: string }[]>`
      select template_key, status from email_outbox
       where registration_id = ${registrationId} order by template_key
    `;
    expect(rows).toEqual([
      { template_key: 'extras_granted', status: 'CANCELLED' },
      { template_key: 'public_ticket', status: 'CANCELLED' },
      { template_key: 'reminder', status: 'SENT' },
    ]);
    // Another party's queued message is none of this cancellation's business.
    const [untouched] = await sql<{ status: string }[]>`
      select status from email_outbox where registration_id = ${other.registrationId}
    `;
    expect(untouched.status).toBe('QUEUED');
  });

  it('is harmless when pressed twice', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(1),
    });

    await cancelRegistration(registrationId);
    expect(await cancelRegistration(registrationId)).toMatchObject({ seatsFreed: 0 });
  });
});

describe('restoreRegistration', () => {
  beforeEach(resetDb);

  it('brings the seats back when the room is still there', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(2),
    });
    await cancelRegistration(registrationId);

    const result = await restoreRegistration(registrationId);

    expect(result).toMatchObject({ confirmed: 2, refused: null });
    expect((await registrationRow(registrationId)).status).toBe('CONFIRMED');
  });

  it('keeps the original qr_tokens rather than minting new seats', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Ticket Holder',
      seats: guests(2),
    });
    await sql`
      update attendees set qr_token = 'tok-' || id, ticket_code = 'TC' || id
       where registration_id = ${registrationId}
    `;
    const before = await seatsOf(registrationId);
    await cancelRegistration(registrationId);

    await restoreRegistration(registrationId);

    const after = await seatsOf(registrationId);
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after.map((s) => s.qr_token)).toEqual(before.map((s) => s.qr_token));
  });

  it('returns extras to review rather than granting them, in a REVIEW segment', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 20);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 10,
      baseQuota: 1,
      extrasPolicy: 'REVIEW',
    });
    const [playerId] = await createPlayers(concertId, 1);
    const { registrationId } = await createRegistration({
      segmentId,
      playerId,
      contactName: 'Player One',
      seats: [{ fullName: 'Player One', allocationType: 'BASE' }, ...guests(2)],
    });
    await cancelRegistration(registrationId);

    const result = await restoreRegistration(registrationId);

    // The base seat is owed and comes back; the extras were never granted and
    // go back to the queue the review screen reads.
    expect(result).toMatchObject({ confirmed: 1, pending: 2 });
    const seats = await seatsOf(registrationId);
    expect(seats.filter((s) => s.status === 'PENDING_REVIEW')).toHaveLength(2);
  });

  it('restores the booking but waitlists the seats when the room is gone', async () => {
    const { segmentId } = await publicSegment({ hall: 3, capacity: 3 });
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(3),
    });
    await cancelRegistration(registrationId);
    // Somebody else took the room in the meantime.
    await createRegistration({
      segmentId,
      contactName: 'Faster Party',
      seats: guests(3),
    });

    const result = await restoreRegistration(registrationId);

    expect(result.confirmed).toBe(0);
    expect(result.waitlisted).toBe(3);
    expect(result.refused).toMatch(/over/);
    // The booking is back either way — that is what the admin asked for.
    expect((await registrationRow(registrationId)).status).toBe('WAITLIST');
  });

  it('confirms past the ceiling when the override is taken', async () => {
    const { segmentId } = await publicSegment({ hall: 3, capacity: 3 });
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(3),
    });
    await cancelRegistration(registrationId);
    await createRegistration({
      segmentId,
      contactName: 'Faster Party',
      seats: guests(3),
    });

    const result = await restoreRegistration(registrationId, { override: true });

    expect(result).toMatchObject({ confirmed: 3, refused: null });
  });

  it('refuses to restore something that is not cancelled', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(1),
    });

    await expect(restoreRegistration(registrationId)).rejects.toThrow(/not cancelled/);
  });
});

describe('the party cap', () => {
  beforeEach(resetDb);

  /**
   * `form.max_tickets_per_response` is an operational value: it cascades
   * segment → show → concert → system and has no default in code (CLAUDE.md,
   * spec/domain.md §6). A QA pass found this module enforcing a literal 50
   * instead — so the cap an admin had actually configured went unread while an
   * invented one was enforced.
   *
   * These test the resolution, not a Server Action: the action is a thin
   * boundary around the same `resolve_setting()` call, and what must never
   * regress is that the number comes from the cascade.
   */
  it('resolves from the segment, and reads null as no cap rather than zero', async () => {
    const { segmentId } = await publicSegment();

    const [unset] = await sql<{ cap: number | null }[]>`
      select (resolve_setting('form.max_tickets_per_response', ${segmentId}) #>> '{}')::int as cap
    `;
    expect(unset.cap).toBeNull();

    await sql`
      update show_segments set max_tickets_per_response = 4 where id = ${segmentId}
    `;
    const [set] = await sql<{ cap: number | null }[]>`
      select (resolve_setting('form.max_tickets_per_response', ${segmentId}) #>> '{}')::int as cap
    `;
    expect(set.cap).toBe(4);
  });

  it('inherits the cap from the concert when the segment does not set one', async () => {
    const { concertId, segmentId } = await publicSegment();
    await sql`
      update concerts
         set defaults = '{"form.max_tickets_per_response": 2}'::jsonb
       where id = ${concertId}
    `;

    const [row] = await sql<{ cap: number | null }[]>`
      select (resolve_setting('form.max_tickets_per_response', ${segmentId}) #>> '{}')::int as cap
    `;
    expect(row.cap).toBe(2);
  });

  /**
   * The cap bounds a party, and a party grows: seats added later are the route
   * around a check that only looked at one form submission.
   */
  it('counts the seats a party already holds, not just the ones being added', async () => {
    const { segmentId } = await publicSegment();
    await sql`
      update show_segments set max_tickets_per_response = 3 where id = ${segmentId}
    `;
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Alice Tan',
      seats: guests(2),
    });

    const [row] = await sql<{ seats: number }[]>`
      select count(*)::int as seats from attendees
       where registration_id = ${registrationId}
         and deleted_at is null and status <> 'CANCELLED'
    `;
    // Two held plus two more is four, above the three this segment allows —
    // which the action refuses before it reaches the engine.
    expect(row.seats).toBe(2);
  });
});
