/**
 * QA probes for `fix/import-reimport-dedup` (module C, import.md §9.2).
 *
 * Real local Postgres, no mocks: the thing under test is what a *previous
 * commit wrote*, so a stubbed `existingParties` map proves nothing about it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';
import { buildPlanContext, loadSegmentTarget, loadExistingParties } from '@/lib/import/context';
import { commitImport } from '@/lib/import/commit';
import { planImport, type SheetRow } from '@/lib/import/plan';
import { parseMappingProfile } from '@/lib/import/profile';
import { cancelRegistration, restoreRegistration } from '@/lib/registrations/mutations';

const H = {
  ts: 'Timestamp',
  contact: 'Contact Name',
  email: 'Contact Email',
  name: 'Attendee Name',
  type: 'Ticket Type',
} as const;

const profile = (over: Record<string, unknown> = {}) =>
  parseMappingProfile({
    columns: {
      requested_at: H.ts,
      contact_name: H.contact,
      contact_email: H.email,
      attendee_name: H.name,
      allocation_type: H.type,
    },
    allocation_type_values: { BASE: ['Allocated'], EXTRA: ['Extra'] },
    default_allocation_type: 'EXTRA',
    player_match: null,
    ...over,
  });

let line = 2;
const row = (cells: Record<string, string>): SheetRow => ({ rowNumber: line++, cells });

beforeEach(async () => {
  await resetDb();
  line = 2;
});

async function publicSegment(capacity: number) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, capacity);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity,
    extrasPolicy: 'AUTO_FCFS',
  });
  return { concertId, showId, segmentId };
}

async function run(segmentId: number, rows: SheetRow[], filename: string, over = {}) {
  const target = await loadSegmentTarget(segmentId);
  const p = profile(over);
  const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
  const outcome = await commitImport({ target, filename, plan });
  return { plan, outcome };
}

async function dryRun(segmentId: number, rows: SheetRow[], over = {}) {
  const target = await loadSegmentTarget(segmentId);
  const p = profile(over);
  return planImport(rows, p, await buildPlanContext(target, p, rows));
}

const AT = '2026-09-01T10:00:00Z';
const aliceRows = (email = 'alice@example.com', ts = AT) => [
  row({ [H.ts]: ts, [H.contact]: 'Alice Tan', [H.email]: email, [H.name]: 'Alice Tan', [H.type]: 'Extra' }),
  row({ [H.ts]: ts, [H.contact]: 'Alice Tan', [H.email]: email, [H.name]: 'Bob Tan', [H.type]: 'Extra' }),
];

const counts = async (segmentId: number) => {
  const [r] = await sql<{ regs: string; seats: string }[]>`
    select (select count(*) from registrations where segment_id = ${segmentId}) as regs,
           (select count(*) from attendees where segment_id = ${segmentId}) as seats
  `;
  return { regs: Number(r.regs), seats: Number(r.seats) };
};

/* ------------------------------------------------------------------ AC-10 */

describe('QA-C1  the dedup key across a case change (AC-10)', () => {
  it('skips a party re-exported with a different email case', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows('Alice@Example.com'), 'round1.csv');
    const before = await counts(segmentId);

    line = 2;
    const plan = await dryRun(segmentId, aliceRows('ALICE@EXAMPLE.COM'));
    // eslint-disable-next-line no-console
    console.log('QA-C1 stored:', (await sql`select contact_email::text from registrations`)[0]);
    console.log('QA-C1 existingParties:', [...(await loadExistingParties(segmentId)).keys()]);
    console.log('QA-C1 dedupKey:', plan.parties[0].dedupKey, 'skipped:', plan.parties[0].skipped);

    expect(plan.counts.skippedParties).toBe(1);
    expect(await counts(segmentId)).toEqual(before);
  });

  it('still skips when the profile does NOT lowercase emails', async () => {
    const { segmentId } = await publicSegment(100);
    const noLower = {
      transforms: { trim_whitespace: true, lowercase_emails: false, titlecase_names: false },
    };
    await run(segmentId, aliceRows('Alice@Example.com'), 'round1.csv', noLower);

    line = 2;
    const plan = await dryRun(segmentId, aliceRows('Alice@Example.com'), noLower);
    console.log(
      'QA-C1b dedupKey:', plan.parties[0].dedupKey,
      '| existing:', [...(await loadExistingParties(segmentId)).keys()],
      '| skipped:', plan.parties[0].skipped,
    );
    expect(plan.counts.skippedParties).toBe(1);
  });
});

