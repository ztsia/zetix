import { beforeEach, describe, expect, it } from 'vitest';
import { newConnection, resetDb, sql } from '../helpers/db';
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
  /** HELD and COMP: granted by this function, outside the extras pool. */
  granted_other: number;
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
    for (let i = 0; i < 20; i++) {
      registrationIds.push(
        await createRegistration({ showId, segmentId, contactName: `Party ${i + 1}` }),
      );
    }

    // **One connection per party**, not a shared pool.
    //
    // This test used to run 25 parties through a pool capped at four, which
    // serialises them four at a time — so with the row lock removed it caught
    // the resulting oversell only about one run in three. A test named for
    // oversell that notices an oversell a third of the time is worse than no
    // test: it makes the property look covered. Twenty real connections all
    // issuing at once is the contention the lock exists for.
    const connections = Array.from({ length: registrationIds.length }, () => newConnection());
    try {
      const outcomes = await Promise.all(
        connections.map((conn, i) =>
          conn<{ claim_seats: Outcome }[]>`
            select claim_seats(${segmentId}::bigint, ${registrationIds[i]}::bigint,
                               ${JSON.stringify([
                                 { full_name: 'Guest', allocation_type: 'EXTRA' },
                               ])}::text::jsonb, false)
          `.then((rows) => rows[0].claim_seats),
        ),
      );

      const granted = outcomes.reduce((sum, o) => sum + o.granted_extra, 0);
      const waitlisted = outcomes.reduce((sum, o) => sum + o.waitlisted, 0);

      expect(granted).toBe(10);
      expect(waitlisted).toBe(10);
      expect(await countAttendees(segmentId, 'CONFIRMED')).toBe(10);
    } finally {
      await Promise.all(connections.map((conn) => conn.end().catch(() => {})));
    }
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

describe('claim_seats() — a full segment is full for every allocation type', () => {
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    // The hall is far larger than the segment, so only the segment's own
    // capacity can stop a grant. That is the case §7.4's `open_seats > 0`
    // exists for, and the one a hall-only check misses entirely.
    showId = await createShow(concertId, 500);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 4,
      baseQuota: 2,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });
    playerIds = await createPlayers(concertId, 2);

    // Fill the segment exactly, through the engine. This uses the admin
    // override deliberately: before the deadline the two players are owed all
    // four seats, so the extras pool is legitimately zero and an ordinary EXTRA
    // request would — correctly — grant nothing. An admin seating people is how
    // a player segment actually reaches full while base is still reserved.
    const filler = await createRegistration({ showId, segmentId });
    expect((await claim(segmentId, filler, seats(4, 'EXTRA'), true)).granted_extra).toBe(4);
  });

  it('waitlists a BASE seat rather than pushing the segment over', async () => {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });

    const outcome = await claim(segmentId, registrationId, seats(2, 'BASE'));
    expect(outcome.granted_base).toBe(0);
    expect(outcome.waitlisted).toBe(2);
    expect(await countAttendees(segmentId, 'CONFIRMED')).toBe(4);
  });

  it('waitlists HELD and COMP seats too', async () => {
    const registrationId = await createRegistration({ showId, segmentId });

    const outcome = await claim(segmentId, registrationId, [
      { full_name: 'Guest of honour', allocation_type: 'HELD' },
      { full_name: 'Press', allocation_type: 'COMP' },
    ]);
    expect(outcome.waitlisted).toBe(2);
    expect(await countAttendees(segmentId, 'CONFIRMED')).toBe(4);
  });

  it('waitlists a BASE seat after the deadline too, when the segment is full', async () => {
    await sql`
      update show_segments set base_claim_deadline = now() - interval '1 hour'
       where id = ${segmentId}::bigint
    `;
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });

    expect((await claim(segmentId, registrationId, seats(1, 'BASE'))).granted_base).toBe(0);
  });
});

