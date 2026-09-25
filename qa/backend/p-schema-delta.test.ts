import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newConnection, resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  json,
} from '../../tests/helpers/fixtures';

/**
 * QA, module P (V3 schema delta). Criteria in
 * qa-artifacts/claude-P-schema-delta/01-acceptance.md, written from the spec
 * before the implementation was read. Real Postgres, no mocks.
 */

type Row = { stage: string | null; flags: string[]; [k: string]: unknown };

let concertId: number;
let showId: number;
let pub: number;
let ply: number;

const pipeline = async (id: number) =>
  (await sql<Row[]>`select * from party_pipeline where registration_id = ${id}`)[0];

const claim = (seg: number, reg: number, seats: object[], override = false) =>
  sql<{ r: Record<string, number> }[]>`
    select claim_seats(${seg}::bigint, ${reg}::bigint, ${json(seats)}::jsonb, ${override}) as r`;

const outbox = (reg: number, purpose: string, template: string | null, status: string, extra = sql``) =>
  sql<{ id: string }[]>`
    insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
    values (${reg}, ${purpose}::message_purpose, ${template}, 'reg@example.test', 's', 'b',
            ${status}::outbox_status) ${extra}
    returning id`;

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert();
  showId = await createShow(concertId, 100);
  pub = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 10, extrasPolicy: 'AUTO_FCFS' });
  ply = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 10,
    baseQuota: 2,
    baseClaimDeadline: new Date(Date.now() + 7 * 864e5),
    extrasPolicy: 'REVIEW',
  });
});

afterAll(async () => {
  await sql.end();
});

