import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow } from '../helpers/fixtures';
import { createRegistration, type NewSeat } from '@/lib/registrations/mutations';
import { commitReview, loadReviewQueue } from '@/lib/registrations/review';

/**
 * The extras review screen and its commit (spec/allocation.md §7.5).
 *
 * The queue is where the strict-FCFS ordering meets the database, and the
 * commit is where an admin's decision meets the ceilings. Both run against a
 * real local Postgres: the pool, the promotion and the audit row are all the
 * database's, and a mock of any of them would prove nothing.
 */

const extras = (n: number): NewSeat[] =>
  Array.from({ length: n }, (_, i) => ({
    fullName: `Guest ${i + 1}`,
    allocationType: 'EXTRA' as const,
  }));

/** A player-invited segment under REVIEW: extras hold, nothing auto-grants. */
async function reviewSegment(opts: {
  hall?: number;
  capacity: number;
  baseQuota?: number | null;
  players?: number;
  allowPartialGrant?: boolean | null;
  concertName?: string;
}) {
  const concertId = await createConcert(opts.concertName ?? 'Test Concert');
  const showId = await createShow(concertId, opts.hall ?? 400);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: opts.capacity,
    baseQuota: opts.baseQuota ?? null,
    extrasPolicy: 'REVIEW',
    allowPartialGrant: opts.allowPartialGrant ?? null,
    name: 'Player invited',
  });
  if (opts.players) await createPlayers(concertId, opts.players);
  return { concertId, showId, segmentId };
}

/** A party of `seats` extras, asking at `minute` past the hour. */
async function request(segmentId: number, minute: number, seats: number, name?: string) {
  const { registrationId } = await createRegistration({
    segmentId,
    contactName: name ?? `Party at ${minute}`,
    contactEmail: `party${minute}@example.test`,
    requestedAt: new Date(Date.UTC(2026, 8, 1, 12, minute)),
    seats: extras(seats),
  });
  return registrationId;
}

async function statuses(registrationId: number): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; n: number }[]>`
    select status, count(*)::int as n from attendees
     where registration_id = ${registrationId} and deleted_at is null
     group by status
  `;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