describe('claim_seats() — HELD and COMP are reported, not silently written', () => {
  it('counts them separately from extras, which do come out of the pool', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 20,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });

    const outcome = await claim(segmentId, registrationId, [
      { full_name: 'Guest of honour', allocation_type: 'HELD' },
      { full_name: 'Press', allocation_type: 'COMP' },
      { full_name: 'Ordinary', allocation_type: 'EXTRA' },
    ]);

    // Reporting a granted HELD seat as nothing at all tells the caller the
    // request vanished while the row exists.
    expect(outcome).toMatchObject({ granted_other: 2, granted_extra: 1, waitlisted: 0 });
    expect(await countAttendees(segmentId, 'CONFIRMED')).toBe(3);
  });
});

describe('claim_seats() — the override now relaxes entitlement too (decision 47)', () => {
  it('grants a player BASE seats past their quota only with the override', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 500);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 2,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      extrasPolicy: 'REVIEW',
    });
    const [playerId] = await createPlayers(concertId, 1);
    const registrationId = await createRegistration({ showId, segmentId, playerId });

    // This test used to assert the opposite: decision 17 said base entitlement
    // had no opt-out, so the override granted 2 and waitlisted 3. V3 reverses
    // it (decision 47, spec/v3.md §23.5) — an admin may grant past a player's
    // quota, and the excess is marked OVER_CAPACITY. Without the override the
    // quota still holds; `override.test.ts` covers both sides and the marking.
    const outcome = await claim(segmentId, registrationId, seats(5, 'BASE'), true);
    expect(outcome.granted_base).toBe(5);
    expect(outcome.waitlisted).toBe(0);
  });
});

describe('claim_seats() — hostile input', () => {
  it('names the bad argument instead of failing inside jsonb_array_elements', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 20,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });

    await expect(
      sql`select claim_seats(${segmentId}::bigint, ${registrationId}::bigint,
                             ${'{"allocation_type":"EXTRA"}'}::jsonb, false)`,
    ).rejects.toThrow(/expects an array of seat requests, got object/);

    // A null element would otherwise mint a CONFIRMED seat nobody asked for.
    await expect(
      sql`select claim_seats(${segmentId}::bigint, ${registrationId}::bigint,
                             ${'[null]'}::jsonb, false)`,
    ).rejects.toThrow(/every seat request must be an object/);

    expect(await countAttendees(segmentId, 'CONFIRMED')).toBe(0);
  });
});

describe('claim_seats() — what the base deadline does and does not do', () => {
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  /**
   * The spec settles this less directly than it looks, so it is worth stating.
   *
   * §7.2 says the deadline stops `unclaimed_base` being subtracted from the
   * pool — it releases the **reservation**. §7.4 grants a BASE seat whenever
   * `base_claimed(p) < base_quota(p)` and `open_seats > 0`, with no mention of
   * the deadline. §7.9's "no private second chance" is specifically about where
   * a *cancelled* base seat goes.
   *
   * Taken together: after the deadline a player may still claim their base
   * allocation if seats remain, but those seats are no longer held for them —
   * they compete with the extras queue for whatever is left. That is what these
   * two tests pin down, because the earlier test named for it passed for an
   * unrelated reason and would have gone on passing if the behaviour changed.
   */
  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    showId = await createShow(concertId, 100);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 20,
      baseQuota: 2,
      baseClaimDeadline: new Date(Date.now() - 3600 * 1000),
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });
    playerIds = await createPlayers(concertId, 5);
  });

  it('still grants an unclaimed base seat while the segment has room', async () => {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });
    expect((await claim(segmentId, registrationId, seats(2, 'BASE'))).granted_base).toBe(2);
  });

  it('no longer holds seats back for players who have not claimed', async () => {
    // Before the deadline the pool would be 20 − (5 × 2) = 10. After it, the
    // whole segment is available to the extras queue, and a stranger can take
    // seats that were reserved an hour ago.
    const registrationId = await createRegistration({ showId, segmentId });
    expect((await claim(segmentId, registrationId, seats(20, 'EXTRA'))).granted_extra).toBe(20);

    // And now a player claiming base finds nothing left — no private reserve.
    const late = await createRegistration({ showId, segmentId, playerId: playerIds[0] });
    expect((await claim(segmentId, late, seats(1, 'BASE'))).waitlisted).toBe(1);
  });
});

