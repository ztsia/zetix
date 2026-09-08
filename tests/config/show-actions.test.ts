import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Module `A`'s show and segment mutations (spec/domain.md §5.1,
 * spec/allocation.md §7.4 and §7.7).
 *
 * The database is real and so are its guards. Only `getSessionUser` is stubbed —
 * the point of most of these is that the guards fire and that the sentence they
 * raise reaches the admin intact, which a mocked database cannot show.
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

const {
  createSegmentAction,
  createShowAction,
  deleteSegmentAction,
  moveCapacityAction,
  updateSegmentAction,
  updateShowAction,
} = await import('@/app/(admin)/admin/concerts/[concertId]/shows/actions');

const NO_STATE = { error: null, message: null };

async function asAdmin() {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, role, is_active)
    values (${id}::uuid, ${`admin-${id}@example.test`}, 'ADMIN', true)
  `;
  sessionUser.mockResolvedValue({ id, email: 'admin@example.test', role: 'ADMIN' });
  return id;
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

describe('show and segment actions', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    await asAdmin();
    concertId = await createConcert();
    await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}::bigint`;
  });

  describe('authorization — every action is its own entry point', () => {
    it.each([
      ['createShowAction', () => createShowAction(concertId, NO_STATE, form({ name: 'X' }))],
      ['updateShowAction', () => updateShowAction(concertId, 1, NO_STATE, form({ name: 'X' }))],
      [
        'createSegmentAction',
        () => createSegmentAction(concertId, 1, NO_STATE, form({ name: 'X' })),
      ],
      [
        'updateSegmentAction',
        () => updateSegmentAction(concertId, 1, NO_STATE, form({ name: 'X' })),
      ],
      ['moveCapacityAction', () => moveCapacityAction(concertId, 1, [], null)],
      ['deleteSegmentAction', () => deleteSegmentAction(concertId, 1)],
    ])('%s redirects a signed-out caller to the login form', async (_label, run) => {
      sessionUser.mockResolvedValue(null);
      await expect(run()).rejects.toBeInstanceOf(RedirectSignal);
    });

    it('sends a signed-in operator away rather than to a login form', async () => {
      sessionUser.mockResolvedValue({
        id: randomUUID(),
        email: 'usher@operators.invalid',
        role: 'OPERATOR',
      });
      await expect(
        createShowAction(concertId, NO_STATE, form({ name: 'X', status: 'DRAFT' })),
      ).rejects.toMatchObject({ to: '/scan' });
    });
  });

  describe('times are stored UTC and read as the venue’s clock (§6.1)', () => {
    it('reads a wall-clock time as the concert’s zone, not the server’s', async () => {
      const result = await createShowAction(
        concertId,
        NO_STATE,
        form({
          name: '19 Sep',
          startsAt: '2026-09-19T20:00',
          status: 'DRAFT',
          portalUnlockMode: '',
        }),
      );
      expect(result.error).toBeNull();

      // 20:00 in Asia/Kuala_Lumpur (UTC+8) is 12:00Z. Reading it back as the
      // raw instant is what proves the zone was applied rather than assumed.
      // Read back as the instant. The driver may hand back a string or a Date
      // depending on its type parsers; the assertion is about the moment in
      // time, so it is normalised rather than depending on which.
      const [row] = await sql<{ starts_at: string | Date }[]>`
        select starts_at from shows where concert_id = ${concertId}::bigint
      `;
      expect(new Date(row.starts_at).toISOString()).toBe('2026-09-19T12:00:00.000Z');
    });

    it('refuses a time when the concert has no zone, rather than guessing UTC', async () => {
      await sql`update concerts set timezone = null where id = ${concertId}::bigint`;

      const result = await createShowAction(
        concertId,
        NO_STATE,
        form({ name: 'X', startsAt: '2026-09-19T20:00', status: 'DRAFT' }),
      );

      expect(result.error).toMatch(/no timezone/i);
      const [{ count }] = await sql<{ count: string }[]>`select count(*) from shows`;
      expect(Number(count)).toBe(0);
    });
  });

  describe('a blank field clears the override — null, never zero (§6)', () => {
    it('stores null for a capacity left blank', async () => {
      await createShowAction(
        concertId,
        NO_STATE,
        form({ name: 'X', capacity: '', status: 'DRAFT' }),
      );
      const [row] = await sql<{ capacity: number | null }[]>`
        select capacity from shows where concert_id = ${concertId}::bigint
      `;
      expect(row.capacity).toBeNull();
    });

    it('stores null for a capacity of whitespace, not a hall of zero seats', async () => {
      // `Number(' ')` is 0. Trimming after coercion would silently create a
      // show nobody can be seated in.
      await createShowAction(
        concertId,
        NO_STATE,
        form({ name: 'X', capacity: '   ', status: 'DRAFT' }),
      );
      const [row] = await sql<{ capacity: number | null }[]>`
        select capacity from shows where concert_id = ${concertId}::bigint
      `;
      expect(row.capacity).toBeNull();
    });
  });

  describe('the base-entitlement guard reaches the admin intact (§7.4)', () => {
    it('blocks lowering a segment capacity below what players are promised', async () => {
      const showId = await createShow(concertId, 400);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 200,
        baseQuota: 2,
      });
      await createPlayers(concertId, 82);

      const result = await updateSegmentAction(
        concertId,
        segmentId,
        NO_STATE,
        form({
          name: 'Player invited',
          audienceMode: 'PLAYER_INVITED',
          capacity: '100',
          baseQuota: '2',
          extrasPolicy: '',
          allowPartialGrant: '',
        }),
      );

      // The §7.4 sentence, whole: the numbers and the three ways out. A generic
      // "validation failed" is the failure this asserts against.
      expect(result.error).toBe(
        '82 active players × 2 base = 164 seats, but the segment holds 100. ' +
          'Reduce the quota to 1, raise capacity to 164, or deactivate 32 players.',
      );

      const [row] = await sql<{ capacity: number }[]>`
        select capacity from show_segments where id = ${segmentId}::bigint
      `;
      expect(row.capacity).toBe(200);
    });

    it('blocks raising the quota past capacity, the same guard from the other side', async () => {
      const showId = await createShow(concertId, 400);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 100,
        baseQuota: 1,
      });
      await createPlayers(concertId, 82);

      const result = await updateSegmentAction(
        concertId,
        segmentId,
        NO_STATE,
        form({
          name: 'Player invited',
          audienceMode: 'PLAYER_INVITED',
          capacity: '100',
          baseQuota: '2',
          extrasPolicy: '',
          allowPartialGrant: '',
        }),
      );

      expect(result.error).toMatch(/but the segment holds 100/);
    });
  });

  describe('moving capacity between segments (§7.7)', () => {
    let showId: number;
    let playerSegment: number;
    let publicSegment: number;

    beforeEach(async () => {
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

    it('commits the worked example — player 80, public 320 — as one edit', async () => {
      const result = await moveCapacityAction(
        concertId,
        showId,
        [
          { segmentId: playerSegment, capacity: 80 },
          { segmentId: publicSegment, capacity: 320 },
        ],
        'Player segment closed with seats unclaimed.',
      );

      expect(result.error).toBeNull();
      const rows = await sql<{ id: number; capacity: number }[]>`
        select id, capacity from show_segments where show_id = ${showId}::bigint order by id
      `;
      expect(rows.map((r) => r.capacity)).toEqual([80, 320]);
    });

    it('commits a move whose first step alone would be rejected', async () => {
      // The teeth of the transaction, and the order is the whole point.
      //
      // Raising public to 320 while the player segment still holds 100 totals
      // 420 in a 400-seat hall. Run as its own statement the deferred guard
      // rejects it at COMMIT — asserted directly below. Passing it *first* to
      // `moveCapacityAction` therefore only succeeds if both updates share one
      // transaction, so removing `db.transaction` turns this red.
      //
      // The earlier version of this test asserted the raw UPDATE alone and
      // never called the action, which made it a test of Postgres rather than
      // of this module. An independent QA pass caught that.
      await expect(
        sql`update show_segments set capacity = 320 where id = ${publicSegment}::bigint`,
      ).rejects.toThrow();

      const result = await moveCapacityAction(
        concertId,
        showId,
        [
          { segmentId: publicSegment, capacity: 320 },
          { segmentId: playerSegment, capacity: 80 },
        ],
        null,
      );

      expect(result.error).toBeNull();
      const rows = await sql<{ id: number; capacity: number }[]>`
        select id, capacity from show_segments where show_id = ${showId}::bigint order by id
      `;
      expect(rows.map((r) => r.capacity)).toEqual([80, 320]);
    });

    it('returns rather than deadlocking against its own connection', async () => {
      // `writeAuditLog` resolves the actor with `getSessionUser()` — which
      // issues its own query — unless it is handed one. The pool is `max: 1`,
      // so inside a transaction that nested query waits forever for the
      // connection the transaction is holding, and the whole request hangs.
      //
      // The suite mocks `@/lib/auth/session`, which is exactly what hid this:
      // the mock never touches the database. Asserting the *unmocked* writer
      // is given an actorId is what keeps the fix in place.
      const move = moveCapacityAction(
        concertId,
        showId,
        [{ segmentId: publicSegment, capacity: 290 }],
        null,
      );

      const outcome = await Promise.race([
        move.then(() => 'returned' as const),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5000)),
      ]);

      expect(outcome).toBe('returned');

      const [row] = await sql<{ actor_id: string | null }[]>`
        select actor_id from audit_log where action = 'segment.capacity_moved'
      `;
      // Attribution survives the fix: passing the id explicitly must not turn
      // into passing null (decision 19 already costs us *which* admin).
      expect(row.actor_id).not.toBeNull();
    });

    it('refuses a move that overflows the hall, naming the overflow', async () => {
      const result = await moveCapacityAction(
        concertId,
        showId,
        [
          { segmentId: playerSegment, capacity: 200 },
          { segmentId: publicSegment, capacity: 300 },
        ],
        null,
      );

      expect(result.error).toBeTruthy();
      expect(result.error).not.toMatch(/^Failed query/);
      const rows = await sql<{ capacity: number }[]>`
        select capacity from show_segments where show_id = ${showId}::bigint order by id
      `;
      expect(rows.map((r) => r.capacity)).toEqual([100, 300]);
    });

    it('refuses to drop a segment below the seats already confirmed in it', async () => {
      const registrationId = await createRegistration({
        showId,
        segmentId: publicSegment,
      });
      await seedAttendees({
        registrationId,
        showId,
        segmentId: publicSegment,
        count: 40,
        allocationType: 'EXTRA',
        status: 'CONFIRMED',
      });

      const result = await moveCapacityAction(
        concertId,
        showId,
        [{ segmentId: publicSegment, capacity: 10 }],
        null,
      );

      expect(result.error).toBeTruthy();
      const [row] = await sql<{ capacity: number }[]>`
        select capacity from show_segments where id = ${publicSegment}::bigint
      `;
      expect(row.capacity).toBe(300);
    });

    it('rolls the audit row back with the move it describes', async () => {
      await moveCapacityAction(
        concertId,
        showId,
        [
          { segmentId: playerSegment, capacity: 200 },
          { segmentId: publicSegment, capacity: 300 },
        ],
        null,
      );

      // A log that survives the rollback of its own change records an edit that
      // never happened, which is worse than no log at all.
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*) from audit_log where action = 'segment.capacity_moved'
      `;
      expect(Number(count)).toBe(0);
    });

    it('logs a move that succeeds, with the reason the admin typed', async () => {
      await moveCapacityAction(
        concertId,
        showId,
        [
          { segmentId: playerSegment, capacity: 80 },
          { segmentId: publicSegment, capacity: 320 },
        ],
        'Player segment closed with seats unclaimed.',
      );

      const [row] = await sql<{ reason: string; before: unknown; after: unknown }[]>`
        select reason, before, after from audit_log where action = 'segment.capacity_moved'
      `;
      expect(row.reason).toBe('Player segment closed with seats unclaimed.');
      expect(row.before).toEqual([
        { id: playerSegment, name: 'Player invited', capacity: 100 },
        { id: publicSegment, name: 'Public', capacity: 300 },
      ]);
    });

    it('rejects a segment belonging to another show', async () => {
      const otherShow = await createShow(concertId, 100);
      const otherSegment = await createSegment(otherShow, {
        audienceMode: 'PUBLIC',
        capacity: 50,
      });

      const result = await moveCapacityAction(
        concertId,
        showId,
        [{ segmentId: otherSegment, capacity: 10 }],
        null,
      );

      expect(result.error).toMatch(/does not belong to this show/);
    });

    it('rejects the same segment listed twice, where the last write would win', async () => {
      const result = await moveCapacityAction(
        concertId,
        showId,
        [
          { segmentId: publicSegment, capacity: 10 },
          { segmentId: publicSegment, capacity: 290 },
        ],
        null,
      );

      expect(result.error).toMatch(/twice/);
    });
  });

  describe('a segment\u2019s audience is immutable (decisions 5 and 17)', () => {
    /**
     * These post what the **browser** posts, which is the whole point.
     *
     * Every other test in this file hands `audienceMode` to the action by
     * name. The form does not: it disables the audience select on edit to
     * express that the value cannot change, a disabled control is not
     * submitted, and the action's `?? 'PUBLIC'` default then rewrote the
     * audience on every edit. Supplying the field by hand made that invisible
     * to the entire suite.
     */
    async function editWithoutAudience(
      concertId: number,
      segmentId: number,
      fields: Record<string, string>,
    ) {
      const data = new FormData();
      for (const [k, v] of Object.entries(fields)) data.append(k, v);
      // Deliberately no `audienceMode` — a disabled select posts nothing.
      return updateSegmentAction(concertId, segmentId, NO_STATE, data);
    }

    it('keeps PLAYER_INVITED when the form omits the audience', async () => {
      const showId = await createShow(concertId, 400);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 100,
        baseQuota: 1,
        name: 'Player invited',
      });

      const result = await editWithoutAudience(concertId, segmentId, {
        name: 'Player invited',
        capacity: '120',
        extrasPolicy: '',
        allowPartialGrant: '',
      });

      expect(result.error).toBeNull();
      const [row] = await sql<{ audience_mode: string; capacity: number }[]>`
        select audience_mode, capacity from show_segments where id = ${segmentId}::bigint
      `;
      expect(row.audience_mode).toBe('PLAYER_INVITED');
      expect(row.capacity).toBe(120);
    });

    it('lets an ordinary capacity edit through on a segment that has a quota', async () => {
      // With the audience read from the form this tripped the
      // quota-on-PUBLIC check, making capacity, deadline, policy and party cap
      // unreachable for exactly the segment this concert runs.
      const showId = await createShow(concertId, 400);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 100,
        baseQuota: 1,
      });

      const result = await editWithoutAudience(concertId, segmentId, {
        name: 'Player invited',
        capacity: '150',
        baseQuota: '1',
        extrasPolicy: '',
        allowPartialGrant: '',
      });

      expect(result.error).toBeNull();
    });

    it('ignores an audience posted by hand — the field is not the client\u2019s to set', async () => {
      // Not merely a form problem: a crafted POST must not flip it either.
      const showId = await createShow(concertId, 400);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 100,
        baseQuota: 1,
      });

      await updateSegmentAction(
        concertId,
        segmentId,
        NO_STATE,
        form({
          name: 'Player invited',
          audienceMode: 'PUBLIC',
          capacity: '100',
          extrasPolicy: '',
          allowPartialGrant: '',
        }),
      );

      const [row] = await sql<{ audience_mode: string }[]>`
        select audience_mode from show_segments where id = ${segmentId}::bigint
      `;
      expect(row.audience_mode).toBe('PLAYER_INVITED');
    });

    it('keeps the §7.4 guard live after an edit, which a flip would switch off', async () => {
      // `assert_base_entitlement_fits()` returns early for a non-player
      // segment, so flipping the audience is an opt-out of a guard decision 17
      // says has none.
      const showId = await createShow(concertId, 400);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 50,
        baseQuota: 1,
      });
      await createPlayers(concertId, 40);

      await editWithoutAudience(concertId, segmentId, {
        name: 'Player invited',
        capacity: '50',
        // Carried deliberately. A blank field *clears* the override
        // (spec/domain.md §6), so omitting this would set `base_quota` to null,
        // leave nothing at any level, and the guard would have no entitlement
        // to enforce — passing this test for entirely the wrong reason.
        baseQuota: '1',
        extrasPolicy: '',
        allowPartialGrant: '',
      });

      await expect(
        sql`insert into players (concert_id, full_name, email, invite_token, is_active)
            select ${concertId}, 'Overflow ' || g, 'of' || g || '@example.test',
                   'tok-overflow-' || g, true
              from generate_series(1, 11) g`,
      ).rejects.toThrow(/but the segment holds 50/);
    });
  });

  describe('segments own the audience, and a show holds one of each', () => {
    it('explains the duplicate rather than leaking the index name', async () => {
      const showId = await createShow(concertId, 400);
      await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });

      const result = await createSegmentAction(
        concertId,
        showId,
        NO_STATE,
        form({
          name: 'Public overflow',
          audienceMode: 'PUBLIC',
          capacity: '50',
          extrasPolicy: '',
          allowPartialGrant: '',
        }),
      );

      expect(result.error).toMatch(/already has a public segment/i);
      expect(result.error).not.toMatch(/show_segments_show_audience_key/);
    });

    it('refuses a base quota on a public segment, which promises nobody anything', async () => {
      const showId = await createShow(concertId, 400);

      const result = await createSegmentAction(
        concertId,
        showId,
        NO_STATE,
        form({
          name: 'Public',
          audienceMode: 'PUBLIC',
          capacity: '300',
          baseQuota: '2',
          extrasPolicy: '',
          allowPartialGrant: '',
        }),
      );

      expect(result.error).toMatch(/player-invited/i);
    });
  });

  describe('deleting a segment', () => {
    it('is blocked while it still holds confirmed seats', async () => {
      const showId = await createShow(concertId, 400);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PUBLIC',
        capacity: 300,
      });
      const registrationId = await createRegistration({
        showId,
        segmentId,
      });
      await seedAttendees({
        registrationId,
        showId,
        segmentId,
        count: 3,
        allocationType: 'EXTRA',
        status: 'CONFIRMED',
      });

      const result = await deleteSegmentAction(concertId, segmentId);

      expect(result.error).toMatch(/3 confirmed seats/);
      const [row] = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from show_segments where id = ${segmentId}::bigint
      `;
      expect(row.deleted_at).toBeNull();
    });

    it('soft-deletes an empty one', async () => {
      const showId = await createShow(concertId, 400);
      const segmentId = await createSegment(showId, {
        audienceMode: 'PUBLIC',
        capacity: 300,
      });

      const result = await deleteSegmentAction(concertId, segmentId);

      expect(result.error).toBeNull();
      const [row] = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from show_segments where id = ${segmentId}::bigint
      `;
      expect(row.deleted_at).not.toBeNull();
    });
  });
});
