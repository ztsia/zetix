/**
 * QA re-run probes for `fix/import-reimport-dedup`.
 *
 * The committed concurrency tests run two `commitImport()` calls through the
 * SAME `getDb()` singleton, whose pool is `max: 1` (src/db/client.ts) — so they
 * serialize on the connection and cannot contend. This file gives each commit
 * its own module registry, and therefore its own pool, so the show lock is
 * actually exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';
import { buildPlanContext, loadSegmentTarget } from '@/lib/import/context';
import { planImport, type SheetRow } from '@/lib/import/plan';
import { parseMappingProfile } from '@/lib/import/profile';

const H = { ts: 'Timestamp', contact: 'Contact Name', email: 'Contact Email', name: 'Attendee Name', type: 'Ticket Type' } as const;
const profile = (over: Record<string, unknown> = {}) =>
  parseMappingProfile({
    columns: { requested_at: H.ts, contact_name: H.contact, contact_email: H.email, attendee_name: H.name, allocation_type: H.type },
    allocation_type_values: { BASE: ['Allocated'], EXTRA: ['Extra'] },
    default_allocation_type: 'EXTRA',
    player_match: null,
    ...over,
  });

let line = 2;
const row = (cells: Record<string, string>): SheetRow => ({ rowNumber: line++, cells });
const AT = '2026-09-01T10:00:00Z';
const aliceRows = () => [
  row({ [H.ts]: AT, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Alice Tan', [H.type]: 'Extra' }),
  row({ [H.ts]: AT, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Bob Tan', [H.type]: 'Extra' }),
];

beforeEach(async () => {
  await resetDb();
  line = 2;
});

async function publicSegment(capacity: number) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, capacity);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity, extrasPolicy: 'AUTO_FCFS' });
  return { concertId, showId, segmentId };
}

const counts = async (segmentId: number) => {
  const [r] = await sql<{ regs: string; seats: string }[]>`
    select (select count(*) from registrations where segment_id = ${segmentId}) as regs,
           (select count(*) from attendees where segment_id = ${segmentId}) as seats`;
  return { regs: Number(r.regs), seats: Number(r.seats) };
};

describe('QA-R1  two commits on two REAL connections', () => {
  it('writes the party exactly once', async () => {
    const { segmentId } = await publicSegment(100);
    const target = await loadSegmentTarget(segmentId);
    const p = profile();

    line = 2;
    const rowsA = aliceRows();
    line = 2;
    const rowsB = aliceRows();
    const planA = planImport(rowsA, p, await buildPlanContext(target, p, rowsA));
    const planB = planImport(rowsB, p, await buildPlanContext(target, p, rowsB));

    // Two module registries -> two postgres.js pools -> genuine contention.
    vi.resetModules();
    const modA = await import('@/lib/import/commit');
    const clientA = await import('@/db/client');
    vi.resetModules();
    const modB = await import('@/lib/import/commit');
    const clientB = await import('@/db/client');
    expect(modA).not.toBe(modB);
    expect(clientA.getSql()).not.toBe(clientB.getSql());

    const results = await Promise.allSettled([
      modA.commitImport({ target, filename: 'a.csv', plan: planA }),
      modB.commitImport({ target, filename: 'b.csv', plan: planB }),
    ]);
    // eslint-disable-next-line no-console
    console.log('QA-R1 outcomes:', JSON.stringify(results.map((r) => (r.status === 'fulfilled' ? r.value.createdRegistrations : String((r as PromiseRejectedResult).reason).slice(0, 80)))));
    const c = await counts(segmentId);
    console.log('QA-R1 counts:', JSON.stringify(c));
    await clientA.getSql().end();
    await clientB.getSql().end();
    expect(c).toEqual({ regs: 1, seats: 2 });
  });
});

/* ---------------------------------------------------------------- AC-24 */

describe('QA-R2  re-importing a file that filled the segment', () => {
  it('does not raise CAPACITY_EXCEEDED for seats already in the pool', async () => {
    const { segmentId } = await publicSegment(2); // exactly the two alice seats
    const first = await (async () => {
      const target = await loadSegmentTarget(segmentId);
      const p = profile();
      const rows = aliceRows();
      const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
      const { commitImport } = await import('@/lib/import/commit');
      return { plan, outcome: await commitImport({ target, filename: 'r1.csv', plan }) };
    })();
    // eslint-disable-next-line no-console
    console.log('QA-R2 round1 granted:', JSON.stringify(first.outcome.granted));

    line = 2;
    const target = await loadSegmentTarget(segmentId);
    const p = profile();
    const rows = aliceRows();
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    console.log('QA-R2 round2 findings:', JSON.stringify(plan.findings.map((f) => `${f.level}:${f.code}`)));
    console.log('QA-R2 round2 counts:', JSON.stringify(plan.counts));
    expect(plan.counts.blocking).toBe(0);
    expect(plan.findings.map((f) => f.code)).not.toContain('CAPACITY_EXCEEDED');
    expect(plan.findings.map((f) => f.code)).not.toContain('SEATS_WILL_WAITLIST');
  });
});