describe('claim_seats() — a party of mixed allocation types', () => {
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    showId = await createShow(concertId, 10);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 10,
      baseQuota: 2,
      // Past: post-deadline is where the two budgets both draw on the same
      // seats, because `extras_pool` becomes `open_seats`.
      baseClaimDeadline: new Date(Date.now() - 3600 * 1000),
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });
    playerIds = await createPlayers(concertId, 3);
  });

  it('cannot spend the same seat twice across BASE and EXTRA', async () => {
    // Fill to 9 of 10, leaving exactly one seat.
    const filler = await createRegistration({ showId, segmentId });
    expect((await claim(segmentId, filler, seats(9, 'EXTRA'))).granted_extra).toBe(9);

    // The ordinary shape of a player's registration: their own base seat plus a
    // guest. Two requests, one seat.
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });
    const outcome = await claim(segmentId, registrationId, [
      { full_name: 'Player guest', allocation_type: 'BASE' },
      { full_name: 'Extra guest', allocation_type: 'EXTRA' },
    ]);

    expect(outcome.granted_base + outcome.granted_extra).toBe(1);
    expect(outcome.waitlisted).toBe(1);
    expect(await countAttendees(segmentId, 'CONFIRMED')).toBe(10);
  });

  it('scales: a large mixed party cannot exceed the seats that exist', async () => {
    const filler = await createRegistration({ showId, segmentId });
    expect((await claim(segmentId, filler, seats(7, 'EXTRA'))).granted_extra).toBe(7);

    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });
    const outcome = await claim(segmentId, registrationId, [
      ...seats(3, 'BASE'),
      ...seats(3, 'EXTRA'),
    ]);

    // Three seats remain; six were asked for.
    expect(outcome.granted_base + outcome.granted_extra).toBe(3);
    expect(outcome.waitlisted).toBe(3);
    expect(await countAttendees(segmentId, 'CONFIRMED')).toBe(10);
  });

  it('cannot spend the same seat twice across HELD and EXTRA either', async () => {
    await resetDb();
    const concertId = await createConcert();
    const publicShow = await createShow(concertId, 5);
    const publicSegment = await createSegment(publicShow, {
      audienceMode: 'PUBLIC',
      capacity: 5,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });

    const filler = await createRegistration({ showId: publicShow, segmentId: publicSegment });
    expect((await claim(publicSegment, filler, seats(4, 'EXTRA'))).granted_extra).toBe(4);

    const registrationId = await createRegistration({
      showId: publicShow,
      segmentId: publicSegment,
    });
    const outcome = await claim(publicSegment, registrationId, [
      { full_name: 'Guest of honour', allocation_type: 'HELD' },
      { full_name: 'Ordinary', allocation_type: 'EXTRA' },
    ]);

    expect(outcome.granted_other + outcome.granted_extra).toBe(1);
    expect(outcome.waitlisted).toBe(1);
    expect(await countAttendees(publicSegment, 'CONFIRMED')).toBe(5);
  });
});