async function registrationStatus(id: number): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from registrations where id = ${id}
  `;
  return row.status;
}

describe('loadReviewQueue', () => {
  beforeEach(resetDb);

  it('lists pending requests in requested_at order with a running cumulative total', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const late = await request(segmentId, 30, 1, 'Late');
    const early = await request(segmentId, 5, 2, 'Early');
    const middle = await request(segmentId, 15, 3, 'Middle');

    const queue = await loadReviewQueue(segmentId);

    expect(queue.requests.map((r) => r.registrationId)).toEqual([early, middle, late]);
    expect(queue.preselection.rows.map((r) => r.cumulative)).toEqual([2, 5, 6]);
    expect(queue.requests[0]).toMatchObject({
      contactName: 'Early',
      seatsRequested: 2,
      guestNames: ['Guest 1', 'Guest 2'],
    });
  });

  it('preselects by the pool, and stops at the boundary', async () => {
    const { segmentId } = await reviewSegment({ capacity: 5 });
    await request(segmentId, 5, 2, 'Early');
    await request(segmentId, 15, 4, 'Boundary');
    await request(segmentId, 25, 1, 'Behind the boundary');

    const queue = await loadReviewQueue(segmentId);

    expect(queue.pool.extras_pool).toBe(5);
    // Never best-fit: the party of one behind the boundary does not overtake it.
    expect(queue.preselection.rows.map((r) => r.granted)).toEqual([2, 0, 0]);
  });

  it('shows the base seats a player already holds beside their pending extras', async () => {
    const { concertId, segmentId } = await reviewSegment({
      capacity: 10,
      baseQuota: 1,
      players: 1,
    });
    const [row] = await sql<{ id: string }[]>`
      select id from players where concert_id = ${concertId} order by id limit 1
    `;
    const playerId = Number(row.id);
    const { registrationId } = await createRegistration({
      segmentId,
      playerId,
      contactName: 'Player One',
      seats: [{ fullName: 'Player One', allocationType: 'BASE' }, ...extras(2)],
    });

    const queue = await loadReviewQueue(segmentId);

    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]).toMatchObject({
      registrationId,
      seatsRequested: 2,
      seatsConfirmed: 1,
      playerName: 'Player 1',
    });
  });

  it('leaves out cancelled parties and parties with nothing pending', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const pending = await request(segmentId, 5, 1);
    const cancelled = await request(segmentId, 10, 1);
    await sql`update registrations set status = 'CANCELLED' where id = ${cancelled}`;

    const queue = await loadReviewQueue(segmentId);

    expect(queue.requests.map((r) => r.registrationId)).toEqual([pending]);
  });

  /**
   * The pool is the *preselection's* budget, and before the base claim deadline
   * it sits below the free seats by everything players are still owed (§7.2).
   */
  it('sizes the preselection from the extras pool, not the free seats', async () => {
    const { segmentId } = await reviewSegment({
      capacity: 10,
      baseQuota: 1,
      players: 8,
      hall: 10,
    });
    await sql`
      update show_segments set base_claim_deadline = now() + interval '2 days'
       where id = ${segmentId}
    `;
    await request(segmentId, 5, 3);

    const queue = await loadReviewQueue(segmentId);

    // Ten seats, eight owed to players who have not claimed: two in the pool.
    expect(queue.pool.extras_pool).toBe(2);
    expect(queue.preselection.rows[0].granted).toBe(0);
  });
});

describe('commitReview', () => {
  beforeEach(resetDb);

  const actor = { actorId: null };

  it('confirms the granted seats and waitlists the rest, in one pass', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const first = await request(segmentId, 5, 2);
    const second = await request(segmentId, 15, 3);

    const result = await commitReview(
      segmentId,
      [
        { registrationId: first, granted: 2 },
        { registrationId: second, granted: 0 },
      ],
      actor,
    );

    expect(result).toMatchObject({ confirmed: 2, waitlisted: 3, refused: null });
    expect(await statuses(first)).toEqual({ CONFIRMED: 2 });
    expect(await statuses(second)).toEqual({ WAITLIST: 3 });
    expect(await registrationStatus(first)).toBe('CONFIRMED');
    expect(await registrationStatus(second)).toBe('WAITLIST');
  });

  it('grants part of a party when the admin says so', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const party = await request(segmentId, 5, 4);

    const result = await commitReview(segmentId, [{ registrationId: party, granted: 2 }], actor);

    expect(result).toMatchObject({ confirmed: 2, waitlisted: 2 });
    expect(await statuses(party)).toEqual({ CONFIRMED: 2, WAITLIST: 2 });
  });

  /**
   * §7.5: "Ticking beyond the pool is allowed." The pool is the recommendation;
   * the segment's capacity is the ceiling. Before the deadline those differ by
   * everything players have not claimed, and granting into that gap is a real
   * decision an admin is allowed to make.
   */
  it('commits past the extras pool while inside the segment capacity', async () => {
    const { segmentId } = await reviewSegment({
      capacity: 10,
      baseQuota: 1,
      players: 10,
      hall: 10,
    });
    await sql`
      update show_segments set base_claim_deadline = now() + interval '2 days'
       where id = ${segmentId}
    `;
    const party = await request(segmentId, 5, 2);
    expect((await loadReviewQueue(segmentId)).pool.extras_pool).toBe(0);

    const result = await commitReview(segmentId, [{ registrationId: party, granted: 2 }], actor);

    expect(result).toMatchObject({ confirmed: 2, refused: null });
  });

  it('refuses past the segment capacity, and writes nothing at all', async () => {
    const { segmentId } = await reviewSegment({ capacity: 2, hall: 10 });
    const first = await request(segmentId, 5, 2);
    const second = await request(segmentId, 15, 2);

    const result = await commitReview(
      segmentId,
      [
        { registrationId: first, granted: 2 },
        { registrationId: second, granted: 2 },
      ],
      actor,
    );

    expect(result.refused).toMatch(/over/);
    expect(result.confirmed).toBe(0);
    // All or nothing: the party that would have fitted is untouched, and so is
    // the one that would have been waitlisted.
    expect(await statuses(first)).toEqual({ PENDING_REVIEW: 2 });
    expect(await statuses(second)).toEqual({ PENDING_REVIEW: 2 });
  });

  it('commits past capacity when the override is taken', async () => {
    const { segmentId } = await reviewSegment({ capacity: 2, hall: 10 });
    const first = await request(segmentId, 5, 2);
    const second = await request(segmentId, 15, 2);

    const result = await commitReview(
      segmentId,
      [
        { registrationId: first, granted: 2 },
        { registrationId: second, granted: 2 },
      ],
      { override: true, reason: 'Committee approved two extra chairs', actorId: null },
    );

    expect(result).toMatchObject({ confirmed: 4, refused: null });
  });

  it('records the override in the audit log with the reason typed', async () => {
    const { segmentId } = await reviewSegment({ capacity: 1, hall: 10 });
    const party = await request(segmentId, 5, 2);

    await commitReview(segmentId, [{ registrationId: party, granted: 2 }], {
      override: true,
      reason: 'Guests of honour',
      actorId: null,
    });

    const [row] = await sql<{ action: string; reason: string; after: unknown }[]>`
      select action, reason, after from audit_log order by id desc limit 1
    `;
    expect(row.action).toBe('extras_review.committed_over_capacity');
    expect(row.reason).toBe('Guests of honour');
    expect(row.after).toMatchObject({ confirmed: 2, over: 1 });
  });

  it('logs an ordinary commit too', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const party = await request(segmentId, 5, 1);

    await commitReview(segmentId, [{ registrationId: party, granted: 1 }], actor);

    const [row] = await sql<{ action: string }[]>`
      select action from audit_log order by id desc limit 1
    `;
    expect(row.action).toBe('extras_review.committed');
  });

  /**
   * A request that arrived while the admin was deciding is not something they
   * decided about. Waitlisting it would resolve a row nobody ever saw.
   */
  it('leaves a request that was not on the screen still pending', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const reviewed = await request(segmentId, 5, 1);
    const arrivedLate = await request(segmentId, 45, 2);

    await commitReview(segmentId, [{ registrationId: reviewed, granted: 1 }], actor);

    expect(await statuses(arrivedLate)).toEqual({ PENDING_REVIEW: 2 });
    expect(await registrationStatus(arrivedLate)).toBe('PENDING_REVIEW');
  });

  it('clamps a stale screen asking for more seats than the party still has', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const party = await request(segmentId, 5, 2);

    const result = await commitReview(
      segmentId,
      [{ registrationId: party, granted: 99 }],
      actor,
    );

    expect(result.confirmed).toBe(2);
  });

  it('ignores a registration from another segment', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const mine = await request(segmentId, 5, 1);
    const other = await reviewSegment({ capacity: 10, concertName: 'Another Concert' });
    const theirs = await request(other.segmentId, 5, 1);

    await commitReview(
      segmentId,
      [
        { registrationId: mine, granted: 1 },
        { registrationId: theirs, granted: 1 },
      ],
      actor,
    );

    expect(await statuses(theirs)).toEqual({ PENDING_REVIEW: 1 });
  });

  it('does nothing when there is nothing to decide', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    expect(await commitReview(segmentId, [], actor)).toMatchObject({
      confirmed: 0,
      registrations: 0,
    });
  });

  /**
   * §7.5's commit "queues the resulting emails without sending". Module `F`
   * owns the templates, the render and the outbox writer (`modules.md` §3), so
   * this transaction deliberately leaves `email_outbox` alone rather than
   * writing a row with no rendered body that the dispatcher could not send.
   * Pinned as a test so the seam is a decision rather than an omission.
   */
  it('writes no outbox rows — queueing belongs to module F', async () => {
    const { segmentId } = await reviewSegment({ capacity: 10 });
    const party = await request(segmentId, 5, 1);

    await commitReview(segmentId, [{ registrationId: party, granted: 1 }], actor);

    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox`;
    expect(row.n).toBe(0);
  });

  it('surfaces the queue as the admin left it after a refusal', async () => {
    const { segmentId } = await reviewSegment({ capacity: 1, hall: 10 });
    const party = await request(segmentId, 5, 2);

    await commitReview(segmentId, [{ registrationId: party, granted: 2 }], actor);

    // Still reviewable: a refused commit must not consume the queue.
    const queue = await loadReviewQueue(segmentId);
    expect(queue.requests.map((r) => r.registrationId)).toEqual([party]);
  });
});

