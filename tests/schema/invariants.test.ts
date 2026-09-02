import { beforeEach, describe, expect, it } from 'vitest';
import { newConnection, resetDb, sql } from '../helpers/db';
import { createConcert, createRegistration, createSegment, createShow } from '../helpers/fixtures';

/**
 * Database-level invariants that no application path may break, because eight
 * parallel modules will each write their own paths (spec/modules.md §4).
 */

describe('qr_token is immutable for life — decision 28, spec/tickets.md §10.1', () => {
  let attendeeId: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20 });
    const registrationId = await createRegistration({ showId, segmentId });
    const [row] = await sql<{ id: number }[]>`
      insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                             allocation_type, status, qr_token, ticket_code)
      values (${registrationId}::bigint, ${showId}::bigint, ${segmentId}::bigint, 'Holder',
              'PROVIDED', 'EXTRA', 'CONFIRMED', 'originaltoken0000abcd', 'ORC-7K4Q')
      returning id
    `;
    attendeeId = Number(row.id);
  });

  it('refuses to change a token that has been issued', async () => {
    // A guest who kept the printed first copy must still get through the door.
    await expect(
      sql`update attendees set qr_token = 'rewritten' where id = ${attendeeId}::bigint`,
    ).rejects.toThrow(/qr_token is immutable for the life of an attendee/);
  });

  it('refuses to clear it', async () => {
    await expect(
      sql`update attendees set qr_token = null where id = ${attendeeId}::bigint`,
    ).rejects.toThrow(/qr_token is immutable/);
  });

  it('allows a reissue to repin the template and re-render, leaving the token alone', async () => {
    // §10.5: reissuing re-renders the PDF and may repin the version. It never
    // mints a new token.
    await sql`
      update attendees
         set ticket_template_version = 4, needs_reissue = false, ticket_sent_at = null
       where id = ${attendeeId}::bigint
    `;
    const [row] = await sql<{ qr_token: string }[]>`
      select qr_token from attendees where id = ${attendeeId}::bigint
    `;
    expect(row.qr_token).toBe('originaltoken0000abcd');
  });

  it('allows the first issue, when the token is set for the first time', async () => {
    const [fresh] = await sql<{ id: number }[]>`
      select id from attendees where qr_token is null limit 1
    `;
    if (!fresh) {
      const [row] = await sql<{ id: number }[]>`
        insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                               allocation_type, status)
        select registration_id, show_id, segment_id, 'Unissued', 'PROVIDED', 'EXTRA', 'CONFIRMED'
          from attendees where id = ${attendeeId}::bigint
        returning id
      `;
      await sql`update attendees set qr_token = 'firstissue00000abcde' where id = ${row.id}::bigint`;
      const [check] = await sql<{ qr_token: string }[]>`
        select qr_token from attendees where id = ${row.id}::bigint
      `;
      expect(check.qr_token).toBe('firstissue00000abcde');
    }
  });
});

describe('cancelling a registration cancels its seats — spec/allocation.md §7.9', () => {
  it('leaves the door reading CANCELLED rather than CONFIRMED', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20 });
    const registrationId = await createRegistration({ showId, segmentId });
    await sql`
      insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                             allocation_type, status, ticket_sent_at, ticket_sent_source)
      select ${registrationId}::bigint, ${showId}::bigint, ${segmentId}::bigint,
             'Guest ' || i, 'PROVIDED', 'EXTRA', 'CONFIRMED', now(), 'EMAIL'
        from generate_series(1, 3) as i
    `;

    await sql`
      update registrations set status = 'CANCELLED' where id = ${registrationId}::bigint
    `;

    // The scanner manifest is built from attendees.status. If these stayed
    // CONFIRMED the door would scan a cancelled party green instead of showing
    // "cancelled — refer to desk" (spec/checkin.md §12.1).
    const [row] = await sql<{ cancelled: number; sent: number }[]>`
      select count(*) filter (where status = 'CANCELLED')::int as cancelled,
             count(*) filter (where ticket_sent_at is not null)::int as sent
        from attendees where registration_id = ${registrationId}::bigint
    `;
    expect(row.cancelled).toBe(3);
    // Never cleared: a ticket that was delivered was delivered, and the door
    // needs to know the code exists so it can say "cancelled", not "not found".
    expect(row.sent).toBe(3);
  });
});

describe('claim_seats() refuses an isolation level its lock cannot protect', () => {
  it('raises under REPEATABLE READ rather than overselling silently', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });

    const conn = newConnection();
    try {
      await expect(
        conn.begin('isolation level repeatable read', async (tx) => {
          await tx`
            select claim_seats(${segmentId}::bigint, ${registrationId}::bigint,
                               ${'[{"full_name":"A","allocation_type":"EXTRA"}]'}::text::jsonb,
                               false)
          `;
        }),
      ).rejects.toThrow(/must run at READ COMMITTED/);
    } finally {
      await conn.end();
    }
  });
});

describe('claim_seats() names bad allocation types', () => {
  let segmentId: number;
  let registrationId: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 20,
      extrasPolicy: 'AUTO_FCFS',
    });
    registrationId = await createRegistration({ showId, segmentId });
  });

  const claimRaw = (requests: string) => sql`
    select claim_seats(${segmentId}::bigint, ${registrationId}::bigint,
                       ${requests}::text::jsonb, false)
  `;

  it('rejects an unknown type instead of leaking the enum error', async () => {
    await expect(claimRaw('[{"full_name":"A","allocation_type":"FREEBIE"}]')).rejects.toThrow(
      /allocation_type of BASE, EXTRA, HELD or COMP/,
    );
  });

  it('rejects a null type instead of quietly making it an EXTRA', async () => {
    await expect(claimRaw('[{"full_name":"A","allocation_type":null}]')).rejects.toThrow(
      /allocation_type of BASE, EXTRA, HELD or COMP/,
    );
    await expect(claimRaw('[{"full_name":"A"}]')).rejects.toThrow(
      /allocation_type of BASE, EXTRA, HELD or COMP/,
    );

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees where segment_id = ${segmentId}::bigint
    `;
    expect(row.n).toBe(0);
  });
});

describe('an unresolved extras policy is an error, not a permissive guess', () => {
  it('refuses rather than auto-granting what should have been reviewed', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    // No policy on the segment, and system_settings is empty — the seed is a
    // separate step (docs/local.md §4).
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 20,
      baseQuota: 2,
      extrasPolicy: null,
    });
    const registrationId = await createRegistration({ showId, segmentId });

    await expect(
      sql`
        select claim_seats(${segmentId}::bigint, ${registrationId}::bigint,
                           ${'[{"full_name":"A","allocation_type":"EXTRA"}]'}::text::jsonb, false)
      `,
    ).rejects.toThrow(/has no extras policy set, and there is no default for one/);
  });

  it('resolves from the seeded system default once seeded', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 20,
      baseQuota: 2,
      extrasPolicy: null,
    });
    // Decision 4's defaults live in system_settings as data, keyed by audience
    // mode — not as a literal in code.
    await sql`
      insert into system_settings (key, value)
      values ('allocation.extras_policy',
              ${'{"PLAYER_INVITED":"REVIEW","PUBLIC":"AUTO_FCFS"}'}::text::jsonb)
    `;
    const registrationId = await createRegistration({ showId, segmentId });

    const [row] = await sql<{ claim_seats: { pending: number } }[]>`
      select claim_seats(${segmentId}::bigint, ${registrationId}::bigint,
                         ${'[{"full_name":"A","allocation_type":"EXTRA"}]'}::text::jsonb, false)
    `;
    expect(row.claim_seats.pending).toBe(1);
  });
});