describe('claim_seats() — who is actually owed a base seat', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;

  /**
   * `segment_pool()` and `assert_base_entitlement_fits()` both count only
   * active, undeleted players of this concert. The grant path must use exactly
   * the same predicates, or it spends seats the pool reserved for somebody
   * else — and §7.4 promises "a player is never refused their base allocation
   * before the deadline".
   */
  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 2);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 2,
      baseQuota: 1,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      extrasPolicy: 'REVIEW',
    });
  });

  it('refuses a deactivated player, so the seats stay with the active ones', async () => {
    const [activeOne, activeTwo] = await createPlayers(concertId, 2);
    const [dormant] = await sql<{ id: number }[]>`
      insert into players (concert_id, full_name, email, invite_token, is_active)
      values (${concertId}::bigint, 'Left the orchestra', 'gone@example.test', 'tok-gone', false)
      returning id
    `;

    const ghost = await createRegistration({
      showId,
      segmentId,
      playerId: Number(dormant.id),
    });
    expect((await claim(segmentId, ghost, seats(1, 'BASE'))).granted_base).toBe(0);

    // Both seats were reserved for the two active players, and both get one.
    const first = await createRegistration({ showId, segmentId, playerId: activeOne });
    const second = await createRegistration({ showId, segmentId, playerId: activeTwo });
    expect((await claim(segmentId, first, seats(1, 'BASE'))).granted_base).toBe(1);
    expect((await claim(segmentId, second, seats(1, 'BASE'))).granted_base).toBe(1);
  });

  it('refuses a soft-deleted player', async () => {
    const [playerId] = await createPlayers(concertId, 1);
    await sql`update players set deleted_at = now() where id = ${playerId}::bigint`;

    const registrationId = await createRegistration({ showId, segmentId, playerId });
    expect((await claim(segmentId, registrationId, seats(1, 'BASE'))).granted_base).toBe(0);
  });

  it('refuses a player belonging to another concert', async () => {
    // `players` is concert-scoped but `registrations.player_id` references it
    // directly, so no foreign key can catch this. Without the check, an
    // outsider draws on this segment's quota while `unclaimed_base` never
    // counted them, and grant and pool disagree about who is entitled.
    await createPlayers(concertId, 2);
    const otherConcert = await createConcert('Other Concert');
    const [outsider] = await createPlayers(otherConcert, 1);

    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: outsider,
    });
    expect((await claim(segmentId, registrationId, seats(1, 'BASE'))).granted_base).toBe(0);
  });
});

describe('claim_seats() — HELD and COMP respect the base reservation', () => {
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    showId = await createShow(concertId, 2);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 2,
      baseQuota: 1,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });
    playerIds = await createPlayers(concertId, 2);
  });

  it('will not quietly spend seats the guard reserved for active players', async () => {
    // Both seats are owed to the two players, so the extras pool is zero.
    const admin = await createRegistration({ showId, segmentId });
    const outcome = await claim(segmentId, admin, [
      { full_name: 'Guest of honour', allocation_type: 'COMP' },
      { full_name: 'Press', allocation_type: 'COMP' },
    ]);
    expect(outcome.granted_other).toBe(0);
    expect(outcome.waitlisted).toBe(2);

    // And the player is not refused the seat §7.4 promises them.
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });
    expect((await claim(segmentId, registrationId, seats(1, 'BASE'))).granted_base).toBe(1);
  });

  it('lets an admin take a reserved seat deliberately, with the override', async () => {
    const admin = await createRegistration({ showId, segmentId });
    expect(
      (
        await claim(
          segmentId,
          admin,
          [{ full_name: 'Guest of honour', allocation_type: 'COMP' }],
          true,
        )
      ).granted_other,
    ).toBe(1);
  });
});

describe('claim_seats() — a deleted segment or show holds no event', () => {
  it('refuses a claim into a soft-deleted segment', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 20,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });
    await sql`update show_segments set deleted_at = now() where id = ${segmentId}::bigint`;

    // The hall arithmetic ignores deleted segments, so granting into one seats
    // people the hall total says are not there.
    await expect(claim(segmentId, registrationId, seats(1, 'EXTRA'))).rejects.toThrow(
      /segment .* does not exist/,
    );
  });

  it('refuses a claim into a segment of a soft-deleted show', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 20,
      extrasPolicy: 'AUTO_FCFS',
    });
    const registrationId = await createRegistration({ showId, segmentId });
    await sql`update shows set deleted_at = now() where id = ${showId}::bigint`;

    await expect(claim(segmentId, registrationId, seats(1, 'EXTRA'))).rejects.toThrow(
      /has been deleted, so its segments cannot be given seats/,
    );
  });
});