describe('AC-31 two concurrent claims for the last seat, override off', () => {
  it('exactly one wins, 20 rounds, real separate sessions', async () => {
    const outcomes: number[] = [];
    for (let round = 0; round < 20; round++) {
      await resetDb();
      const c = await createConcert();
      const s = await createShow(c, 100);
      const g = await createSegment(s, { audienceMode: 'PUBLIC', capacity: 1, extrasPolicy: 'AUTO_FCFS' });
      const a = await createRegistration({ showId: s, segmentId: g });
      const b = await createRegistration({ showId: s, segmentId: g });
      const c1 = newConnection();
      const c2 = newConnection();
      try {
        // Both sessions open a transaction, then race into claim_seats.
        const run = (conn: ReturnType<typeof newConnection>, reg: number) =>
          conn.begin(async (tx) => {
            await tx`select pg_sleep(0.05)`;
            return tx`select claim_seats(${g}::bigint, ${reg}::bigint,
                      ${json([{ full_name: 'X', allocation_type: 'EXTRA' }])}::text::jsonb, false) as r`;
          });
        await Promise.all([run(c1, a), run(c2, b)]);
      } finally {
        await c1.end();
        await c2.end();
      }
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from attendees where segment_id = ${g} and status = 'CONFIRMED'`;
      outcomes.push(n);
    }
    expect(outcomes.every((n) => n === 1), JSON.stringify(outcomes)).toBe(true);
  });
});

describe('AC-25/26/27/28/29 override', () => {
  it('AC-25 override off, full public segment: WAITLIST, nothing marked', async () => {
    const r = await createRegistration({ showId, segmentId: pub });
    await sql`update show_segments set capacity = 1 where id = ${pub}`;
    const [{ r: out }] = await claim(pub, r, [
      { full_name: 'A', allocation_type: 'EXTRA' },
      { full_name: 'B', allocation_type: 'EXTRA' },
    ]);
    expect(out).toMatchObject({ granted_extra: 0, waitlisted: 2, over_capacity: 0 });
  });

  it('AC-27 override on past the segment: CONFIRMED, seat marked, view flags OVER_CAPACITY', async () => {
    await sql`update show_segments set capacity = 1 where id = ${pub}`;
    const r = await createRegistration({ showId, segmentId: pub });
    await sql`update registrations set approved_at = now() where id = ${r}`;
    const [{ r: out }] = await claim(
      pub,
      r,
      [
        { full_name: 'A', allocation_type: 'EXTRA' },
        { full_name: 'B', allocation_type: 'EXTRA' },
        { full_name: 'C', allocation_type: 'EXTRA' },
      ],
      true,
    );
    expect(out).toMatchObject({ granted_extra: 3, over_capacity: 2 });
    const row = await pipeline(r);
    expect(row.flags).toContain('OVER_CAPACITY');
    expect(row.confirmed_seats).toBe(3);
  });

  it('AC-28 override on, BASE past quota: CONFIRMED and marked; AC-26 off: waitlisted', async () => {
    const [p] = await createPlayers(concertId, 1);
    const r = await createRegistration({ showId, segmentId: ply, playerId: p });
    const base = (n: number) => Array.from({ length: n }, (_, i) => ({ full_name: `G${i}`, allocation_type: 'BASE' }));
    const [{ r: off }] = await claim(ply, r, base(3));
    expect(off).toMatchObject({ granted_base: 2, waitlisted: 1, over_capacity: 0 });
    const [{ r: on }] = await claim(ply, r, base(1), true);
    expect(on).toMatchObject({ granted_base: 1, over_capacity: 1 });
  });
});

describe('AC-36 per-seat requested_at and the party earliest-seat rule (v3.md §21.3)', () => {
  it('a seat given an earlier time than its party: does registrations.requested_at follow?', async () => {
    const r = await createRegistration({ showId, segmentId: pub, requestedAt: new Date('2026-09-10T00:00:00Z') });
    await claim(pub, r, [{ full_name: 'Early', allocation_type: 'EXTRA', requested_at: '2026-09-01T00:00:00Z' }]);
    const [seat] = await sql<{ requested_at: Date }[]>`select requested_at from attendees where registration_id = ${r}`;
    const [party] = await sql<{ requested_at: Date }[]>`select requested_at from registrations where id = ${r}`;
    // Recorded, not asserted as pass/fail here: the report quotes both values.
    const seatAt = new Date(seat.requested_at).toISOString();
    const partyAt = new Date(party.requested_at).toISOString();
    console.log('QA-EARLIEST', 'seat', seatAt, 'party', partyAt);
    expect(seatAt).toBe('2026-09-01T00:00:00.000Z');
    // v3.md §21.3: registrations.requested_at "stays as the party's earliest seat".
    expect(partyAt).toBe(seatAt);
  });

  it('hostile requested_at is refused and writes nothing', async () => {
    const r = await createRegistration({ showId, segmentId: pub });
    await expect(
      claim(pub, r, [
        { full_name: 'ok', allocation_type: 'EXTRA' },
        { full_name: 'bad', allocation_type: 'EXTRA', requested_at: "'; drop table attendees; --" },
      ]),
    ).rejects.toThrow(/invalid input syntax for type timestamp/);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from attendees where registration_id = ${r}`;
    expect(n).toBe(0);
  });

  it('requested_at cannot be nulled after insert', async () => {
    const r = await createRegistration({ showId, segmentId: pub });
    await claim(pub, r, [{ full_name: 'A', allocation_type: 'EXTRA' }]);
    await expect(sql`update attendees set requested_at = null where registration_id = ${r}`).rejects.toThrow(
      /null value in column "requested_at"/,
    );
  });
});

describe('outbox pending rule (AC-10, AC-11)', () => {
  it('a plain insert (no on conflict) of a second pending TICKETS row fails with 23505 on the index', async () => {
    const r = await createRegistration({ showId, segmentId: pub });
    await outbox(r, 'TICKETS', 'public_ticket', 'SENDING');
    await expect(outbox(r, 'TICKETS', 'player_confirmation', 'DRAFT')).rejects.toThrow(
      /outbox_no_duplicate_pending/,
    );
  });

  it('BOUNCED and FAILED rows do not block a new pending row of the same purpose', async () => {
    const r = await createRegistration({ showId, segmentId: pub });
    await outbox(r, 'TICKETS', 'public_ticket', 'BOUNCED');
    await outbox(r, 'TICKETS', 'public_ticket', 'FAILED');
    const ok = await outbox(r, 'TICKETS', 'public_ticket', 'DRAFT');
    expect(ok).toHaveLength(1);
  });
});

describe('party_pipeline edge cases', () => {
  const approvedPublic = async () => {
    const r = await createRegistration({ showId, segmentId: pub });
    await sql`update registrations set approved_at = now() where id = ${r}`;
    await claim(pub, r, [{ full_name: 'A', allocation_type: 'EXTRA' }]);
    return r;
  };

  it('POSSIBLE_DUPLICATE when the other party of the pair is soft-deleted (§25.5: "a pair of live parties")', async () => {
    const a = await approvedPublic();
    const b = await approvedPublic();
    await sql`insert into duplicate_candidates (show_id, registration_a_id, registration_b_id, reasons, status)
              values (${showId}, ${a}, ${b}, ${['EMAIL']}, 'OPEN')`;
    await sql`update registrations set deleted_at = now() where id = ${b}`;
    const row = await pipeline(a);
    console.log('QA-DUP-OTHER-DELETED', JSON.stringify(row.flags));
    expect(row.flags).not.toContain('POSSIBLE_DUPLICATE');
  });

  it('POSSIBLE_DUPLICATE when the candidate row itself is soft-deleted', async () => {
    const a = await approvedPublic();
    const b = await approvedPublic();
    await sql`insert into duplicate_candidates (show_id, registration_a_id, registration_b_id, reasons, status, deleted_at)
              values (${showId}, ${a}, ${b}, ${['EMAIL']}, 'OPEN', now())`;
    const row = await pipeline(a);
    console.log('QA-DUP-CANDIDATE-DELETED', JSON.stringify(row.flags));
    expect(row.flags).not.toContain('POSSIBLE_DUPLICATE');
  });

  it('SEND_FAILED after the party was delivered by hand (§11.2: FAILED clears by resend or mark-as-delivered)', async () => {
    const r = await approvedPublic();
    await outbox(r, 'TICKETS', 'public_ticket', 'FAILED');
    await issueTickets(concertId, showId);
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'MANUAL' where registration_id = ${r}`;
    const row = await pipeline(r);
    console.log('QA-FAILED-THEN-MANUAL', row.stage, JSON.stringify(row.flags));
    expect(row.flags).not.toContain('SEND_FAILED');
  });

  it('stage rule "first step not finished": a party with one guest inside and a new seat un-ticketed', async () => {
    const r = await approvedPublic();
    await issueTickets(concertId, showId);
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL' where registration_id = ${r}`;
    const [seat] = await sql<{ id: string }[]>`select id from attendees where registration_id = ${r}`;
    await sql`insert into check_ins (attendee_id, show_id, scanned_at, source) values (${seat.id}, ${showId}, now(), 'ONLINE')`;
    // A late seat is added to the party (admin, through claim_seats) and has no ticket yet.
    await claim(pub, r, [{ full_name: 'Late guest', allocation_type: 'EXTRA' }]);
    const row = await pipeline(r);
    console.log('QA-ADMITTED-PRECEDENCE', row.stage, 'confirmed', row.confirmed_seats, 'issued', row.issued_seats, 'admitted', row.admitted_seats);
    // v3.md §21.1: "A party's stage is the first step it has not finished" -> NEEDS_TICKETS.
    expect(row.stage).toBe('NEEDS_TICKETS');
  });

  it('BOUNCED raised by a bounced extras_declined, which carries no tickets (§21.2 "ticket-bearing")', async () => {
    const r = await approvedPublic();
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, sent_at, bounced_at)
              values (${r}, 'EXTRAS_DECISION', 'extras_declined', 'reg@example.test', 's', 'b', 'BOUNCED', now(), now())`;
    const row = await pipeline(r);
    console.log('QA-BOUNCED-DECLINED', JSON.stringify(row.flags));
    expect(row.flags).not.toContain('BOUNCED');
  });

  it('BOUNCED: bounced RECEIPT is not ticket-bearing and does not flag', async () => {
    const r = await approvedPublic();
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, sent_at, bounced_at)
              values (${r}, 'RECEIPT', 'public_verify', 'reg@example.test', 's', 'b', 'BOUNCED', now(), now())`;
    expect((await pipeline(r)).flags).not.toContain('BOUNCED');
  });

  it('unapproved party with only WAITLIST seats reads NEEDS_REVIEW (approval is the earlier step)', async () => {
    await sql`update show_segments set capacity = 0 where id = ${pub}`.catch(() => undefined);
    const r = await createRegistration({ showId, segmentId: pub });
    await sql`update show_segments set capacity = 1 where id = ${pub}`;
    const filler = await createRegistration({ showId, segmentId: pub });
    await claim(pub, filler, [{ full_name: 'F', allocation_type: 'EXTRA' }]);
    await claim(pub, r, [{ full_name: 'W', allocation_type: 'EXTRA' }]);
    const row = await pipeline(r);
    expect(row).toMatchObject({ stage: 'NEEDS_REVIEW', waitlisted_seats: 1, confirmed_seats: 0 });
  });

  it('PLAYER party with no verification token is never UNVERIFIED', async () => {
    const [p] = await createPlayers(concertId, 1);
    const r = await createRegistration({ showId, segmentId: ply, playerId: p });
    await sql`update registrations set approved_at = now(), email_verified_at = null where id = ${r}`;
    await claim(ply, r, [{ full_name: 'P', allocation_type: 'BASE' }]);
    expect((await pipeline(r)).stage).toBe('NEEDS_TICKETS');
  });

  it('counters ignore a soft-deleted seat', async () => {
    const r = await createRegistration({ showId, segmentId: pub });
    await sql`update registrations set approved_at = now() where id = ${r}`;
    await claim(pub, r, [
      { full_name: 'A', allocation_type: 'EXTRA' },
      { full_name: 'B', allocation_type: 'EXTRA' },
    ]);
    await sql`update attendees set deleted_at = now() where registration_id = ${r} and full_name = 'B'`;
    expect(await pipeline(r)).toMatchObject({ live_seats: 1, confirmed_seats: 1 });
  });
});

describe('AC-19 sad: new-table constraints', () => {
  it('duplicate_candidates refuses an unknown status and an unordered pair', async () => {
    const a = await createRegistration({ showId, segmentId: pub });
    const b = await createRegistration({ showId, segmentId: pub });
    await expect(
      sql`insert into duplicate_candidates (show_id, registration_a_id, registration_b_id, reasons, status)
          values (${showId}, ${a}, ${b}, ${['X']}, 'MAYBE')`,
    ).rejects.toThrow(/invalid input value for enum duplicate_status/);
    await expect(
      sql`insert into duplicate_candidates (show_id, registration_a_id, registration_b_id, reasons, status)
          values (${showId}, ${b}, ${a}, ${['X']}, 'OPEN')`,
    ).rejects.toThrow(/duplicate_candidates_ordered_pair/);
  });

  it('AC-17 two live registrations with the same (segment, email, requested_at) both insert', async () => {
    const t = new Date('2026-09-01T00:00:00Z');
    await createRegistration({ showId, segmentId: pub, requestedAt: t });
    await createRegistration({ showId, segmentId: pub, requestedAt: t });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from registrations where segment_id = ${pub}`;
    expect(n).toBe(2);
  });
});
