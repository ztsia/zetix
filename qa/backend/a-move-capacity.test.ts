import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';

/**
 * QA probe. `allocation.md` §7.7 — a capacity move is one edit.
 *
 * The branch's own suite only ever moves capacity in an order that happens to
 * be legal statement by statement (lower first, then raise). That order commits
 * with or without a transaction, so it cannot tell the two apart. This walks
 * the other order.
 */

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const { moveCapacityAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/shows/actions'
);

describe('§7.7 capacity move is order-independent', () => {
  let concertId: number;
  let showId: number;
  let playerSegment: number;
  let publicSegment: number;

  beforeEach(async () => {
    await resetDb();
    const id = randomUUID();
    await sql`
      insert into app_users (id, email, role, is_active)
      values (${id}::uuid, ${`admin-${id}@example.test`}, 'ADMIN', true)
    `;
    sessionUser.mockResolvedValue({ id, email: 'admin@example.test', role: 'ADMIN' });

    concertId = await createConcert();
    showId = await createShow(concertId, 400);
    playerSegment = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 1,
      name: 'Player invited',
    });
    publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 300,
      name: 'Public',
    });
  });

  it('commits when the raise is listed before the reduction', async () => {
    // Same end state as the branch's own worked-example test — player 80,
    // public 320 — with the two moves in the opposite order. Statement by
    // statement this passes through 100 + 320 = 420 in a 400-seat hall, which
    // only a shared transaction with a deferred constraint survives.
    const result = await moveCapacityAction(
      concertId,
      showId,
      [
        { segmentId: publicSegment, capacity: 320 },
        { segmentId: playerSegment, capacity: 80 },
      ],
      'Reordered move.',
    );

    expect(result.error).toBeNull();
    const rows = await sql<{ capacity: number }[]>`
      select capacity from show_segments where show_id = ${showId}::bigint order by id
    `;
    expect(rows.map((r) => r.capacity)).toEqual([80, 320]);
  });

  it('leaves nothing half-moved when the move is refused', async () => {
    // Player 100 -> 40 is legal on its own (40 + 300 = 340). Public 300 -> 500
    // is not. The pair must be all or nothing.
    const result = await moveCapacityAction(
      concertId,
      showId,
      [
        { segmentId: playerSegment, capacity: 40 },
        { segmentId: publicSegment, capacity: 500 },
      ],
      null,
    );

    expect(result.error).toBeTruthy();
    const rows = await sql<{ capacity: number }[]>`
      select capacity from show_segments where show_id = ${showId}::bigint order by id
    `;
    expect(rows.map((r) => r.capacity)).toEqual([100, 300]);
  });
});
