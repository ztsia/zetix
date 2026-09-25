import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  json,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * The V3 override — spec/v3.md §23.5, decision 47 (which reverses 17).
 *
 * `claim_seats()` and `promote_seats()` have carried `p_override` since V1, and
 * there it relaxed the segment and hall ceilings and nothing else
 * (allocation.md §7.8). V3 changes two things and only two:
 *
 * 1. With the override, a player may be granted **past their base quota** —
 *    the one thing V1's override refused.
 * 2. Every seat the override put past a limit is **marked**
 *    (`attendees.over_capacity_at`), because `OVER_CAPACITY` (§21.2) is a
 *    derived flag and needs a fact to derive from. A seat the override did not
 *    need — it would have been granted anyway — is not marked.
 *
 * With the override off, nothing moves. `claim-seats.test.ts`, `pool.test.ts`
 * (the §7.3 worked example) and `promote-seats.test.ts` are the proof of that,
 * and they are unchanged except for the one test that pinned decision 17.
 */

type Request = {
  full_name?: string | null;
  allocation_type: 'BASE' | 'EXTRA' | 'HELD' | 'COMP';
  requested_at?: string;
};

type Outcome = {
  granted_base: number;
  granted_extra: number;
  granted_other: number;
  pending: number;
  waitlisted: number;
  over_capacity: number;
};

async function claim(
  segmentId: number,
  registrationId: number,
  requests: Request[],
  override = false,
): Promise<Outcome> {
  const [row] = await sql<{ claim_seats: Outcome }[]>`
    select claim_seats(
      ${segmentId}::bigint, ${registrationId}::bigint,
      ${json(requests)}::jsonb, ${override}::boolean)
  `;
  return row.claim_seats;
}

const seats = (n: number, allocationType: Request['allocation_type']): Request[] =>
  Array.from({ length: n }, (_, i) => ({
    full_name: `Guest ${i + 1}`,
    allocation_type: allocationType,
  }));