describe('commitReview', () => {
  beforeEach(resetDb);

  /**
   * Two commits of the same queue, one after the other.
   *
   * This is **not** a concurrency test and does not pretend to be: `src/db/client.ts`
   * is `max: 1`, so two `getDb().transaction()` calls in a `Promise.all` run on
   * one connection and are strictly sequential — a QA probe confirmed both
   * report the same `pg_backend_pid`. What it does prove is that a commit
   * repeated against a queue it already resolved grants nothing a second time,
   * which is the mistake an admin makes when they are unsure the first click
   * registered.
   *
   * The real lock — a commit *in flight* blocking the next one — is proven in
   * `tests/registrations/promote-seats.test.ts`, on two independent connections
   * with a statement timeout, which is the only way contention is observable.
   */
  it('grants nothing the second time the same queue is committed', async () => {
    const { segmentId } = await reviewSegment({ capacity: 2, hall: 10 });
    const first = await request(segmentId, 5, 2);

    const a = await commitReview(segmentId, [{ registrationId: first, granted: 2 }], {
      actorId: null,
    });
    const b = await commitReview(segmentId, [{ registrationId: first, granted: 2 }], {
      actorId: null,
    });

    expect(a.confirmed).toBe(2);
    expect(b.confirmed).toBe(0);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees
       where segment_id = ${segmentId} and status = 'CONFIRMED'
    `;
    expect(row.n).toBe(2);
  });
});
