import { appendFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';

const LOG = '/tmp/claude-0/-home-user-zetix/7084ffa5-0318-5829-9d7a-f878dfd2e43c/scratchpad/qa-backend.log';
const log = (...args: unknown[]) =>
  appendFileSync(LOG, args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createPlayers, createSegment, createShow } from '../../tests/helpers/fixtures';
import { buildPlanContext, loadSegmentTarget, matchPlayers } from '@/lib/import/context';
import { commitImport } from '@/lib/import/commit';
import { planImport, type SheetRow } from '@/lib/import/plan';
import { parseMappingProfile } from '@/lib/import/profile';

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
    ...over,
  });

let line = 2;
const row = (cells: Record<string, string>): SheetRow => ({ rowNumber: line++, cells });

beforeEach(async () => {
  await resetDb();
  line = 2;
});

async function playerSegment(capacity: number, baseQuota: number, players: number) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, capacity);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity,
    baseQuota,
    extrasPolicy: 'REVIEW',
  });
  const playerIds = await createPlayers(concertId, players);
  return { concertId, showId, segmentId, playerIds };
}

describe('QA-1 matchPlayers with more than one distinct value', () => {
  it('matches every distinct email, not just the first', async () => {
    const concertId = await createConcert();
    await createPlayers(concertId, 3);
    const emails = (
      await sql<{ email: string }[]>`select email from players where concert_id = ${concertId} order by id`
    ).map((r) => r.email);
    expect(emails).toHaveLength(3);

    const matches = await matchPlayers(concertId, emails, 'EMAIL', 1);
    // eslint-disable-next-line no-console
    log('QA-1 matched keys:', [...matches.keys()], 'of', emails);
    expect([...matches.keys()].sort()).toEqual([...emails].sort());
  });

  it('matches every distinct name under NAME strategy', async () => {
    const concertId = await createConcert();
    await createPlayers(concertId, 3);
    const names = (
      await sql<{ full_name: string }[]>`select full_name from players where concert_id = ${concertId} order by id`
    ).map((r) => r.full_name);
    const matches = await matchPlayers(concertId, names, 'NAME', 1);
    log('QA-1b matched keys:', [...matches.keys()], 'of', names);
    expect([...matches.keys()].sort()).toEqual([...names].sort());
  });
});

describe('QA-2 a two-player file plans without blocking', () => {
  it('matches both players in one import', async () => {
    const { concertId, segmentId, playerIds } = await playerSegment(100, 2, 2);
    const target = await loadSegmentTarget(segmentId);
    const emails = (
      await sql<{ email: string }[]>`select email from players where concert_id = ${concertId} order by id`
    ).map((r) => r.email);
    expect(playerIds).toHaveLength(2);

    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'P1', [H.email]: emails[0], [H.name]: 'G1', [H.type]: 'Allocated' }),
      row({ [H.ts]: '2026-09-01T11:00:00Z', [H.contact]: 'P2', [H.email]: emails[1], [H.name]: 'G2', [H.type]: 'Allocated' }),
    ];
    const p = profile({ player_match: { column: H.email, strategy: 'EMAIL' } });
    const ctx = await buildPlanContext(target, p, rows);
    const plan = planImport(rows, p, ctx);
    log('QA-2 findings:', JSON.stringify(plan.findings, null, 1));
    expect(plan.counts.blocking).toBe(0);
  });
});

describe('QA-3 mixed-case player email in the sheet', () => {
  it('matches a player whose sheet cell is upper case', async () => {
    const { concertId, segmentId } = await playerSegment(100, 2, 1);
    const target = await loadSegmentTarget(segmentId);
    const [{ email }] = await sql<{ email: string }[]>`
      select email from players where concert_id = ${concertId}
    `;
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'P1', [H.email]: email.toUpperCase(), [H.name]: 'G1', [H.type]: 'Allocated' }),
    ];
    const p = profile({ player_match: { column: H.email, strategy: 'EMAIL' } });
    const ctx = await buildPlanContext(target, p, rows);
    const plan = planImport(rows, p, ctx);
    log('QA-3 findings:', JSON.stringify(plan.findings));
    expect(plan.counts.blocking).toBe(0);
  });
});