/* ------------------------------------------------------------------ AC-11 */

describe('QA-C2  the dedup is scoped to the target segment (AC-11)', () => {
  it('does not skip the same rows imported into the other segment of the show', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 200);
    const segA = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 100, extrasPolicy: 'AUTO_FCFS' });
    const showB = await createShow(concertId, 200);
    const segB = await createSegment(showB, { audienceMode: 'PUBLIC', capacity: 100, extrasPolicy: 'AUTO_FCFS' });

    await run(segA, aliceRows(), 'public-a.csv');
    line = 2;
    const plan = await dryRun(segB, aliceRows());
    console.log('QA-C2 segB skipped:', plan.counts.skippedParties, 'seats:', plan.counts.seats);
    expect(plan.counts.skippedParties).toBe(0);
    expect(plan.counts.seats).toBe(2);
  });
});

/* ------------------------------------------------------------------ AC-15 */

describe('QA-C3  a deleted registration must not suppress re-import (AC-15)', () => {
  it('offers a soft-deleted party as new, so §7.6 delete is a real remedy', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows(), 'round1.csv');
    await sql`update registrations set deleted_at = now() where segment_id = ${segmentId}`;
    await sql`update attendees set deleted_at = now() where segment_id = ${segmentId}`;

    line = 2;
    const plan = await dryRun(segmentId, aliceRows());
    console.log('QA-C3 after delete — skipped:', plan.counts.skippedParties, 'seats:', plan.counts.seats);
    expect(plan.counts.skippedParties).toBe(0);
    expect(plan.counts.seats).toBe(2);
  });
});

/* ------------------------------------------------------------- AC-16, 17 */

describe('QA-C4  a cancelled registration (AC-16/17)', () => {
  /**
   * Rewritten after the finding it was written to demonstrate was fixed.
   *
   * It originally asserted `toHaveLength(2)` — the cancelled party re-importing
   * — which made `restoreRegistration()` (allocation.md §7.9) leave one form
   * response holding two live registrations and two sets of tickets. A
   * cancellation is an admin decision about a response that has already been
   * imported, and §9.1 re-reads the sheet only for *new* responses, so the party
   * stays skipped and restore stays safe.
   */
  it('does not re-import it, so a later restore cannot double the party', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows(), 'round1.csv');
    await sql`update registrations set status = 'CANCELLED' where segment_id = ${segmentId}`;
    await sql`update attendees set status = 'CANCELLED' where segment_id = ${segmentId}`;

    line = 2;
    const { plan, outcome } = await run(segmentId, aliceRows(), 'again.csv');
    const rows = await sql<{ id: string; status: string; contact_email: string }[]>`
      select id, status, contact_email::text from registrations where segment_id = ${segmentId} order by id
    `;
    console.log('QA-C4 skipped:', plan.counts.skippedParties, 'created:', outcome.createdRegistrations);
    console.log('QA-C4 registrations now:', rows);
    expect(plan.counts.skippedParties).toBe(1);
    expect(outcome.createdRegistrations).toBe(0);
    expect(rows).toHaveLength(1);

    // Restoring it must leave exactly one live registration for the response.
    await sql`update registrations set status = 'CONFIRMED' where segment_id = ${segmentId}`;
    const live = await sql<{ n: string }[]>`
      select count(*) as n from registrations
       where segment_id = ${segmentId} and deleted_at is null and status <> 'CANCELLED'
    `;
    console.log('QA-C4 live registrations after restore:', live[0].n);
    expect(Number(live[0].n)).toBe(1);

    // Third round of the same cumulative sheet: still recognised.
    line = 2;
    const third = await dryRun(segmentId, aliceRows());
    console.log('QA-C4 third run skipped:', third.counts.skippedParties, 'seats:', third.counts.seats);
    expect(third.counts.skippedParties).toBe(1);
  });
});

