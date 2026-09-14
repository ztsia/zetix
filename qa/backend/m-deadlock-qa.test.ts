/**
 * Does the submit path's transaction shape deadlock under real contention?
 *
 * `submitRegistration` inserts `form_responses`, then `registrations`, then
 * calls `claim_seats()`. The `registrations` insert takes a `FOR KEY SHARE`
 * lock on the referenced `shows` row (its `show_id` FK); `claim_seats()` then
 * asks for `FOR UPDATE OF shows` on the same row (allocation.md §7.8).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';

let ids: { showId: number; segmentId: number };

beforeEach(async () => {
  await resetDb();
  const concertId = await createConcert();
  const showId = await createShow(concertId, 10);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC', capacity: 10, baseQuota: null,
    extrasPolicy: 'AUTO_FCFS', allowPartialGrant: true,
  });
  ids = { showId, segmentId };
});

const seats = (who: string) =>
  JSON.stringify([{ full_name: who, email: null, allocation_type: 'EXTRA' }]);

describe('the submit transaction under contention', () => {
  /**
   * **The hazard, reproduced directly.** This is the shape `submitRegistration`
   * used to have: insert the registration, *then* claim. Both transactions take
   * `FOR KEY SHARE` on the `shows` row through the FK, then both ask to upgrade
   * to `FOR UPDATE`, and Postgres breaks the tie with `40P01`.
   *
   * It is kept, and kept **expecting** a deadlock, because it is the evidence
   * for why the fix exists. If this ever stops deadlocking, the reason the
   * production path takes a lock first has gone away and somebody should find
   * out why.
   */
  it('A: the old shape — insert then claim — really does deadlock', async () => {
    const url = process.env.DATABASE_URL!;
    const a = postgres(url, { prepare: false, max: 1 });
    const b = postgres(url, { prepare: false, max: 1 });
    const run = (conn: typeof a, who: string) =>
      conn.begin(async (tx) => {
        const [reg] = await tx`
          insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                                     status, requested_at)
          values (${ids.showId}, ${ids.segmentId}, 'FORM', ${who}, ${who + '@example.test'},
                  'WAITLIST', now()) returning id`;
        await tx`select pg_sleep(0.25)`;
        const [out] = await tx`select claim_seats(${ids.segmentId}::bigint, ${reg.id}::bigint,
          ${seats(who)}::text::jsonb) as result`;
        return out.result;
      });
    const settled = await Promise.allSettled([run(a, 'alpha'), run(b, 'beta')]);
    await a.end();
    await b.end();
    for (const r of settled) {
      console.log('A outcome:', r.status,
        r.status === 'rejected' ? `${(r.reason as { code?: string }).code} ${(r.reason as Error).message}` : JSON.stringify(r.value));
    }
    const failures = settled.filter((r) => r.status === 'rejected');
    expect(failures.map((f) => ((f as PromiseRejectedResult).reason as { code?: string }).code)).toEqual(['40P01']);
  });

  it('B: control — registration already exists, transaction only claims', async () => {
    const url = process.env.DATABASE_URL!;
    const mk = async (who: string) => {
      const [reg] = await sql<{ id: number }[]>`
        insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                                   status, requested_at)
        values (${ids.showId}, ${ids.segmentId}, 'FORM', ${who}, ${who + '@example.test'},
                'WAITLIST', now()) returning id`;
      return Number(reg.id);
    };
    const r1 = await mk('gamma');
    const r2 = await mk('delta');
    const a = postgres(url, { prepare: false, max: 1 });
    const b = postgres(url, { prepare: false, max: 1 });
    const run = (conn: typeof a, regId: number, who: string) =>
      conn.begin(async (tx) => {
        const [out] = await tx`select claim_seats(${ids.segmentId}::bigint, ${regId}::bigint,
          ${seats(who)}::text::jsonb) as result`;
        await tx`select pg_sleep(0.25)`;
        return out.result;
      });
    const settled = await Promise.allSettled([run(a, r1, 'gamma'), run(b, r2, 'delta')]);
    await a.end();
    await b.end();
    for (const r of settled) {
      console.log('B outcome:', r.status,
        r.status === 'rejected' ? `${(r.reason as { code?: string }).code} ${(r.reason as Error).message}` : JSON.stringify(r.value));
    }
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
  });
});

/**
 * The fix, exercised the way production runs it.
 *
 * `lockShowForClaim()` takes the exclusive hall lock as the first statement,
 * before the FK can take a shared one. The two transactions then queue instead
 * of colliding — which is what `allocation.md` §7.8 asks for ("serialise per
 * hall") — and both complete.
 */
describe('the submit transaction with the hall lock taken first', () => {
  it('serialises instead of deadlocking, and never oversells', async () => {
    const url = process.env.DATABASE_URL!;
    const a = postgres(url, { prepare: false, max: 1 });
    const b = postgres(url, { prepare: false, max: 1 });

    const run = (conn: typeof a, who: string) =>
      conn.begin(async (tx) => {
        // The one added statement. Everything below is unchanged.
        await tx`select 1 from shows where id = ${ids.showId} for update`;
        const [reg] = await tx`
          insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                                     status, requested_at)
          values (${ids.showId}, ${ids.segmentId}, 'FORM', ${who}, ${who + '@example.com'},
                  'WAITLIST', now())
          returning id`;
        return tx`select claim_seats(${ids.segmentId}::bigint, ${reg.id}::bigint,
                                     ${seats(who)}::text::jsonb, false::boolean)`;
      });

    const results = await Promise.allSettled([run(a, 'Ann'), run(b, 'Ben')]);
    const failures = results.filter((r) => r.status === 'rejected');
    expect(
      failures.map((f) => ((f as PromiseRejectedResult).reason as { code?: string }).code),
    ).toEqual([]);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees
       where segment_id = ${ids.segmentId} and status = 'CONFIRMED'`;
    expect(n).toBe(2);

    await a.end();
    await b.end();
  });
});