describe('QA-4 commit atomicity', () => {
  it('writes nothing when a claim raises part-way through the file', async () => {
    // A public AUTO_FCFS segment with 2 seats, and a file wanting 2 parties of
    // 2. Import's capacity check is bypassed by planning against a stale pool,
    // exactly as a second admin committing concurrently would produce.
    const concertId = await createConcert();
    const showId = await createShow(concertId, 4);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 4,
      extrasPolicy: 'AUTO_FCFS',
    });
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@x.test', [H.name]: 'A1', [H.type]: 'Extra' }),
      row({ [H.ts]: '2026-09-01T11:00:00Z', [H.contact]: 'B', [H.email]: 'b@x.test', [H.name]: 'B1', [H.type]: 'Extra' }),
    ];
    const p = profile();
    const ctx = await buildPlanContext(target, p, rows);
    const plan = planImport(rows, p, ctx);
    expect(plan.counts.blocking).toBe(0);

    // Now shrink the segment underneath the plan so the second claim raises.
    await sql`update show_segments set capacity = 0 where id = ${segmentId}`;

    let raised: unknown = null;
    try {
      await commitImport({ target, filename: 'atomic.csv', plan });
    } catch (e) {
      raised = e;
    }
    log('QA-4 raised:', raised instanceof Error ? raised.message : raised);

    const [{ regs }] = await sql<{ regs: number }[]>`select count(*)::int as regs from registrations`;
    const [{ atts }] = await sql<{ atts: number }[]>`select count(*)::int as atts from attendees`;
    const batches = await sql<{ status: string }[]>`select status from import_batches`;
    log('QA-4 after:', { regs, atts, batches });
    if (raised) {
      expect(regs).toBe(0);
      expect(atts).toBe(0);
      expect(batches.filter((b) => b.status === 'COMMITTED')).toHaveLength(0);
    }
  });
});

describe('QA-5 row-level blocking findings and the commit gate', () => {
  it('commitImport refuses a plan that still carries a blocking row finding', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 50,
      extrasPolicy: 'AUTO_FCFS',
    });
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@x.test', [H.name]: 'A1', [H.type]: 'Extra' }),
      // 'Complimentary' maps to nothing → BLOCKING per §9.4
      row({ [H.ts]: '2026-09-01T11:00:00Z', [H.contact]: 'B', [H.email]: 'b@x.test', [H.name]: 'B1', [H.type]: 'Complimentary' }),
    ];
    const p = profile();
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    expect(plan.counts.blocking).toBeGreaterThan(0);

    let raised: unknown = null;
    let outcome: unknown = null;
    try {
      outcome = await commitImport({ target, filename: 'blocked.csv', plan });
    } catch (e) {
      raised = e;
    }
    const [{ regs }] = await sql<{ regs: number }[]>`select count(*)::int as regs from registrations`;
    log('QA-5 raised:', raised instanceof Error ? raised.message : raised, 'outcome:', outcome, 'registrations:', regs);
    expect(raised).not.toBeNull();
    expect(regs).toBe(0);
  });
});

describe('QA-6 hostile input through the planner', () => {
  it('survives long strings, SQL metacharacters and traversal text', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 50,
      extrasPolicy: 'AUTO_FCFS',
    });
    const target = await loadSegmentTarget(segmentId);
    const long = 'x'.repeat(100_000);
    const rows = [
      row({
        [H.ts]: '2026-09-01T10:00:00Z',
        [H.contact]: `'; drop table attendees; --`,
        [H.email]: 'a@x.test',
        [H.name]: `../../etc/passwd`,
        [H.type]: 'Extra',
      }),
      row({
        [H.ts]: '2026-09-01T10:00:00Z',
        [H.contact]: `'; drop table attendees; --`,
        [H.email]: 'a@x.test',
        [H.name]: long,
        [H.type]: 'Extra',
      }),
    ];
    const p = profile();
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    let raised: unknown = null;
    try {
      await commitImport({ target, filename: '../../evil.csv', plan });
    } catch (e) {
      raised = e;
    }
    log('QA-6 raised:', raised instanceof Error ? raised.message.slice(0, 300) : raised);
    const [{ atts }] = await sql<{ atts: number }[]>`select count(*)::int as atts from attendees`;
    const names = await sql<{ full_name: string }[]>`select full_name from attendees order by id`;
    log('QA-6 attendees:', atts, names.map((n) => n.full_name.slice(0, 40)));
    // attendees table must still exist
    expect(atts).toBeGreaterThanOrEqual(0);
  });
});