async function marked(registrationId: number): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where registration_id = ${registrationId} and over_capacity_at is not null
  `;
  return n;
}

const inAWeek = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);

describe('claim_seats() override — past the base quota (decision 47)', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;
  let playerId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 500);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 2,
      baseClaimDeadline: inAWeek(),
      extrasPolicy: 'REVIEW',
    });
    [playerId] = await createPlayers(concertId, 1);
  });

  it('grants BASE seats past the quota and marks exactly the excess', async () => {
    const registrationId = await createRegistration({ showId, segmentId, playerId });

    const outcome = await claim(segmentId, registrationId, seats(5, 'BASE'), true);

    expect(outcome).toMatchObject({ granted_base: 5, waitlisted: 0, over_capacity: 3 });
    expect(await marked(registrationId)).toBe(3);
  });

  it('without the override, still waitlists past the quota and marks nothing', async () => {
    const registrationId = await createRegistration({ showId, segmentId, playerId });

    const outcome = await claim(segmentId, registrationId, seats(5, 'BASE'));

    expect(outcome).toMatchObject({ granted_base: 2, waitlisted: 3, over_capacity: 0 });
    expect(await marked(registrationId)).toBe(0);
  });

  it('marks nothing when the override was not needed', async () => {
    const registrationId = await createRegistration({ showId, segmentId, playerId });

    const outcome = await claim(segmentId, registrationId, seats(2, 'BASE'), true);

    expect(outcome).toMatchObject({ granted_base: 2, over_capacity: 0 });
    expect(await marked(registrationId)).toBe(0);
  });

  it('owes nothing to a party with no player — BASE still waitlists there', async () => {
    // The override lifts a quota that exists. A registration linked to no
    // player has no quota to lift, and granting it BASE seats would record an
    // entitlement nobody holds. The admin's lever for such a party is COMP.
    const registrationId = await createRegistration({ showId, segmentId });

    const outcome = await claim(segmentId, registrationId, seats(2, 'BASE'), true);

    expect(outcome).toMatchObject({ granted_base: 0, waitlisted: 2 });
  });

  it('still holds EXTRA for review in a REVIEW segment', async () => {
    const registrationId = await createRegistration({ showId, segmentId, playerId });

    const outcome = await claim(segmentId, registrationId, seats(2, 'EXTRA'), true);

    expect(outcome).toMatchObject({ granted_extra: 0, pending: 2, over_capacity: 0 });
  });
});

describe('claim_seats() override — past the segment and the hall', () => {
  beforeEach(resetDb);

  it('marks the seats past the segment capacity, not the ones inside it', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 100);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 3,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });

    const outcome = await claim(segmentId, registrationId, seats(5, 'EXTRA'), true);

    expect(outcome).toMatchObject({ granted_extra: 5, over_capacity: 2 });
    expect(await marked(registrationId)).toBe(2);
  });

  it('marks the seats past the hall even when the segment had room', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 2);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 2,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });

    const outcome = await claim(segmentId, registrationId, seats(3, 'COMP'), true);

    expect(outcome).toMatchObject({ granted_other: 3, over_capacity: 1 });
  });

  it('does not mark a COMP seat that only went past the extras pool', async () => {
    // The pool sizes a recommendation, not capacity (promote_seats' header in
    // 0005). A seat taken from a player's unclaimed reservation with the
    // override is deliberate, but it did not put anyone over the hall.
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 4,
      baseQuota: 2,
      baseClaimDeadline: inAWeek(),
      extrasPolicy: 'REVIEW',
    });
    await createPlayers(concertId, 2);
    const registrationId = await createRegistration({ showId, segmentId });

    const outcome = await claim(segmentId, registrationId, seats(1, 'COMP'), true);

    expect(outcome).toMatchObject({ granted_other: 1, over_capacity: 0 });
  });
});

describe('claim_seats() — each seat carries its own requested_at (v3.md §21.3)', () => {
  beforeEach(resetDb);

  it('defaults a seat to its party’s request time, and takes an explicit one', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const partyTime = '2026-09-01T10:00:00.000Z';
    const laterTime = '2026-09-03T12:30:00.000Z';
    const registrationId = await createRegistration({
      showId,
      segmentId,
      requestedAt: new Date(partyTime),
    });

    await claim(segmentId, registrationId, [
      { full_name: 'Ada', allocation_type: 'EXTRA' },
      { full_name: 'Grace', allocation_type: 'EXTRA', requested_at: laterTime },
    ]);

    const rows = await sql<{ full_name: string; requested_at: Date }[]>`
      select full_name, requested_at from attendees
       where registration_id = ${registrationId} order by id
    `;
    expect(rows.map((r) => [r.full_name, new Date(r.requested_at).toISOString()])).toEqual([
      ['Ada', partyTime],
      ['Grace', laterTime],
    ]);
  });

  it('keeps the party at its earliest seat when an earlier one arrives', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({
      showId,
      segmentId,
      requestedAt: new Date('2026-09-10T00:00:00.000Z'),
    });
    const party = async () => {
      const [row] = await sql<{ requested_at: Date }[]>`
        select requested_at from registrations where id = ${registrationId}
      `;
      return new Date(row.requested_at).toISOString();
    };

    await claim(segmentId, registrationId, [
      { full_name: 'Later', allocation_type: 'EXTRA', requested_at: '2026-09-12T00:00:00.000Z' },
    ]);
    expect(await party()).toBe('2026-09-10T00:00:00.000Z');

    await claim(segmentId, registrationId, [
      { full_name: 'Earlier', allocation_type: 'EXTRA', requested_at: '2026-09-01T00:00:00.000Z' },
    ]);
    expect(await party()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('refuses a request time that is not a timestamp', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });

    await expect(
      claim(segmentId, registrationId, [
        { full_name: 'Ada', allocation_type: 'EXTRA', requested_at: 'yesterday-ish' },
      ]),
    ).rejects.toThrow();
  });
});

describe('promote_seats() override — marks what went past capacity', () => {
  beforeEach(resetDb);

  async function arrange(capacity: number, pending: number) {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 100);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity,
      extrasPolicy: 'REVIEW',
    });
    const registrationId = await createRegistration({
      showId,
      segmentId,
      status: 'PENDING_REVIEW',
    });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: pending,
      allocationType: 'EXTRA',
      status: 'PENDING_REVIEW',
    });
    const rows = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${registrationId} order by id
    `;
    return { segmentId, registrationId, ids: rows.map((r) => Number(r.id)) };
  }

  async function promote(segmentId: number, ids: number[], override: boolean) {
    const [row] = await sql<{ promote_seats: Record<string, unknown> }[]>`
      select promote_seats(${segmentId}::bigint, ${ids}::bigint[], ${override}::boolean)
    `;
    return row.promote_seats;
  }

  it('confirms all, and marks the excess past the room, last in request order', async () => {
    const { segmentId, registrationId, ids } = await arrange(2, 5);

    const result = await promote(segmentId, ids, true);

    expect(result).toMatchObject({ confirmed: 5, refused: false, over_capacity: 3 });
    expect(await marked(registrationId)).toBe(3);
    // The first two by request time fitted; the last three are the overage.
    const flagged = await sql<{ id: string }[]>`
      select id from attendees
       where registration_id = ${registrationId} and over_capacity_at is not null
       order by id
    `;
    expect(flagged.map((r) => Number(r.id))).toEqual(ids.slice(2));
  });

  it('marks nothing when the room was enough', async () => {
    const { segmentId, registrationId, ids } = await arrange(10, 3);

    const result = await promote(segmentId, ids, true);

    expect(result).toMatchObject({ confirmed: 3, over_capacity: 0 });
    expect(await marked(registrationId)).toBe(0);
  });

  it('without the override, still refuses whole and marks nothing', async () => {
    const { segmentId, registrationId, ids } = await arrange(2, 5);

    const result = await promote(segmentId, ids, false);

    expect(result).toMatchObject({ confirmed: 0, refused: true, over_capacity: 0 });
    expect(await marked(registrationId)).toBe(0);
  });
});

describe('the engine stays off the public API', () => {
  beforeEach(resetDb);

  it('has one signature per engine function, none callable by anon or authenticated', async () => {
    // Adding a parameter creates a new overload rather than replacing the old
    // one; a stale overload would keep V1's semantics reachable. And every new
    // function defaults to PUBLIC execute, which is the door 0004 closed.
    const rows = await sql<{ proname: string; args: string; open: boolean }[]>`
      select p.proname,
             pg_get_function_identity_arguments(p.oid) as args,
             exists (
               select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.privilege_type = 'EXECUTE'
                  and (a.grantee = 0
                       or a.grantee::regrole::text in ('anon', 'authenticated'))
             ) as open
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('claim_seats', 'promote_seats')
       order by 1
    `;
    expect(rows).toEqual([
      {
        proname: 'claim_seats',
        args: 'p_segment_id bigint, p_registration_id bigint, p_requests jsonb, p_override boolean',
        open: false,
      },
      {
        proname: 'promote_seats',
        args: 'p_segment_id bigint, p_attendee_ids bigint[], p_override boolean',
        open: false,
      },
    ]);
  });
});
