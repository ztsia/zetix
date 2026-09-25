import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow } from '../helpers/fixtures';
import {
  AdmittedAttendeeError,
  createRegistration,
  deleteRegistration,
  type NewSeat,
} from '@/lib/registrations/mutations';

/**
 * Deleting a registration (spec/allocation.md §7.6's manual CRUD).
 *
 * Against real Postgres, because almost everything interesting here is the
 * database's: whether the freed seats come back to the segment is decided by
 * `segment_pool()`'s own `deleted_at` filters, not by anything this module
 * does. Asserting that against a mock would prove only that the mock agrees
 * with itself.
 *
 * The distinction under test throughout is **delete is not cancel**: a
 * cancellation says a real booking is not coming and stays in the record; a
 * delete says the row should never have existed and leaves every screen.
 */
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

const guests = (n: number): NewSeat[] =>
  Array.from({ length: n }, (_, i) => ({ fullName: `Guest ${i + 1}`, allocationType: 'EXTRA' }));

/** `segment_pool()` returns one jsonb document, not a row (§7.2). */
async function poolConfirmed(segmentId: number): Promise<number> {
  const [row] = await sql<{ pool: { confirmed: number } }[]>`
    select segment_pool(${segmentId}::bigint) as pool
  `;
  return row.pool.confirmed;
}

describe('the rows leave every screen', () => {
  beforeEach(resetDb);

  it('soft-deletes the registration and all of its seats', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Duplicate Import',
      contactEmail: 'dupe@example.test',
      seats: guests(3),
    });

    const result = await deleteRegistration(registrationId);

    expect(result.attendeesDeleted).toBe(3);
    const [reg] = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from registrations where id = ${registrationId}
    `;
    expect(reg.deleted_at).not.toBeNull();

    const seats = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from attendees where registration_id = ${registrationId}
    `;
    expect(seats).toHaveLength(3);
    expect(seats.every((s) => s.deleted_at !== null)).toBe(true);
  });

  /**
   * Nothing is removed, and that is load-bearing rather than a retention
   * preference: `qr_token` and `ticket_code` are immutable for life
   * (decision 28), and a hard delete would let Postgres issue the same ticket
   * code again — so a printed ticket already in someone's pocket could come to
   * name a different guest.
   */
  it('keeps the rows, so an issued ticket code can never be handed out twice', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Test Party',
      seats: guests(2),
    });
    const before = await sql<{ ticket_code: string }[]>`
      select ticket_code from attendees where registration_id = ${registrationId} order by id
    `;

    await deleteRegistration(registrationId);

    const after = await sql<{ ticket_code: string }[]>`
      select ticket_code from attendees where registration_id = ${registrationId} order by id
    `;
    expect(after.map((r) => r.ticket_code)).toEqual(before.map((r) => r.ticket_code));
  });
});

describe('the seats come back', () => {
  beforeEach(resetDb);

  it("returns the deleted party's seats to the segment", async () => {
    const { segmentId } = await publicSegment({ capacity: 10 });
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Occupies Four',
      seats: guests(4),
    });
    expect(await poolConfirmed(segmentId)).toBe(4);

    const result = await deleteRegistration(registrationId);

    expect(result.seatsFreed).toBe(4);
    // Reported, not enacted: `segment_pool()` filters `deleted_at` itself.
    expect(await poolConfirmed(segmentId)).toBe(0);
  });

  it('lets the freed seats be claimed by someone else', async () => {
    const { segmentId } = await publicSegment({ capacity: 4, hall: 4 });
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Fills The Segment',
      seats: guests(4),
    });

    // Full: the next party cannot be confirmed.
    const blocked = await createRegistration({
      segmentId,
      contactName: 'Turned Away',
      seats: guests(1),
    });
    expect(blocked.granted.extra).toBe(0);

    await deleteRegistration(registrationId);

    const after = await createRegistration({
      segmentId,
      contactName: 'Gets The Room',
      seats: guests(2),
    });
    expect(after.granted.extra).toBe(2);
  });
});