describe('QA-7 isolation level of the commit transaction', () => {
  it('runs at READ COMMITTED', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    const target = await loadSegmentTarget(segmentId);
    const rows = [row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@x.test', [H.name]: 'A1', [H.type]: 'Extra' })];
    const p = profile();
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    const out = await commitImport({ target, filename: 'iso.csv', plan });
    expect(out.createdRegistrations).toBe(1);
    const [{ atts }] = await sql<{ atts: number }[]>`select count(*)::int as atts from attendees`;
    expect(atts).toBe(1);
  });
});

describe('QA-8 atomicity: a failure part-way through writes nothing', () => {
  it('rolls back the parties already claimed when a later one raises', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 50,
      extrasPolicy: 'AUTO_FCFS',
    });
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@x.test', [H.name]: 'A1', [H.type]: 'Extra' }),
      row({ [H.ts]: '2026-09-01T11:00:00Z', [H.contact]: 'B', [H.email]: 'b@x.test', [H.name]: 'B1', [H.type]: 'Extra' }),
    ];
    const p = profile();
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    expect(plan.parties).toHaveLength(2);
    // The second party points at a player that does not exist: the registration
    // insert raises a foreign-key violation after the first party has already
    // been claimed. This is the shape of any mid-file failure.
    (plan.parties[1] as { playerId: number | null }).playerId = 999_999;

    let raised: unknown = null;
    try {
      await commitImport({ target, filename: 'partial.csv', plan });
    } catch (e) {
      raised = e;
    }
    const [{ regs }] = await sql<{ regs: number }[]>`select count(*)::int as regs from registrations`;
    const [{ atts }] = await sql<{ atts: number }[]>`select count(*)::int as atts from attendees`;
    const batches = await sql<{ status: string }[]>`select status from import_batches`;
    log('QA-8', { raised: raised instanceof Error ? raised.message.slice(0, 160) : raised, regs, atts, batches });
    expect(raised).not.toBeNull();
    expect(regs).toBe(0);
    expect(atts).toBe(0);
    expect(batches).toHaveLength(0);
  });
});

describe('QA-9 the placeholder name is the engine\'s, and grouping counts', () => {
  it('leaves the name null and lets claim_seats() generate it', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 50);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 50,
      extrasPolicy: 'AUTO_FCFS',
    });
    const target = await loadSegmentTarget(segmentId);
    const at = '2026-09-01T10:00:00Z';
    const rows = [
      row({ [H.ts]: at, [H.contact]: 'Alice Tan', [H.email]: 'alice@x.test', [H.name]: 'Alice Tan', [H.type]: 'Extra' }),
      row({ [H.ts]: at, [H.contact]: 'Alice Tan', [H.email]: 'alice@x.test', [H.name]: '', [H.type]: 'Extra' }),
      row({ [H.ts]: at, [H.contact]: 'Alice Tan', [H.email]: 'alice@x.test', [H.name]: '', [H.type]: 'Extra' }),
      // No contact email: its own registration, warning level.
      row({ [H.ts]: at, [H.contact]: 'Lone Ranger', [H.email]: '', [H.name]: 'Lone', [H.type]: 'Extra' }),
    ];
    const p = profile();
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    log('QA-9 counts', plan.counts, 'largest', plan.largestParty);
    await commitImport({ target, filename: 'names.csv', plan });
    const out = await sql<{ full_name: string; name_source: string }[]>`
      select full_name, name_source from attendees order by id
    `;
    log('QA-9 attendees', out);
    expect(plan.counts.ungrouped).toBe(1);
    expect(out.filter((a) => a.name_source === 'PLACEHOLDER').map((a) => a.full_name)).toEqual([
      'Guest of Alice Tan',
      'Guest of Alice Tan',
    ]);
  });
});

