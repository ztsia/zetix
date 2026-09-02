import { describe, expect, it } from 'vitest';
import { newConnection, resetDb, sql } from '../helpers/db';
import { createConcert, createRegistration, createSegment, createShow } from '../helpers/fixtures';

/**
 * The lock is on the **show**, not the segment — spec/allocation.md §7.8.
 *
 * This is the one property the sequential tests cannot reach. A hall-ceiling
 * test that runs two claims one after another passes identically whether the
 * lock is `for update of s` or `for update of g`, because nothing ever contends.
 * The reason §7.8 gives for locking the hall — "so that concurrent claims across
 * two segments cannot jointly exceed the hall" — is only exercised when two
 * claims are genuinely in flight at once against *different* segments.
 *
 * So: hold one claim open in a transaction on one connection, and prove a claim
 * against a *different segment of the same show* blocks behind it, while a claim
 * against a different show does not. Together those two assertions pin the lock
 * to exactly the right row.
 */

const seat = [{ full_name: 'Guest', allocation_type: 'EXTRA' }];

/** Blocked, rather than merely slow: a statement timeout is how a lock wait is observed. */
const BLOCKED = /canceling statement due to statement timeout/;

/** A promise plus the function that resolves it, for ordering two connections. */
function latch() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

describe('claim_seats() locks the show, not the segment', () => {
  it('blocks a concurrent claim on a different segment of the same show', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 20);
    const a = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const b = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const regA = await createRegistration({ showId, segmentId: a });
    const regB = await createRegistration({ showId, segmentId: b });

    const holder = newConnection();
    const contender = newConnection({ statement_timeout: '700ms' });
    const { gate: releaseGate, open: released } = latch();
    const { gate: lockTaken, open: lockIsHeld } = latch();
    try {

      // Hold a claim on segment A open, mid-transaction, lock still taken.
      const held = holder.begin(async (tx) => {
        await tx`
          select claim_seats(${a}::bigint, ${regA}::bigint, ${JSON.stringify(seat)}::text::jsonb, false)
        `;
        lockIsHeld();
        await releaseGate;
      });

      // Wait until the lock is genuinely held. Without this the contender can
      // win the race, the assertion becomes "did not throw" on a good day and a
      // 30-second hang on a bad one, and the test reports timing rather than
      // locking.
      await lockTaken;

      await expect(
        contender`
          select claim_seats(${b}::bigint, ${regB}::bigint, ${JSON.stringify(seat)}::text::jsonb, false)
        `,
      ).rejects.toThrow(BLOCKED);

      released();
      await held;
    } finally {
      // Release unconditionally. If the assertion above fails, the holder is
      // still inside its transaction awaiting this gate, and `holder.end()`
      // would wait on it forever — turning a clear assertion failure into a
      // 30-second hang for whoever broke the lock.
      released();
      await holder.end().catch(() => {});
      await contender.end().catch(() => {});
    }
  });

  it('does not block a concurrent claim on a different show', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showOne = await createShow(concertId, 20);
    const showTwo = await createShow(concertId, 20);
    const a = await createSegment(showOne, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const b = await createSegment(showTwo, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const regA = await createRegistration({ showId: showOne, segmentId: a });
    const regB = await createRegistration({ showId: showTwo, segmentId: b });

    const holder = newConnection();
    const contender = newConnection({ statement_timeout: '700ms' });
    const { gate: releaseGate, open: released } = latch();
    const { gate: lockTaken, open: lockIsHeld } = latch();
    try {

      const held = holder.begin(async (tx) => {
        await tx`
          select claim_seats(${a}::bigint, ${regA}::bigint, ${JSON.stringify(seat)}::text::jsonb, false)
        `;
        lockIsHeld();
        await releaseGate;
      });
      await lockTaken;

      // Two halls are two independent evenings. Serialising them would be a
      // lock that is too broad, which is a different bug from one too narrow.
      const [row] = await contender<{ claim_seats: { granted_extra: number } }[]>`
        select claim_seats(${b}::bigint, ${regB}::bigint, ${JSON.stringify(seat)}::text::jsonb, false)
      `;
      expect(row.claim_seats.granted_extra).toBe(1);

      released();
      await held;
    } finally {
      // Release unconditionally. If the assertion above fails, the holder is
      // still inside its transaction awaiting this gate, and `holder.end()`
      // would wait on it forever — turning a clear assertion failure into a
      // 30-second hang for whoever broke the lock.
      released();
      await holder.end().catch(() => {});
      await contender.end().catch(() => {});
    }
  });

  it('leaves the hall correct when both segments race for the last seats', async () => {
    await resetDb();
    const concertId = await createConcert();
    // The hall holds 8; the two segments split it exactly. Twelve parties spread
    // across both race for those 8 seats at once.
    const showId = await createShow(concertId, 8);
    const a = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 4,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });
    const b = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 4,
      extrasPolicy: 'AUTO_FCFS',
      allowPartialGrant: true,
    });

    const claims: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      const segmentId = i % 2 === 0 ? a : b;
      const registrationId = await createRegistration({ showId, segmentId });
      claims.push(sql`
        select claim_seats(
          ${segmentId}::bigint, ${registrationId}::bigint, ${JSON.stringify(seat)}::jsonb, false
        )
      `);
    }
    await Promise.all(claims);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees
       where show_id = ${showId}::bigint and status = 'CONFIRMED'
    `;
    expect(n).toBe(8);
  });
});
