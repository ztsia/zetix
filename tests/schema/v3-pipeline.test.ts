import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  json,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * `party_pipeline` — spec/v3.md §21, decision 51.
 *
 * **Status is derived, never stored** (§20.1). Every stage and every flag is
 * computed by the view from facts that already exist, so each test here
 * arranges the facts and reads the view — one test per stage, one per flag, and
 * the counters the screens read instead of recomputing.
 */

type Row = {
  registration_id: string;
  stage: string | null;
  flags: string[];
  live_seats: number;
  confirmed_seats: number;
  pending_seats: number;
  waitlisted_seats: number;
  cancelled_seats: number;
  issued_seats: number;
  delivered_seats: number;
  admitted_seats: number;
};

let concertId: number;
let showId: number;
let publicSegmentId: number;
let playerSegmentId: number;

async function pipeline(registrationId: number): Promise<Row | undefined> {
  const [row] = await sql<Row[]>`
    select * from party_pipeline where registration_id = ${registrationId}
  `;
  return row;
}

async function claim(segmentId: number, registrationId: number, types: string[]) {
  await sql`
    select claim_seats(${segmentId}::bigint, ${registrationId}::bigint,
      ${json(types.map((t, i) => ({ full_name: `Guest ${i + 1}`, allocation_type: t })))}::jsonb,
      false)
  `;
}

/** An approved public party of `n` confirmed seats. */
async function publicParty(n = 2, opts: { approved?: boolean } = {}): Promise<number> {
  const id = await createRegistration({ showId, segmentId: publicSegmentId });
  if (opts.approved ?? true) {
    await sql`update registrations set approved_at = now() where id = ${id}`;
  }
  await claim(publicSegmentId, id, Array(n).fill('EXTRA'));
  return id;
}

async function deliverAll(registrationId: number) {
  await sql`
    update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
     where registration_id = ${registrationId} and status = 'CONFIRMED'
  `;
}

