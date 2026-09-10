/**
 * QA phase-4 backend probes for module `H`.
 *
 * Runs against the seeded `zetix_qa` database (`qa/support/seed-h.mjs`) and adds
 * its own concert so it never truncates what the browser pass is walking. No
 * mocks: the subject is SQL, authorization and concurrency.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getScanLog, getCheckinStats, getOperatorCounts } from '@/lib/checkin/dashboard';
import { revertCheckIn, RevertError } from '@/lib/checkin/revert';
import {
  createOperator,
  OperatorProvisionError,
  setShowAssignments,
} from '@/lib/operators/provision';
import type { OperatorAuthAdmin } from '@/lib/operators/auth-admin';

const QA_URL = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(QA_URL, { prepare: false, max: 4 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SHOW1 = 1;

afterAll(async () => {
  // Leave the browser pass's fixtures exactly as they were.
  await sql`delete from operator_show_assignments where user_id in (
    select id from app_users where email like 'qa-backend-%')`;
  await sql`delete from app_users where email like 'qa-backend-%'`;
  await sql.end();
});

function fakeAuth(): OperatorAuthAdmin {
  return {
    async createUser() {
      return { id: randomUUID() };
    },
    async updatePassword() {},
    async deleteUser() {},
  };
}

const base = {
  showId: SHOW1,
  pageIndex: 0,
  pageSize: 25,
  sort: null,
  desc: true,
  includeReverted: true,
};

describe('scan log search — hostile input', () => {
  it('treats a bare % as a literal, not a wildcard that returns the whole log', async () => {
    const all = await getScanLog({ ...base, search: '' });
    const pct = await getScanLog({ ...base, search: '%' });
    // If `%` is passed straight into ILIKE it matches every row.
    expect({ all: all.total, pct: pct.total }).toEqual({ all: all.total, pct: 0 });
  });

  it('treats _ as a literal', async () => {
    const underscore = await getScanLog({ ...base, search: '_' });
    expect(underscore.total).toBe(0);
  });

  it('survives SQL metacharacters without erroring or widening the result', async () => {
    const r = await getScanLog({ ...base, search: "' or 1=1 --" });
    expect(r.total).toBe(0);
  });

  it('survives a 5000-character search', async () => {
    const r = await getScanLog({ ...base, search: 'a'.repeat(5000) });
    expect(r.total).toBe(0);
  });

  it('survives path traversal text', async () => {
    const r = await getScanLog({ ...base, search: '../../etc/passwd' });
    expect(r.total).toBe(0);
  });

  it('still finds a real name', async () => {
    const r = await getScanLog({ ...base, search: 'alice' });
    expect(r.rows.map((x) => x.attendeeName)).toEqual(['Alice Tan', 'Alice Tan']);
  });
});

describe('scan log paging — out-of-range input at the library boundary', () => {
  it('rejects or tolerates a negative page size without silently returning everything', async () => {
    // Either behaviour satisfies this test's name. What must not happen is a
    // non-positive page size quietly widening the page — a hand-edited `?size=`
    // returning the whole log would be the actual defect.
    //
    // The implementation clamps to one row rather than throwing, which is the
    // better answer for a page whose only caller is a URL an admin can edit: a
    // dashboard used to run a door should not 500 on a mistyped query string.
    const result = await getScanLog({ ...base, pageSize: -1, search: '' }).catch(
      () => 'threw' as const,
    );

    if (result === 'threw') return;
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(result.total);
  });

  it('tolerates a page far past the end', async () => {
    const r = await getScanLog({ ...base, pageIndex: 1_000_000, search: '' });
    expect(r.rows).toEqual([]);
  });
});

describe('revert — sad paths', () => {
  it('refuses an id that does not exist', async () => {
    await expect(
      revertCheckIn({ checkInId: 987654321, showId: SHOW1, actorId: ADMIN_ID }),
    ).rejects.toBeInstanceOf(RevertError);
  });

  it('refuses a check-in belonging to another show', async () => {
    const [row] = await sql<{ id: number }[]>`
      select id from check_ins where show_id = 2 and reverted_at is null limit 1`;
    await expect(
      revertCheckIn({ checkInId: Number(row!.id), showId: SHOW1, actorId: ADMIN_ID }),
    ).rejects.toBeInstanceOf(RevertError);
    const [after] = await sql`select reverted_at from check_ins where id = ${Number(row!.id)}`;
    expect(after!.reverted_at).toBeNull();
  });

  it('two concurrent reverts of the same row: exactly one wins', async () => {
    const [attendee] = await sql<{ id: number }[]>`
      select id from attendees where show_id = ${SHOW1} limit 1`;
    const [row] = await sql<{ id: number }[]>`
      insert into check_ins (attendee_id, show_id, operator_id, device_id, scanned_at, synced_at, source)
      values (${Number(attendee!.id)}, ${SHOW1}, null, 'qa-race', now(), now(), 'MANUAL')
      returning id`;
    const id = Number(row!.id);

    const results = await Promise.allSettled([
      revertCheckIn({ checkInId: id, showId: SHOW1, actorId: ADMIN_ID }),
      revertCheckIn({ checkInId: id, showId: SHOW1, actorId: ADMIN_ID }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled').length;
    expect(won).toBe(1);

    const [state] = await sql`select reverted_at, reverted_by from check_ins where id = ${id}`;
    expect(state!.reverted_at).not.toBeNull();

    const audits = await sql`select count(*)::int as n from audit_log
      where action = 'checkin.reverted' and entity_id = ${String(id)}`;
    expect(Number(audits[0]!.n)).toBe(1);

    await sql`delete from audit_log where action = 'checkin.reverted' and entity_id = ${String(id)}`;
    await sql`delete from check_ins where id = ${id}`;
  });

  it('never deletes: the row count for the show is unchanged by a revert', async () => {
    const before = await sql`select count(*)::int as n from check_ins where show_id = ${SHOW1}`;
    const [row] = await sql<{ id: number }[]>`
      select id from check_ins where show_id = ${SHOW1} and reverted_at is null limit 1`;
    await revertCheckIn({ checkInId: Number(row!.id), showId: SHOW1, actorId: ADMIN_ID });
    const after = await sql`select count(*)::int as n from check_ins where show_id = ${SHOW1}`;
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    // put it back for the browser pass
    await sql`update check_ins set reverted_at = null, reverted_by = null where id = ${Number(row!.id)}`;
    await sql`delete from audit_log where action = 'checkin.reverted' and entity_id = ${String(Number(row!.id))}`;
  });
});

describe('stats agree with the database', () => {
  it('confirmed / checked in / remaining match raw SQL', async () => {
    const stats = await getCheckinStats(SHOW1);
    const [confirmed] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees where show_id = ${SHOW1} and status = 'CONFIRMED'`;
    const [live] = await sql<{ n: number }[]>`
      select count(distinct c.attendee_id)::int as n
        from check_ins c join attendees a on a.id = c.attendee_id
       where c.show_id = ${SHOW1} and c.reverted_at is null and a.status = 'CONFIRMED'`;
    expect(stats.confirmed).toBe(Number(confirmed!.n));
    expect(stats.checkedIn).toBe(Number(live!.n));
    expect(stats.remaining).toBe(Number(confirmed!.n) - Number(live!.n));
  });

  it('per-operator counts sum to the distinct arrivals, duplicates counted once each', async () => {
    const counts = await getOperatorCounts(SHOW1);
    expect(counts.length).toBeGreaterThan(0);
    const [total] = await sql<{ n: number }[]>`
      select count(*)::int as n from (
        select operator_id, attendee_id from check_ins
         where show_id = ${SHOW1} and reverted_at is null
         group by operator_id, attendee_id) t`;
    expect(counts.reduce((a, b) => a + b.count, 0)).toBe(Number(total!.n));
  });
});

describe('assignments — race and hostile input', () => {
  it('two concurrent identical saves leave exactly one row', async () => {
    const op = await createOperator(
      { displayName: 'QA Backend Race', actorId: ADMIN_ID },
      fakeAuth(),
    );
    await sql`update app_users set email = ${'qa-backend-race@operators.invalid'} where id = ${op.userId}`;

    const args = { userId: op.userId, concertId: 1, showIds: [SHOW1], actorId: ADMIN_ID };
    const settled = await Promise.allSettled([
      setShowAssignments(args),
      setShowAssignments(args),
    ]);
    const rows = await sql`
      select show_id from operator_show_assignments where user_id = ${op.userId}`;
    expect(rows).toHaveLength(1);
    // Neither call may fail with a raw constraint violation the admin cannot read.
    for (const r of settled) {
      if (r.status === 'rejected') {
        expect(String(r.reason)).not.toMatch(/duplicate key|23505/);
      }
    }
  });

  it('refuses a show id that does not exist', async () => {
    const op = await createOperator(
      { displayName: 'QA Backend Ghost', actorId: ADMIN_ID },
      fakeAuth(),
    );
    await sql`update app_users set email = ${'qa-backend-ghost@operators.invalid'} where id = ${op.userId}`;
    await expect(
      setShowAssignments({
        userId: op.userId,
        concertId: 1,
        showIds: [999999],
        actorId: ADMIN_ID,
      }),
    ).rejects.toBeInstanceOf(OperatorProvisionError);
    const rows = await sql`
      select show_id from operator_show_assignments where user_id = ${op.userId}`;
    expect(rows).toHaveLength(0);
  });

  it('a duplicated id in the same save is collapsed, not inserted twice', async () => {
    const op = await createOperator(
      { displayName: 'QA Backend Dupe', actorId: ADMIN_ID },
      fakeAuth(),
    );
    await sql`update app_users set email = ${'qa-backend-dupe@operators.invalid'} where id = ${op.userId}`;
    await setShowAssignments({
      userId: op.userId,
      concertId: 1,
      showIds: [SHOW1, SHOW1, SHOW1],
      actorId: ADMIN_ID,
    });
    const rows = await sql`
      select show_id from operator_show_assignments where user_id = ${op.userId}`;
    expect(rows).toHaveLength(1);
  });

  it('refuses an unknown user id rather than writing an orphan assignment', async () => {
    await expect(
      setShowAssignments({
        userId: '99999999-9999-4999-8999-999999999999',
        concertId: 1,
        showIds: [SHOW1],
        actorId: ADMIN_ID,
      }),
    ).rejects.toBeInstanceOf(OperatorProvisionError);
  });
});

describe('operator creation — hostile display names', () => {
  it('refuses a name with nothing to slug', async () => {
    await expect(
      createOperator({ displayName: '../../../etc/passwd'.replace(/[a-z]/gi, ''), actorId: ADMIN_ID }, fakeAuth()),
    ).rejects.toBeInstanceOf(OperatorProvisionError);
  });

  it('does not let SQL metacharacters reach the address', async () => {
    const op = await createOperator(
      { displayName: "Rob'); drop table app_users;--", actorId: ADMIN_ID },
      fakeAuth(),
    );
    expect(op.email).toMatch(/^[a-z0-9-]+@operators\.invalid$/);
    const [still] = await sql`select count(*)::int as n from app_users`;
    expect(Number(still!.n)).toBeGreaterThan(0);
    await sql`update app_users set email = ${'qa-backend-rob@operators.invalid'} where id = ${op.userId}`;
  });

  it('accepts a very long name at the library level without corrupting the address', async () => {
    const op = await createOperator(
      { displayName: 'X'.repeat(400), actorId: ADMIN_ID },
      fakeAuth(),
    );
    expect(op.email.endsWith('@operators.invalid')).toBe(true);
    await sql`update app_users set email = ${'qa-backend-long@operators.invalid'} where id = ${op.userId}`;
  });
});

describe('arrival buckets', () => {
  it('buckets the seeded show as 2 + 2, counting each attendee at their first scan', async () => {
    const { getArrivalBuckets } = await import('@/lib/checkin/dashboard');
    const buckets = await getArrivalBuckets(SHOW1, 5);
    expect(buckets).toEqual([
      { bucketStart: '2026-09-19T11:00:00Z', count: 2 },
      { bucketStart: '2026-09-19T11:05:00Z', count: 2 },
    ]);
  });
});