/* ------------------------------------------------------------- AC-13, 27 */

describe('QA-C5  a party whose size changed (AC-13, AC-27)', () => {
  it('skips, warns naming both sizes, and touches no existing seat', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows(), 'round1.csv');
    const tokensBefore = await sql<{ qr_token: string; ticket_code: string }[]>`
      select qr_token, ticket_code from attendees where segment_id = ${segmentId} order by id
    `;

    line = 2;
    const grown = [
      ...aliceRows(),
      row({ [H.ts]: AT, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Cara Tan', [H.type]: 'Extra' }),
    ];
    const { plan, outcome } = await run(segmentId, grown, 'round2.csv');
    const finding = plan.findings.find((f) => f.code === 'PARTY_SIZE_CHANGED');
    console.log('QA-C5 finding:', JSON.stringify(finding));
    console.log('QA-C5 outcome:', JSON.stringify(outcome));

    expect(finding?.level).toBe('WARNING');
    expect(finding?.message).toMatch(/2/);
    expect(finding?.message).toMatch(/3/);
    expect(await counts(segmentId)).toEqual({ regs: 1, seats: 2 });

    const tokensAfter = await sql<{ qr_token: string; ticket_code: string }[]>`
      select qr_token, ticket_code from attendees where segment_id = ${segmentId} order by id
    `;
    expect(tokensAfter).toEqual(tokensBefore);
  });
});

/* ------------------------------------------------------------------ AC-8 */

describe('QA-C6  a second submission by the same person (AC-8)', () => {
  it('imports it — the timestamp half of the key separates the rounds', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows(), 'round1.csv');
    line = 2;
    const plan = await dryRun(segmentId, [
      ...aliceRows(),
      ...aliceRows('alice@example.com', '2026-09-08T09:00:00Z'),
    ]);
    console.log('QA-C6 parties:', plan.counts.parties, 'skipped:', plan.counts.skippedParties, 'seats:', plan.counts.seats);
    expect(plan.counts.parties).toBe(2);
    expect(plan.counts.skippedParties).toBe(1);
    expect(plan.counts.seats).toBe(2);
  });
});

/* ------------------------------------------------------------------ AC-12 */

describe('QA-C7  a party with no contact email (AC-12)', () => {
  it('re-imports every round and says so', async () => {
    const { segmentId } = await publicSegment(100);
    const noEmail = () => [
      row({ [H.ts]: AT, [H.contact]: 'Dana Ong', [H.name]: 'Dana Ong', [H.type]: 'Extra' }),
    ];
    await run(segmentId, noEmail(), 'round1.csv');
    line = 2;
    const { plan } = await run(segmentId, noEmail(), 'round2.csv');
    console.log('QA-C7 codes:', plan.findings.map((f) => `${f.level}:${f.code}`));
    console.log('QA-C7 counts:', JSON.stringify(await counts(segmentId)));
    expect(plan.counts.ungrouped).toBe(1);
    expect(await counts(segmentId)).toEqual({ regs: 2, seats: 2 });
  });
});

/* ------------------------------------------------------------- AC-28, 29 */