/* ---------------------------------------------------------------- AC-25 */

describe('QA-R3  a run with skipped parties AND one blocking row', () => {
  it('commits nothing at all', async () => {
    const { segmentId } = await publicSegment(100);
    await (async () => {
      const target = await loadSegmentTarget(segmentId);
      const p = profile();
      const rows = aliceRows();
      const { commitImport } = await import('@/lib/import/commit');
      await commitImport({ target, filename: 'r1.csv', plan: planImport(rows, p, await buildPlanContext(target, p, rows)) });
    })();
    const before = await counts(segmentId);

    line = 2;
    const target = await loadSegmentTarget(segmentId);
    const p = profile();
    const rows = [
      ...aliceRows(),
      // a genuinely new party whose allocation type maps to nothing -> BLOCKING
      row({ [H.ts]: '2026-09-03T10:00:00Z', [H.contact]: 'Dan Ho', [H.email]: 'dan@example.com', [H.name]: 'Dan Ho', [H.type]: 'Complimentary' }),
    ];
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    // eslint-disable-next-line no-console
    console.log('QA-R3 findings:', JSON.stringify(plan.findings.map((f) => `${f.level}:${f.code}`)));
    expect(plan.counts.blocking).toBeGreaterThan(0);

    const { commitImport } = await import('@/lib/import/commit');
    await expect(commitImport({ target, filename: 'r2.csv', plan })).rejects.toThrow(/blocking/i);
    console.log('QA-R3 counts after refusal:', JSON.stringify(await counts(segmentId)));
    expect(await counts(segmentId)).toEqual(before);
  });
});

/* ---------------------------------------------------------------- AC-21 */