async function outbox(
  registrationId: number,
  fields: {
    purpose: string;
    template: string;
    status: string;
    toEmail?: string;
    sentAt?: string | null;
    bouncedAt?: string | null;
  },
): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into email_outbox (registration_id, purpose, template_key, to_email, subject,
                              body_md, status, sent_at, bounced_at)
    values (${registrationId}, ${fields.purpose}::message_purpose, ${fields.template},
            ${fields.toEmail ?? 'reg@example.test'}, 's', 'b', ${fields.status}::outbox_status,
            ${fields.sentAt ?? null}::timestamptz, ${fields.bouncedAt ?? null}::timestamptz)
    returning id
  `;
  return Number(row.id);
}

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert();
  showId = await createShow(concertId, 100);
  publicSegmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: 40,
    extrasPolicy: 'AUTO_FCFS',
  });
  playerSegmentId = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 40,
    baseQuota: 2,
    baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    extrasPolicy: 'REVIEW',
  });
});

describe('party_pipeline — stages (§21.1)', () => {
  it('NEEDS_REVIEW: a party nobody has approved', async () => {
    const id = await publicParty(2, { approved: false });
    expect((await pipeline(id))?.stage).toBe('NEEDS_REVIEW');
  });

  it('NEEDS_REVIEW: an approved party with extras awaiting a first-come decision', async () => {
    const [playerId] = await createPlayers(concertId, 1);
    const id = await createRegistration({ showId, segmentId: playerSegmentId, playerId });
    await sql`update registrations set approved_at = now() where id = ${id}`;
    await claim(playerSegmentId, id, ['BASE', 'EXTRA']);

    const row = await pipeline(id);
    expect(row?.stage).toBe('NEEDS_REVIEW');
    expect(row).toMatchObject({ confirmed_seats: 1, pending_seats: 1 });
  });

  it('UNVERIFIED: a public party sent a link it has not clicked', async () => {
    const id = await publicParty();
    await sql`update registrations set verification_token = 'tok-unverified' where id = ${id}`;
    expect((await pipeline(id))?.stage).toBe('UNVERIFIED');

    // An admin release sets email_verified_at, exactly as clicking does.
    await sql`update registrations set email_verified_at = now() where id = ${id}`;
    expect((await pipeline(id))?.stage).not.toBe('UNVERIFIED');
  });

  it('NEEDS_TICKETS: a confirmed seat has no issued ticket', async () => {
    const id = await publicParty();
    expect((await pipeline(id))?.stage).toBe('NEEDS_TICKETS');
  });

  it('READY_TO_SEND: every seat issued, at least one undelivered', async () => {
    const id = await publicParty(2);
    await issueTickets(concertId, showId);
    await sql`
      update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
       where id = (select min(id) from attendees where registration_id = ${id})
    `;

    const row = await pipeline(id);
    expect(row?.stage).toBe('READY_TO_SEND');
    expect(row).toMatchObject({ confirmed_seats: 2, issued_seats: 2, delivered_seats: 1 });
  });

  it('SENT: every confirmed seat delivered, by email or by hand', async () => {
    const id = await publicParty(2);
    await issueTickets(concertId, showId);
    await sql`
      update attendees
         set ticket_sent_at = now(),
             ticket_sent_source = case when id % 2 = 0 then 'EMAIL' else 'MANUAL' end::ticket_sent_source
       where registration_id = ${id}
    `;
    expect((await pipeline(id))?.stage).toBe('SENT');
  });

  it('ADMITTED: a seat has a check-in that was not reverted', async () => {
    const id = await publicParty(2);
    await issueTickets(concertId, showId);
    await deliverAll(id);
    const [{ attendee }] = await sql<{ attendee: string }[]>`
      select min(id) as attendee from attendees where registration_id = ${id}
    `;
    const [checkIn] = await sql<{ id: string }[]>`
      insert into check_ins (attendee_id, show_id, scanned_at, source)
      values (${attendee}, ${showId}, now(), 'MANUAL') returning id
    `;
    expect(await pipeline(id)).toMatchObject({ stage: 'ADMITTED', admitted_seats: 1 });

    // Undo check-in: the party goes back to where the rest of its facts put it.
    await sql`update check_ins set reverted_at = now() where id = ${checkIn.id}`;
    expect(await pipeline(id)).toMatchObject({ stage: 'SENT', admitted_seats: 0 });
  });

  it('WAITLISTED: no confirmed seats, at least one on the waitlist', async () => {
    // Fill the public segment, then a party of two cannot fit and waits whole.
    await publicParty(40);
    const id = await publicParty(2);

    expect(await pipeline(id)).toMatchObject({
      stage: 'WAITLISTED',
      confirmed_seats: 0,
      waitlisted_seats: 2,
    });
  });

  it('CANCELLED: every seat cancelled', async () => {
    const id = await publicParty(2);
    await sql`update registrations set status = 'CANCELLED' where id = ${id}`;

    expect(await pipeline(id)).toMatchObject({
      stage: 'CANCELLED',
      live_seats: 0,
      cancelled_seats: 2,
    });
  });

  it('ignores a cancelled seat when placing the rest of the party', async () => {
    const id = await publicParty(2);
    await issueTickets(concertId, showId);
    await deliverAll(id);
    // A seat given back, never delivered, must not hold the party at READY_TO_SEND.
    await claim(publicSegmentId, id, ['EXTRA']);
    await sql`
      update attendees set status = 'CANCELLED'
       where id = (select max(id) from attendees where registration_id = ${id})
    `;
    expect(await pipeline(id)).toMatchObject({ stage: 'SENT', cancelled_seats: 1 });
  });

  it('takes a soft-deleted party off the line entirely', async () => {
    const id = await publicParty(1);
    await sql`update registrations set deleted_at = now() where id = ${id}`;
    expect(await pipeline(id)).toBeUndefined();
  });

  it('gives a party with no seats at all no stage', async () => {
    const id = await createRegistration({ showId, segmentId: publicSegmentId });
    expect((await pipeline(id))?.stage).toBeNull();
  });
});

describe('party_pipeline — flags (§21.2)', () => {
  it('none on a clean party', async () => {
    const id = await publicParty(1);
    expect((await pipeline(id))?.flags).toEqual([]);
  });

  it('BOUNCED: the newest ticket-bearing message to the current address bounced', async () => {
    const id = await publicParty(1);
    await outbox(id, {
      purpose: 'TICKETS',
      template: 'public_ticket',
      status: 'CANCELLED',
      sentAt: new Date(Date.now() - 60_000).toISOString(),
      bouncedAt: new Date().toISOString(),
    });
    expect((await pipeline(id))?.flags).toContain('BOUNCED');

    // Fixing the address clears it: the bounce was to an address the party no
    // longer has.
    await sql`update registrations set contact_email = 'fixed@example.test' where id = ${id}`;
    expect((await pipeline(id))?.flags).not.toContain('BOUNCED');
  });

  it('BOUNCED clears when a later send to the same address did not bounce', async () => {
    const id = await publicParty(1);
    await outbox(id, {
      purpose: 'TICKETS',
      template: 'public_ticket',
      status: 'CANCELLED',
      sentAt: new Date(Date.now() - 120_000).toISOString(),
      bouncedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await outbox(id, {
      purpose: 'TICKETS',
      template: 'public_ticket',
      status: 'SENT',
      sentAt: new Date().toISOString(),
    });
    expect((await pipeline(id))?.flags).not.toContain('BOUNCED');
  });

  it('SEND_FAILED: a message exhausted its attempts, and nothing replaced it', async () => {
    const id = await publicParty(1);
    await outbox(id, { purpose: 'TICKETS', template: 'public_ticket', status: 'FAILED' });
    expect((await pipeline(id))?.flags).toContain('SEND_FAILED');

    await outbox(id, {
      purpose: 'TICKETS',
      template: 'public_ticket',
      status: 'SENT',
      sentAt: new Date().toISOString(),
    });
    expect((await pipeline(id))?.flags).not.toContain('SEND_FAILED');
  });

  it('SUSPICIOUS_ADDRESS: the address check found a problem nobody accepted', async () => {
    const id = await publicParty(1);
    await sql`
      update registrations set email_issue = 'typo: did you mean gmail.com?',
                               email_checked_at = now()
       where id = ${id}
    `;
    expect((await pipeline(id))?.flags).toContain('SUSPICIOUS_ADDRESS');

    await sql`update registrations set email_issue_accepted_at = now() where id = ${id}`;
    expect((await pipeline(id))?.flags).not.toContain('SUSPICIOUS_ADDRESS');
  });

  it('CHANGED_AFTER_SEND: a seat needs reissuing', async () => {
    const id = await publicParty(1);
    await sql`update attendees set needs_reissue = true where registration_id = ${id}`;
    expect((await pipeline(id))?.flags).toContain('CHANGED_AFTER_SEND');
  });

  it('POSSIBLE_DUPLICATE: an open candidate names the party, on either side', async () => {
    const a = await publicParty(1);
    const b = await publicParty(1);
    const [cand] = await sql<{ id: string }[]>`
      insert into duplicate_candidates (show_id, registration_a_id, registration_b_id,
                                        reasons, status)
      values (${showId}, ${a}, ${b}, array['EMAIL'], 'OPEN') returning id
    `;
    expect((await pipeline(a))?.flags).toContain('POSSIBLE_DUPLICATE');
    expect((await pipeline(b))?.flags).toContain('POSSIBLE_DUPLICATE');

    // "Not a duplicate" sticks, and clears the flag.
    await sql`update duplicate_candidates set status = 'DISMISSED' where id = ${cand.id}`;
    expect((await pipeline(a))?.flags).not.toContain('POSSIBLE_DUPLICATE');
  });

  it('UNNAMED_GUESTS: a seat is a placeholder', async () => {
    const id = await createRegistration({ showId, segmentId: publicSegmentId });
    await sql`update registrations set approved_at = now() where id = ${id}`;
    await sql`
      select claim_seats(${publicSegmentId}::bigint, ${id}::bigint,
        ${json([{ full_name: '', allocation_type: 'EXTRA' }])}::jsonb, false)
    `;
    expect((await pipeline(id))?.flags).toContain('UNNAMED_GUESTS');
  });

  it('REPLY_WAITING: the newest message in the thread is an unhandled reply', async () => {
    const id = await publicParty(1);
    const [thread] = await sql<{ id: string }[]>`
      insert into email_threads (registration_id) values (${id}) returning id
    `;
    await sql`
      insert into email_messages (thread_id, direction, message_id, message_at)
      values (${thread.id}, 'OUTBOUND', '<1@x>', now() - interval '2 hours')
    `;
    const [reply] = await sql<{ id: string }[]>`
      insert into email_messages (thread_id, direction, message_id, message_at)
      values (${thread.id}, 'INBOUND', '<2@y>', now() - interval '1 hour') returning id
    `;
    expect((await pipeline(id))?.flags).toContain('REPLY_WAITING');

    await sql`update email_messages set handled_at = now() where id = ${reply.id}`;
    expect((await pipeline(id))?.flags).not.toContain('REPLY_WAITING');
  });

  it('REPLY_WAITING is not raised by a bounce, which has its own flag', async () => {
    const id = await publicParty(1);
    const [thread] = await sql<{ id: string }[]>`
      insert into email_threads (registration_id) values (${id}) returning id
    `;
    await sql`
      insert into email_messages (thread_id, direction, message_id, message_at, is_bounce)
      values (${thread.id}, 'INBOUND', '<dsn@x>', now(), true)
    `;
    expect((await pipeline(id))?.flags).not.toContain('REPLY_WAITING');
  });

  it('OVER_CAPACITY: a seat an admin granted past a limit', async () => {
    const id = await createRegistration({ showId, segmentId: publicSegmentId });
    await sql`update registrations set approved_at = now() where id = ${id}`;
    await sql`
      select claim_seats(${publicSegmentId}::bigint, ${id}::bigint,
        ${json(Array.from({ length: 41 }, () => ({ full_name: 'G', allocation_type: 'COMP' })))}::jsonb,
        true)
    `;
    expect((await pipeline(id))?.flags).toContain('OVER_CAPACITY');
  });

  it('reads flags from live seats only', async () => {
    const id = await publicParty(2);
    await withDirectAttendeeWrites(async (tx) => {
      await tx`
        update attendees set status = 'CANCELLED', needs_reissue = true, name_source = 'PLACEHOLDER'
         where id = (select max(id) from attendees where registration_id = ${id})
      `;
    });
    await sql`
      update attendees set name_source = 'PROVIDED'
       where registration_id = ${id} and status = 'CONFIRMED'
    `;
    expect((await pipeline(id))?.flags).toEqual([]);
  });
});

describe('party_pipeline — exposure', () => {
  it('runs as the caller, never as its owner', async () => {
    const [row] = await sql<{ options: string[] | null }[]>`
      select reloptions as options from pg_class
       where relname = 'party_pipeline' and relnamespace = 'public'::regnamespace
    `;
    expect(row.options).toContain('security_invoker=true');
  });

  it('grants anon, authenticated and PUBLIC nothing', async () => {
    const rows = await sql`
      select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'party_pipeline'
         and grantee in ('anon', 'authenticated', 'PUBLIC')
    `;
    expect(rows).toEqual([]);
  });
});