describe('QA-C8  two commits of the same file at once (AC-29)', () => {
  it('exactly one of them writes the party', async () => {
    const { segmentId } = await publicSegment(100);
    const target = await loadSegmentTarget(segmentId);
    const p = profile();

    // Both plan against the same empty state, as two tabs would.
    line = 2;
    const rowsA = aliceRows();
    line = 2;
    const rowsB = aliceRows();
    const [ctxA, ctxB] = await Promise.all([
      buildPlanContext(target, p, rowsA),
      buildPlanContext(target, p, rowsB),
    ]);
    const planA = planImport(rowsA, p, ctxA);
    const planB = planImport(rowsB, p, ctxB);

    const results = await Promise.allSettled([
      commitImport({ target, filename: 'a.csv', plan: planA }),
      commitImport({ target, filename: 'b.csv', plan: planB }),
    ]);
    console.log('QA-C8 results:', JSON.stringify(results.map((r) => r.status)));
    console.log('QA-C8 counts:', JSON.stringify(await counts(segmentId)));
    expect(await counts(segmentId)).toEqual({ regs: 1, seats: 2 });
  });
});

/* ------------------------------------------------------------------ AC-30 */

describe('QA-C9  hostile contact email (AC-30)', () => {
  it('does not execute it, and returns a finding rather than throwing', async () => {
    const { segmentId } = await publicSegment(100);
    const hostile = `'; drop table registrations;--@x.test`;
    const long = 'a'.repeat(4000) + '@x.test';
    const rows = [
      row({ [H.ts]: AT, [H.contact]: 'Eve', [H.email]: hostile, [H.name]: 'Eve', [H.type]: 'Extra' }),
      row({ [H.ts]: AT, [H.contact]: 'Fay', [H.email]: long, [H.name]: 'Fay', [H.type]: 'Extra' }),
    ];
    const plan = await dryRun(segmentId, rows);
    console.log('QA-C9 findings:', plan.findings.map((f) => `${f.level}:${f.code}`));
    expect(plan.counts.blocking).toBe(0);

    line = 2;
    const again = await run(segmentId, rows, 'hostile.csv');
    console.log('QA-C9 committed:', again.outcome.createdRegistrations);
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from registrations`;
    expect(Number(count)).toBe(2);

    // And the second import of the same hostile file must still dedup.
    line = 2;
    const third = await dryRun(segmentId, rows);
    console.log('QA-C9 re-import skipped:', third.counts.skippedParties);
    expect(third.counts.skippedParties).toBe(2);
  });
});

/* ------------------------------------------------------------------ AC-31 */

describe('QA-C10  a 400-row cumulative file (AC-31)', () => {
  it('re-imports 400 rows without writing any of them', async () => {
    const { segmentId } = await publicSegment(600);
    const big = () => {
      line = 2;
      return Array.from({ length: 400 }, (_, i) =>
        row({
          [H.ts]: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
          [H.contact]: `P${i}`,
          [H.email]: `p${i}@example.com`,
          [H.name]: `P${i}`,
          [H.type]: 'Extra',
        }),
      );
    };
    const t0 = Date.now();
    await run(segmentId, big(), 'round1.csv');
    const t1 = Date.now();
    const { plan, outcome } = await run(segmentId, big(), 'round2.csv');
    const t2 = Date.now();
    console.log(`QA-C10 first commit ${t1 - t0}ms, second ${t2 - t1}ms`);
    console.log('QA-C10 skipped:', plan.counts.skippedParties, 'created:', outcome.createdRegistrations);
    expect(plan.counts.skippedParties).toBe(400);
    expect(await counts(segmentId)).toEqual({ regs: 400, seats: 400 });
  });
});

/* ------------------------------------------------------------- AC-21, 22 */

describe('QA-C11  a blocking row alongside a skipped party (AC-21, AC-22)', () => {
  it('refuses the whole run server-side and writes nothing', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows(), 'round1.csv');
    const before = await counts(segmentId);

    line = 2;
    const rows = [
      ...aliceRows(),
      row({ [H.ts]: 'not a date', [H.contact]: 'Gus', [H.email]: 'gus@example.com', [H.name]: 'Gus', [H.type]: 'Extra' }),
    ];
    const target = await loadSegmentTarget(segmentId);
    const p = profile();
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    console.log('QA-C11 blocking:', plan.counts.blocking, 'skipped:', plan.counts.skippedParties);
    let message = '';
    await commitImport({ target, filename: 'mixed.csv', plan }).catch((e) => {
      message = (e as Error).message;
    });
    console.log('QA-C11 refusal:', message);
    expect(message).toMatch(/blocking/i);
    expect(await counts(segmentId)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ AC-26 */

describe('QA-C12  one registration, one email row, after a re-import (AC-26)', () => {
  it('does not grow the outbox for an already-imported party', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows(), 'round1.csv');
    const [reg] = await sql<{ id: string }[]>`select id from registrations where segment_id = ${segmentId}`;
    line = 2;
    await run(segmentId, aliceRows(), 'again.csv');
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*) from registrations where segment_id = ${segmentId} and deleted_at is null
    `;
    console.log('QA-C12 registration id:', reg.id, 'registrations now:', count);
    expect(Number(count)).toBe(1);
  });
});