describe('QA-R4  a party that grew a row since it was imported', () => {
  it('is skipped with a WARNING naming both sizes, and no seat is added', async () => {
    const { segmentId } = await publicSegment(100);
    const { commitImport } = await import('@/lib/import/commit');
    await (async () => {
      const target = await loadSegmentTarget(segmentId);
      const p = profile();
      const rows = aliceRows();
      await commitImport({ target, filename: 'r1.csv', plan: planImport(rows, p, await buildPlanContext(target, p, rows)) });
    })();
    const before = await counts(segmentId);

    line = 2;
    const target = await loadSegmentTarget(segmentId);
    const p = profile();
    const rows = [
      ...aliceRows(),
      row({ [H.ts]: AT, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Cara Tan', [H.type]: 'Extra' }),
    ];
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    const f = plan.findings.find((x) => x.code === 'PARTY_SIZE_CHANGED');
    // eslint-disable-next-line no-console
    console.log('QA-R4 finding:', JSON.stringify(f));
    expect(f?.level).toBe('WARNING');
    expect(f?.message).toMatch(/2 seats/);
    expect(f?.message).toMatch(/gives 3/);
    const outcome = await commitImport({ target, filename: 'r2.csv', plan });
    console.log('QA-R4 outcome:', JSON.stringify(outcome), 'counts:', JSON.stringify(await counts(segmentId)));
    expect(await counts(segmentId)).toEqual(before);
  });
});

/* ---------------------------------------------------------------- AC-18 */

describe('QA-R5  the same instant written differently', () => {
  it('matches across timezone offset notation, and a different instant does not', async () => {
    const { segmentId } = await publicSegment(100);
    const { commitImport } = await import('@/lib/import/commit');
    const target = await loadSegmentTarget(segmentId);
    const p = profile();
    const rows = aliceRows();
    await commitImport({ target, filename: 'r1.csv', plan: planImport(rows, p, await buildPlanContext(target, p, rows)) });

    const sameInstant = () => [
      row({ [H.ts]: '2026-09-01T18:00:00+08:00', [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Alice Tan', [H.type]: 'Extra' }),
      row({ [H.ts]: '2026-09-01T18:00:00+08:00', [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Bob Tan', [H.type]: 'Extra' }),
    ];
    line = 2;
    const r2 = sameInstant();
    const plan2 = planImport(r2, p, await buildPlanContext(target, p, r2));
    // eslint-disable-next-line no-console
    console.log('QA-R5 same instant, other offset -> skipped:', plan2.counts.skippedParties, 'key:', plan2.parties[0].dedupKey);
    expect(plan2.counts.skippedParties).toBe(1);

    line = 2;
    const r3 = [
      row({ [H.ts]: '2026-09-01T10:00:00.500Z', [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Alice Tan', [H.type]: 'Extra' }),
    ];
    const plan3 = planImport(r3, p, await buildPlanContext(target, p, r3));
    console.log('QA-R5 half-second later -> skipped:', plan3.counts.skippedParties, 'key:', plan3.parties[0].dedupKey);
    expect(plan3.counts.skippedParties).toBe(0);
  });
});

/* ---------------------------------------------------------------- AC-28 */

describe('QA-R6  cancel, re-import, restore', () => {
  it('records what actually happens to a cancelled party', async () => {
    const { segmentId } = await publicSegment(100);
    const { commitImport } = await import('@/lib/import/commit');
    const target = await loadSegmentTarget(segmentId);
    const p = profile();
    const rows = aliceRows();
    await commitImport({ target, filename: 'r1.csv', plan: planImport(rows, p, await buildPlanContext(target, p, rows)) });

    await sql`update registrations set status = 'CANCELLED' where segment_id = ${segmentId}`;
    const pool = await sql`select * from segment_pool(${segmentId})`;
    // eslint-disable-next-line no-console
    console.log('QA-R6 pool after cancel:', JSON.stringify(pool[0]));

    line = 2;
    const r2 = aliceRows();
    const plan2 = planImport(r2, p, await buildPlanContext(target, p, r2));
    console.log('QA-R6 re-import findings:', JSON.stringify(plan2.findings.map((f) => `${f.level}:${f.code}:${f.message}`)));
    console.log('QA-R6 skipped:', plan2.counts.skippedParties, 'live seats:', plan2.counts.seats);
    expect(plan2.counts.skippedParties).toBe(1);
  });
});

/* ------------------------------------------------- durable record (§9.6) */

describe('QA-R7  what import_batches records about a skipped party', () => {
  it('shows whether the report can distinguish skipped from written', async () => {
    const { segmentId } = await publicSegment(100);
    const { commitImport, recordDryRun } = await import('@/lib/import/commit');
    const target = await loadSegmentTarget(segmentId);
    const p = profile();
    const rows = aliceRows();
    await commitImport({ target, filename: 'r1.csv', plan: planImport(rows, p, await buildPlanContext(target, p, rows)) });

    line = 2;
    const r2 = [
      ...aliceRows(),
      row({ [H.ts]: '2026-09-04T10:00:00Z', [H.contact]: 'Carol Lim', [H.email]: 'carol@example.com', [H.name]: 'Carol Lim', [H.type]: 'Extra' }),
    ];
    const plan2 = planImport(r2, p, await buildPlanContext(target, p, r2));
    await recordDryRun({ target, filename: 'r2-dry.csv', plan: plan2 });
    const out = await commitImport({ target, filename: 'r2.csv', plan: plan2 });
    const batches = await sql<{ filename: string; created_count: number; skipped_count: number; report: Record<string, unknown> }[]>`
      select filename, created_count, skipped_count, report from import_batches order by id`;
    // eslint-disable-next-line no-console
    for (const b of batches) {
      console.log('QA-R7 batch:', b.filename, 'created', b.created_count, 'skipped', b.skipped_count);
    }
    const parties = (batches.at(-1)!.report as { parties: Record<string, unknown>[] }).parties;
    console.log('QA-R7 report party keys:', JSON.stringify(Object.keys(parties[0])));
    console.log('QA-R7 report parties:', JSON.stringify(parties));
    console.log('QA-R7 outcome:', JSON.stringify(out));
  });
});

/* ------------------------------------------------------------ AC-22, 23 */

describe('QA-R8  PLAYER_INVITED round 2 against real player matching', () => {
  it('skips the already-imported party and still blocks a different one for that player', async () => {
    const { createPlayers } = await import('../../tests/helpers/fixtures');
    const concertId = await createConcert();
    const showId = await createShow(concertId, 60);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 20,
      baseQuota: 2,
      extrasPolicy: 'AUTO_FCFS',
    });
    const playerIds = await createPlayers(concertId, 3);
    const names = await sql<{ id: number; full_name: string }[]>`
      select id, full_name from players where concert_id = ${concertId} order by id`;
    // eslint-disable-next-line no-console
    console.log('QA-R8 players:', JSON.stringify(names));
    const p1 = names[0].full_name;
    const p2 = names[1].full_name;
    expect(playerIds.length).toBe(3);

    const p = profile({ player_match: { column: H.contact, strategy: 'NAME' } });
    const { commitImport } = await import('@/lib/import/commit');
    const target = await loadSegmentTarget(segmentId);

    const r1 = [
      row({ [H.ts]: AT, [H.contact]: p1, [H.email]: 'p1@example.com', [H.name]: p1, [H.type]: 'Allocated' }),
      row({ [H.ts]: AT, [H.contact]: p1, [H.email]: 'p1@example.com', [H.name]: 'Guest One', [H.type]: 'Allocated' }),
    ];
    const plan1 = planImport(r1, p, await buildPlanContext(target, p, r1));
    console.log('QA-R8 round1 findings:', JSON.stringify(plan1.findings.map((f) => `${f.level}:${f.code}`)));
    const out1 = await commitImport({ target, filename: 'p-r1.csv', plan: plan1 });
    console.log('QA-R8 round1 outcome:', JSON.stringify(out1));
    expect(out1.createdRegistrations).toBe(1);

    // Round 2: the cumulative export — same party again, plus a new player.
    line = 2;
    const r2 = [
      row({ [H.ts]: AT, [H.contact]: p1, [H.email]: 'p1@example.com', [H.name]: p1, [H.type]: 'Allocated' }),
      row({ [H.ts]: AT, [H.contact]: p1, [H.email]: 'p1@example.com', [H.name]: 'Guest One', [H.type]: 'Allocated' }),
      row({ [H.ts]: '2026-09-05T09:00:00Z', [H.contact]: p2, [H.email]: 'p2@example.com', [H.name]: p2, [H.type]: 'Allocated' }),
    ];
    const plan2 = planImport(r2, p, await buildPlanContext(target, p, r2));
    console.log('QA-R8 round2 findings:', JSON.stringify(plan2.findings.map((f) => `${f.level}:${f.code}`)));
    expect(plan2.counts.blocking).toBe(0);
    expect(plan2.counts.skippedParties).toBe(1);
    const out2 = await commitImport({ target, filename: 'p-r2.csv', plan: plan2 });
    console.log('QA-R8 round2 outcome:', JSON.stringify(out2), 'counts:', JSON.stringify(await counts(segmentId)));
    expect(out2.createdRegistrations).toBe(1);

    // A genuinely different submission by player 1 still blocks (§7.6).
    line = 2;
    const r3 = [
      row({ [H.ts]: '2026-09-06T09:00:00Z', [H.contact]: p1, [H.email]: 'p1@example.com', [H.name]: p1, [H.type]: 'Allocated' }),
    ];
    const plan3 = planImport(r3, p, await buildPlanContext(target, p, r3));
    console.log('QA-R8 round3 findings:', JSON.stringify(plan3.findings.map((f) => `${f.level}:${f.code}`)));
    expect(plan3.findings.map((f) => f.code)).toContain('PLAYER_ALREADY_REGISTERED');
    expect(plan3.counts.blocking).toBeGreaterThan(0);
  });
});

/* ------------------------------------------- group_key: two parties, one key */

describe('QA-R9  a mapped group_key that puts one email+timestamp in two parties', () => {
  it('records what the second import does with them', async () => {
    const { segmentId } = await publicSegment(100);
    const { commitImport } = await import('@/lib/import/commit');
    const target = await loadSegmentTarget(segmentId);
    const p = profile({ columns: {
      requested_at: H.ts, contact_name: H.contact, contact_email: H.email,
      attendee_name: H.name, allocation_type: H.type, group_key: 'Group',
    } });

    const rows = () => [
      row({ [H.ts]: AT, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Alice Tan', [H.type]: 'Extra', Group: 'g1' }),
      row({ [H.ts]: AT, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Bob Tan', [H.type]: 'Extra', Group: 'g2' }),
    ];
    const r1 = rows();
    const plan1 = planImport(r1, p, await buildPlanContext(target, p, r1));
    // eslint-disable-next-line no-console
    console.log('QA-R9 round1 parties:', plan1.counts.parties, 'keys:', JSON.stringify(plan1.parties.map((x) => x.dedupKey)));
    await commitImport({ target, filename: 'g1.csv', plan: plan1 });
    console.log('QA-R9 counts after round1:', JSON.stringify(await counts(segmentId)));

    line = 2;
    const r2 = rows();
    const plan2 = planImport(r2, p, await buildPlanContext(target, p, r2));
    console.log('QA-R9 round2 findings:', JSON.stringify(plan2.findings.map((f) => `${f.level}:${f.code}:${f.message}`)));
    const out = await commitImport({ target, filename: 'g2.csv', plan: plan2 });
    console.log('QA-R9 round2 outcome:', JSON.stringify(out), 'counts:', JSON.stringify(await counts(segmentId)));
    // The property that matters: nothing is written twice.
    expect(await counts(segmentId)).toEqual({ regs: 2, seats: 2 });
  });
});