describe('claim_seats() — an attendee with no name still gets a ticket', () => {
  let showId: number;
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    showId = await createShow(concertId, 50);
    segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 20,
      extrasPolicy: 'AUTO_FCFS',
    });
  });

  it('generates "Guest of {contact_name}", not a null', async () => {
    // decision 32 and spec/v2.md §8.2.1. The door searches this string and the
    // renderer prints it: "Guest of Alice Tan" finding all four of a party is
    // the useful behaviour, and a null finds nobody and prints a blank ticket.
    const registrationId = await createRegistration({
      showId,
      segmentId,
      contactName: 'Alice Tan',
    });

    await claim(segmentId, registrationId, [
      { allocation_type: 'EXTRA' },
      { full_name: null, allocation_type: 'EXTRA' },
      { full_name: '   ', allocation_type: 'EXTRA' },
      { full_name: 'Bob Lim', allocation_type: 'EXTRA' },
    ]);

    const rows = await sql<{ full_name: string; name_source: string }[]>`
      select full_name, name_source from attendees
       where segment_id = ${segmentId}::bigint order by id
    `;
    expect(rows.map((r) => [r.full_name, r.name_source])).toEqual([
      ['Guest of Alice Tan', 'PLACEHOLDER'],
      ['Guest of Alice Tan', 'PLACEHOLDER'],
      ['Guest of Alice Tan', 'PLACEHOLDER'],
      ['Bob Lim', 'PROVIDED'],
    ]);
  });

  it('never writes a null name at all', async () => {
    const registrationId = await createRegistration({ showId, segmentId });
    await claim(segmentId, registrationId, [{ allocation_type: 'EXTRA' }]);

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees where full_name is null
    `;
    expect(row.n).toBe(0);
  });
});

describe('claim_seats() — the whole-party rule holds for a mixed party too', () => {
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  /**
   * §7.5: the boundary request "is granted in part when `allow_partial_grant`
   * is on, **otherwise skipped whole**".
   *
   * That held for a party made entirely of extras, and not for a mixed one: the
   * extras budget was sized before the BASE seat was decided, so the BASE seat
   * then spent room the budget had already counted and the extras were granted
   * until the room ran out — cutting the party in half with partial grants off.
   * One base seat plus guests is the ordinary shape of a player's registration
   * after the deadline, so this was the common case, not an edge.
   */
  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    showId = await createShow(concertId, 3);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 3,
      baseQuota: 1,
      baseClaimDeadline: new Date(Date.now() - 3600 * 1000),
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: false,
    });
    playerIds = await createPlayers(concertId, 1);
  });

  it('waitlists the extras whole when the base seat leaves too little room', async () => {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });

    const outcome = await claim(segmentId, registrationId, [
      { full_name: 'Pat', allocation_type: 'BASE' },
      ...seats(3, 'EXTRA'),
    ]);

    // The player's own seat is theirs; the three guests do not fit in the two
    // that remain, so they wait together rather than two of them going in.
    expect(outcome.granted_base).toBe(1);
    expect(outcome.granted_extra).toBe(0);
    expect(outcome.waitlisted).toBe(3);
  });

  it('grants the extras in part when the segment allows partial grants', async () => {
    await sql`
      update show_segments set allow_partial_grant = true where id = ${segmentId}::bigint
    `;
    const registrationId = await createRegistration({
      showId,
      segmentId,
      playerId: playerIds[0],
    });

    const outcome = await claim(segmentId, registrationId, [
      { full_name: 'Pat', allocation_type: 'BASE' },
      ...seats(3, 'EXTRA'),
    ]);
    expect(outcome.granted_base).toBe(1);
    expect(outcome.granted_extra).toBe(2);
    expect(outcome.waitlisted).toBe(1);
  });

  it('holds a REVIEW segment for review even under the override', async () => {
    // The override relaxes capacity ceilings, not the review itself: confirming
    // an extras request at intake would empty the §7.5 screen it exists for.
    await sql`
      update show_segments set extras_policy = 'REVIEW' where id = ${segmentId}::bigint
    `;
    const registrationId = await createRegistration({ showId, segmentId });

    expect(await claim(segmentId, registrationId, seats(2, 'EXTRA'), true)).toMatchObject({
      granted_extra: 0,
      pending: 2,
    });
  });
});