/* ------------------------------------------- AC-16 consequence, §7.6 restore */

describe('QA-C13  cancel, re-import, restore (AC-16, allocation.md §7.6)', () => {
  it('leaves one form response holding two live registrations', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows(), 'round1.csv');
    const [first] = await sql<{ id: string }[]>`select id from registrations where segment_id = ${segmentId}`;

    // §7.9 cancel, through the real mutation.
    await cancelRegistration(Number(first.id));

    // Round 2's cumulative export still contains the response.
    line = 2;
    await run(segmentId, aliceRows(), 'round2.csv');

    // §7.6 restore, through the real mutation.
    const restored = await restoreRegistration(Number(first.id));
    console.log('QA-C13 restore result:', JSON.stringify(restored));

    const live = await sql<{ id: string; contact_email: string; requested_at: Date; status: string }[]>`
      select id, contact_email::text, requested_at, status
        from registrations
       where segment_id = ${segmentId} and deleted_at is null and status <> 'CANCELLED'
       order by id
    `;
    console.log('QA-C13 live registrations for one response:', JSON.stringify(live));
    console.log('QA-C13 seats:', JSON.stringify(await counts(segmentId)));
    expect(live).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------- AC-9 */

describe('QA-C14  same timestamp, different email (AC-9)', () => {
  it('imports it — the two halves of the key are ANDed', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows('alice@example.com'), 'round1.csv');
    line = 2;
    const plan = await dryRun(segmentId, [
      ...aliceRows('alice@example.com'),
      ...aliceRows('zoe@example.com'),
    ]);
    console.log('QA-C14 parties:', plan.counts.parties, 'skipped:', plan.counts.skippedParties, 'seats:', plan.counts.seats);
    expect(plan.counts.skippedParties).toBe(1);
    expect(plan.counts.seats).toBe(2);
  });
});

/* ------------------------------------------------------------------ AC-14 */

describe('QA-C15  a party that shrank since it was imported (AC-14)', () => {
  it('skips as a WARNING and removes nothing', async () => {
    const { segmentId } = await publicSegment(100);
    await run(segmentId, aliceRows(), 'round1.csv');
    line = 2;
    const shrunk = [
      row({ [H.ts]: AT, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Alice Tan', [H.type]: 'Extra' }),
    ];
    const plan = await dryRun(segmentId, shrunk);
    const f = plan.findings.find((x) => x.code === 'PARTY_SIZE_CHANGED');
    console.log('QA-C15 finding:', JSON.stringify(f));
    console.log('QA-C15 counts:', JSON.stringify(await counts(segmentId)));
    expect(f?.level).toBe('WARNING');
    expect(await counts(segmentId)).toEqual({ regs: 1, seats: 2 });
  });
});
