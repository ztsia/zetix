import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  json,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
} from '../helpers/fixtures';

/**
 * `claim_seats()` — spec/allocation.md §7.4, §7.6, §7.8.
 *
 * Every grant in the system routes through this function, including manual and
 * admin-created registrations (§7.6). Oversell must be impossible.
 */

type Request = {
  full_name?: string | null;
  email?: string | null;
  allocation_type: 'BASE' | 'EXTRA' | 'HELD' | 'COMP';
};

type Outcome = {
  granted_base: number;
  granted_extra: number;
  pending: number;
  waitlisted: number;
};

async function claim(
  segmentId: number,
  registrationId: number,
  requests: Request[],
  override = false,
): Promise<Outcome> {
  const [row] = await sql<{ claim_seats: Outcome }[]>`
    select claim_seats(
      ${segmentId}::bigint,
      ${registrationId}::bigint,
      ${json(requests)}::jsonb,
      ${override}::boolean
    )
  `;
  return row.claim_seats;
}

const seats = (n: number, allocationType: Request['allocation_type']): Request[] =>
  Array.from({ length: n }, (_, i) => ({
    full_name: `Guest ${i + 1}`,
    allocation_type: allocationType,
  }));

async function countAttendees(
  segmentId: number,
  status: string,
  allocationType?: string,
): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees
     where segment_id = ${segmentId}::bigint
       and status = ${status}::booking_status
       ${allocationType ? sql`and allocation_type = ${allocationType}::allocation_type` : sql``}
  `;
  return row.n;
}

describe('claim_seats() — base seats, spec/allocation.md §7.4', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 120);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 120,
      baseQuota: 3,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      extrasPolicy: 'REVIEW',
    });
    playerIds = await createPlayers(concertId, 30);
  });

  it('grants a player their base allocation immediately', async () => {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });

    expect(await claim(segmentId, registrationId, seats(3, 'BASE'))).toMatchObject({
      granted_base: 3,
      granted_extra: 0,
      pending: 0,
      waitlisted: 0,
    });
    expect(await countAttendees(segmentId, 'CONFIRMED', 'BASE')).toBe(3);
  });

  it('waitlists base seats beyond the quota rather than inventing entitlement', async () => {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });

    // Quota is 3; this asks for 5.
    const outcome = await claim(segmentId, registrationId, seats(5, 'BASE'));
    expect(outcome.granted_base).toBe(3);
    expect(outcome.waitlisted).toBe(2);
  });

  it('counts base claims per player, not per registration', async () => {
    // A player registering twice — late registrations are expected, not
    // exceptional (§7.6) — still holds one quota of 3 across both.
    const first = await createRegistration({ showId, segmentId, playerId: playerIds[0] });
    const second = await createRegistration({ showId, segmentId, playerId: playerIds[0] });

    expect((await claim(segmentId, first, seats(2, 'BASE'))).granted_base).toBe(2);
    const outcome = await claim(segmentId, second, seats(2, 'BASE'));
    expect(outcome.granted_base).toBe(1);
    expect(outcome.waitlisted).toBe(1);
  });

  it('honours a per-player quota override above the segment quota', async () => {
    await sql`
      insert into player_allocations (player_id, segment_id, base_quota_override)
      values (${playerIds[0]}::bigint, ${segmentId}::bigint, 5)
    `;
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });

    expect((await claim(segmentId, registrationId, seats(5, 'BASE'))).granted_base).toBe(5);
  });
});

describe('claim_seats() — extras, spec/allocation.md §7.4', () => {
  let concertId: number;
  let showId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 400);
  });

  it('REVIEW holds extras as PENDING_REVIEW, consuming no seats', async () => {
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 2,
      extrasPolicy: 'REVIEW',
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    await createPlayers(concertId, 10);
    const registrationId = await createRegistration({ showId, segmentId });

    const outcome = await claim(segmentId, registrationId, seats(4, 'EXTRA'));
    expect(outcome).toMatchObject({ granted_extra: 0, pending: 4 });

    // "Requests are created as PENDING_REVIEW … consuming no seats."
    const [pool] = await sql<{ segment_pool: { confirmed: number } }[]>`
      select segment_pool(${segmentId}::bigint)
    `;
    expect(pool.segment_pool.confirmed).toBe(0);
  });

  it('AUTO_FCFS grants instantly while the pool has room', async () => {
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });

    expect(await claim(segmentId, registrationId, seats(4, 'EXTRA'))).toMatchObject({
      granted_extra: 4,
      waitlisted: 0,
    });
  });

  it('with allow_partial_grant, the boundary request is granted in part', async () => {
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 3,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });
    const registrationId = await createRegistration({ showId, segmentId });

    expect(await claim(segmentId, registrationId, seats(5, 'EXTRA'))).toMatchObject({
      granted_extra: 3,
      waitlisted: 2,
    });
  });

  it('without allow_partial_grant, the boundary request is skipped whole', async () => {
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 3,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: false,
    });
    const registrationId = await createRegistration({ showId, segmentId });

    // Strict order, never best-fit: a party of 5 that does not fit waits as a
    // party of 5 rather than being cut down (§7.5).
    expect(await claim(segmentId, registrationId, seats(5, 'EXTRA'))).toMatchObject({
      granted_extra: 0,
      waitlisted: 5,
    });
  });

  it('before the deadline, extras cannot consume a seat a player is still owed', async () => {
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 30,
      baseQuota: 3,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    // 10 players × 3 = 30 = the whole segment, so the pool is zero until the
    // deadline (§7.3, the degenerate case).
    await createPlayers(concertId, 10);
    const registrationId = await createRegistration({ showId, segmentId });

    expect(await claim(segmentId, registrationId, seats(2, 'EXTRA'))).toMatchObject({
      granted_extra: 0,
      waitlisted: 2,
    });
  });

  it('after the deadline, the released remainder is available to extras', async () => {
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 30,
      baseQuota: 3,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
      baseClaimDeadline: new Date(Date.now() - 3600 * 1000),
    });
    await createPlayers(concertId, 10);
    const registrationId = await createRegistration({ showId, segmentId });

    expect(await claim(segmentId, registrationId, seats(2, 'EXTRA'))).toMatchObject({
      granted_extra: 2,
    });
  });
});

describe('claim_seats() — the hall ceiling, spec/allocation.md §7.8', () => {
  it('caps a second segment at what the hall has left, not at what its own slice shows', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const a = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 6,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });
    const b = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 4,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });

    const regA = await createRegistration({ showId, segmentId: a });
    const regB = await createRegistration({ showId, segmentId: b });

    // Segment A fills its own slice, and then an admin deliberately seats three
    // more with the §7.6 override. The hall now holds 9 of 10 — reached the only
    // way production can reach it, because the segments themselves are not
    // allowed to total more than the hall.
    expect((await claim(a, regA, seats(6, 'EXTRA'))).granted_extra).toBe(6);
    const overrideReg = await createRegistration({ showId, segmentId: a });
    expect((await claim(a, overrideReg, seats(3, 'EXTRA'), true)).granted_extra).toBe(3);

    // Segment B still shows 4 free seats of its own. The hall has 1.
    const outcome = await claim(b, regB, seats(4, 'EXTRA'));
    expect(outcome.granted_extra).toBe(1);
    expect(outcome.waitlisted).toBe(3);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees
       where show_id = ${showId}::bigint and status = 'CONFIRMED'
    `;
    expect(n).toBe(10);
  });

  it('is exceeded only by a deliberate admin override', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 2);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 2,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });

    // §7.6: "Only the hall ceiling is overridable, and only deliberately."
    expect(await claim(segmentId, registrationId, seats(5, 'EXTRA'), true)).toMatchObject({
      granted_extra: 5,
      waitlisted: 0,
    });
  });
});