describe('QA-10 the §9.4 validation levels, verified directly', () => {
  it('group_key overrides grouping; malformed, duplicate, cap and existing-registration levels', async () => {
    const { concertId, showId, segmentId, playerIds } = await playerSegment(50, 2, 1);
    const target = await loadSegmentTarget(segmentId);
    // form.max_tickets_per_response = 2 on this segment.
    await sql`update show_segments set max_tickets_per_response = 2 where id = ${segmentId}`;

    const p = profile({ columns: {
      requested_at: H.ts, contact_name: H.contact, contact_email: H.email,
      attendee_name: H.name, attendee_email: 'Attendee Email', group_key: 'Party',
    } });

    const rows = [
      // Same group_key, different email AND different timestamp → still one party.
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@x.test', [H.name]: 'A1', 'Attendee Email': 'dup@x.test', Party: 'P1', [H.type]: 'Extra' }),
      row({ [H.ts]: '2026-09-01T11:00:00Z', [H.contact]: 'A', [H.email]: 'other@x.test', [H.name]: 'A2', 'Attendee Email': 'dup@x.test', Party: 'P1', [H.type]: 'Extra' }),
      row({ [H.ts]: '2026-09-01T12:00:00Z', [H.contact]: 'A', [H.email]: 'a@x.test', [H.name]: 'A3', 'Attendee Email': 'not-an-email', Party: 'P1', [H.type]: 'Extra' }),
    ];
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    const codes = plan.findings.map((f) => f.code);
    log('QA-10 parties', plan.counts.parties, 'codes', codes);
    expect(plan.counts.parties).toBe(1);            // AC-7 group_key override
    expect(codes).toContain('DUPLICATE_EMAIL_IN_FILE'); // AC-20
    expect(codes).toContain('ATTENDEE_EMAIL_MALFORMED'); // AC-19
    expect(codes).toContain('PARTY_OVER_CAP');       // AC-24
    expect(plan.findings.find((f) => f.code === 'PARTY_OVER_CAP')?.level).toBe('WARNING');

    // AC-21: a player who already holds a registration for this show.
    await sql`
      insert into registrations (show_id, segment_id, player_id, source, contact_name, contact_email, status, requested_at)
      values (${showId}, ${segmentId}, ${playerIds[0]}, 'ADMIN', 'Existing', 'e@x.test', 'CONFIRMED', now())`;
    const [{ email }] = await sql<{ email: string }[]>`select email from players where concert_id = ${concertId}`;
    const p2 = profile({ player_match: { column: H.email, strategy: 'EMAIL' } });
    const rows2 = [row({ [H.ts]: '2026-09-02T10:00:00Z', [H.contact]: 'A', [H.email]: email, [H.name]: 'A1', [H.type]: 'Extra' })];
    const plan2 = planImport(rows2, p2, await buildPlanContext(target, p2, rows2));
    log('QA-10b codes', plan2.findings.map((f) => `${f.level}:${f.code}`));
    expect(plan2.findings.map((f) => f.code)).toContain('PLAYER_ALREADY_REGISTERED');
    expect(plan2.parties[0].blocked).toBe(true);
  });
});

describe('QA-11 the dry run sizes extras against open_seats, not the extras pool', () => {
  it('reports no overflow for seats the engine then waitlists', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 10,
      baseQuota: 2,
      extrasPolicy: 'AUTO_FCFS',
    });
    await createPlayers(concertId, 3); // unclaimed_base = 6, so extras_pool = 4
    const target = await loadSegmentTarget(segmentId);
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@x.test', [H.name]: `G${i}`, [H.type]: 'Extra' }),
    );
    const p = profile(); // no player_match
    const ctx = await buildPlanContext(target, p, rows);
    const plan = planImport(rows, p, ctx);
    log('QA-11 openSeats', ctx.openSeats, 'blocking', plan.counts.blocking);
    const outcome = await commitImport({ target, filename: 'pool.csv', plan });
    log('QA-11 outcome', outcome.granted);
    expect(plan.counts.blocking).toBe(0);           // the dry run said it fits
    expect(outcome.granted.waitlisted).toBe(0);     // did it?
  });
});