describe('queued mail is withdrawn', () => {
  beforeEach(resetDb);

  /**
   * A draft left behind is sent by the next dispatcher run to a registrant
   * whose booking has just been deleted, carrying tickets for seats that no
   * longer exist.
   */
  it('cancels drafted and queued messages in the same transaction', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Has Mail',
      contactEmail: 'mail@example.test',
      seats: guests(1),
    });
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md,
                                status)
      values (${registrationId}, 'TICKETS', 'public_ticket', 'mail@example.test', 'Your tickets',
              'Body', 'DRAFT'),
             (${registrationId}, 'REMINDER', 'reminder', 'mail@example.test', 'Reminder', 'Body',
              'QUEUED')
    `;

    const result = await deleteRegistration(registrationId);

    expect(result.outboxCancelled).toBe(2);
    const rows = await sql<{ status: string }[]>`
      select status from email_outbox where registration_id = ${registrationId}
    `;
    expect(rows.every((r) => r.status === 'CANCELLED')).toBe(true);
  });

  /** A message already sent is a fact, not a plan; it must not be rewritten. */
  it('leaves an already-sent message alone', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Already Mailed',
      contactEmail: 'sent@example.test',
      seats: guests(1),
    });
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md,
                                status, sent_at)
      values (${registrationId}, 'TICKETS', 'public_ticket', 'sent@example.test', 'Your tickets',
              'Body', 'SENT', now())
    `;

    const result = await deleteRegistration(registrationId);

    expect(result.outboxCancelled).toBe(0);
    const [row] = await sql<{ status: string }[]>`
      select status from email_outbox where registration_id = ${registrationId}
    `;
    expect(row.status).toBe('SENT');
  });
});

describe('a guest who is already inside', () => {
  beforeEach(resetDb);

  async function admit(registrationId: number) {
    const [seat] = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${registrationId} order by id limit 1
    `;
    await sql`
      insert into check_ins (attendee_id, show_id, scanned_at, source)
      select ${seat.id}, show_id, now(), 'ONLINE' from attendees where id = ${seat.id}
    `;
    return Number(seat.id);
  }

  /**
   * `check_ins` is append-only (decision 7). Deleting the attendee would leave
   * an admission referring to nobody and drop a person the ushers actually saw
   * out of the arrivals count, so the delete is refused and the admin is sent
   * to revert the check-in first.
   */
  it('refuses to delete a party holding a live check-in', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Already Admitted',
      seats: guests(2),
    });
    await admit(registrationId);

    await expect(deleteRegistration(registrationId)).rejects.toThrow(AdmittedAttendeeError);

    const [reg] = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from registrations where id = ${registrationId}
    `;
    expect(reg.deleted_at).toBeNull();
  });

  it('allows the delete once the check-in has been reverted', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Admitted Then Reverted',
      seats: guests(1),
    });
    const attendeeId = await admit(registrationId);
    await sql`update check_ins set reverted_at = now() where attendee_id = ${attendeeId}`;

    const result = await deleteRegistration(registrationId);

    expect(result.attendeesDeleted).toBe(1);
  });
});

describe('deleting twice', () => {
  beforeEach(resetDb);

  it('is harmless and reports nothing the second time', async () => {
    const { segmentId } = await publicSegment();
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Twice',
      seats: guests(2),
    });

    const first = await deleteRegistration(registrationId);
    const second = await deleteRegistration(registrationId);

    expect(first.attendeesDeleted).toBe(2);
    expect(second).toEqual({ seatsFreed: 0, attendeesDeleted: 0, outboxCancelled: 0 });
  });

  it('reports nothing for a registration that does not exist', async () => {
    expect(await deleteRegistration(999_999)).toEqual({
      seatsFreed: 0,
      attendeesDeleted: 0,
      outboxCancelled: 0,
    });
  });
});