describe('claim_seats() — concurrency, spec/allocation.md §7.8', () => {
  it('cannot oversell when many parties claim the last seats at once', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });

    const registrationIds: number[] = [];
    for (let i = 0; i < 25; i++) {
      registrationIds.push(
        await createRegistration({ showId, segmentId, contactName: `Party ${i + 1}` }),
      );
    }

    // 25 parties of one seat racing for 10 seats, issued together on separate
    // connections. Without the row lock on the show, several would read the
    // same `confirmed` count and all write.
    const outcomes = await Promise.all(
      registrationIds.map((id) => claim(segmentId, id, seats(1, 'EXTRA'))),
    );

    const granted = outcomes.reduce((sum, o) => sum + o.granted_extra, 0);
    const waitlisted = outcomes.reduce((sum, o) => sum + o.waitlisted, 0);

    expect(granted).toBe(10);
    expect(waitlisted).toBe(15);
    expect(await countAttendees(segmentId, 'CONFIRMED')).toBe(10);
  });
});

describe('claim_seats() — cancellation returns seats, spec/allocation.md §7.9', () => {
  it('before the deadline a cancelled BASE seat returns to that player, with no special case', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 100);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 3,
      extrasPolicy: 'REVIEW',
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    const [playerId] = await createPlayers(concertId, 1);
    const registrationId = await createRegistration({ showId, segmentId, playerId });

    expect((await claim(segmentId, registrationId, seats(3, 'BASE'))).granted_base).toBe(3);

    await sql`
      update attendees set status = 'CANCELLED'
       where segment_id = ${segmentId}::bigint and id = (
         select min(id) from attendees where segment_id = ${segmentId}::bigint
       )
    `;

    // base_claimed drops, so the seat is theirs again — this falls out of the
    // §7.2 formulas rather than being implemented anywhere.
    const again = await createRegistration({ showId, segmentId, playerId });
    expect((await claim(segmentId, again, seats(1, 'BASE'))).granted_base).toBe(1);
  });
});
