import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow } from '../helpers/fixtures';
import { buildPlanContext, loadSegmentTarget, matchPlayers } from '@/lib/import/context';
import { commitImport, recordDryRun, registrationStatus } from '@/lib/import/commit';
import { planImport, type SheetRow } from '@/lib/import/plan';
import { parseMappingProfile } from '@/lib/import/profile';

/**
 * The commit path, against a real local Postgres (spec/platform.md §16.4).
 *
 * The planner is proven pure elsewhere; what is only provable here is that the
 * seats actually land, that they land **through `claim_seats()`** so the §7.2
 * counters stay true, and that the whole run is one transaction. The last of
 * those is not a detail: `claimSeats` defaults to the pooled client, the pool is
 * `max: 1`, and a commit that called it outside its own transaction would
 * deadlock against the connection that transaction is holding.
 */

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

/** A public segment with a capacity, granting extras immediately. */
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

describe('commitImport', () => {
  it('writes one registration per party and one attendee per seat', async () => {
    const { segmentId } = await publicSegment(100);
    const target = await loadSegmentTarget(segmentId);
    const at = '2026-09-01T10:00:00Z';

    const rows = [
      row({ [H.ts]: at, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Alice Tan', [H.type]: 'Extra' }),
      row({ [H.ts]: at, [H.contact]: 'Alice Tan', [H.email]: 'alice@example.com', [H.name]: 'Bob Tan', [H.type]: 'Extra' }),
      row({ [H.ts]: '2026-09-02T10:00:00Z', [H.contact]: 'Carol Lim', [H.email]: 'carol@example.com', [H.name]: 'Carol Lim', [H.type]: 'Extra' }),
    ];

    const p = profile({ player_match: null });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    const outcome = await commitImport({ target, filename: 'public.csv', plan });

    expect(outcome.createdRegistrations).toBe(2);
    expect(outcome.createdAttendees).toBe(3);
    expect(outcome.granted.extra).toBe(3);

    const [{ count: regs }] = await sql<{ count: string }[]>`
      select count(*) from registrations where segment_id = ${segmentId}
    `;
    const [{ count: seats }] = await sql<{ count: string }[]>`
      select count(*) from attendees where segment_id = ${segmentId} and status = 'CONFIRMED'
    `;
    expect(Number(regs)).toBe(2);
    expect(Number(seats)).toBe(3);
  });

  /**
   * §9.3: the ordering key is the form response timestamp, never import time.
   * Storing `now()` here would silently reorder the FCFS queue (§7.4).
   */
  it('stores the response timestamp as requested_at, not the time of import', async () => {
    const { segmentId } = await publicSegment(10);
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'Alice', [H.email]: 'a@example.com', [H.name]: 'Alice', [H.type]: 'Extra' }),
    ];

    const p = profile({ player_match: null });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    await commitImport({ target, filename: 'x.csv', plan });

    const [reg] = await sql<{ requested_at: Date; source: string }[]>`
      select requested_at, source from registrations where segment_id = ${segmentId}
    `;
    expect(new Date(reg.requested_at).toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(reg.source).toBe('IMPORT');
  });

  it('leaves an unnamed seat to the engine, which generates the placeholder', async () => {
    const { segmentId } = await publicSegment(10);
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'Alice Tan', [H.email]: 'a@example.com', [H.name]: '', [H.type]: 'Extra' }),
    ];

    const p = profile({ player_match: null });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    await commitImport({ target, filename: 'x.csv', plan });

    const [seat] = await sql<{ full_name: string; name_source: string }[]>`
      select full_name, name_source from attendees where segment_id = ${segmentId}
    `;
    expect(seat.full_name).toBe('Guest of Alice Tan');
    expect(seat.name_source).toBe('PLACEHOLDER');
  });

  /**
   * **A blocking finding stops the whole run**, even when only one party carries
   * it (§9.4, §9.6). Committing the rest is the silent under-issue decision 33
   * set out to remove: an unmatched player is a party that quietly gets no
   * tickets, and there is no rollback to notice it with afterwards.
   */
  it('refuses the whole run when any party is blocked', async () => {
    const { segmentId } = await publicSegment(10);
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'Good', [H.email]: 'g@example.com', [H.name]: 'Good', [H.type]: 'Extra' }),
      // BASE in a public segment: blocking (§9.5).
      row({ [H.ts]: '2026-09-02T10:00:00Z', [H.contact]: 'Bad', [H.email]: 'b@example.com', [H.name]: 'Bad', [H.type]: 'Allocated' }),
    ];

    const p = profile({ player_match: null });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    expect(plan.counts.blocking).toBeGreaterThan(0);

    await expect(commitImport({ target, filename: 'x.csv', plan })).rejects.toThrow(
      /blocking .* cannot be committed/,
    );

    // Nothing at all, not even the party that was fine.
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*) from registrations where segment_id = ${segmentId}
    `;
    expect(Number(count)).toBe(0);
  });

  /**
   * A file-level blocking finding is not a party that can be skipped — the whole
   * run stops, because committing "the rest of it" spends seats in an order
   * nobody previewed.
   */
  it('refuses to commit at all when a finding applies to the whole file', async () => {
    const { segmentId } = await publicSegment(1);
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@example.com', [H.name]: 'A', [H.type]: 'Extra' }),
      row({ [H.ts]: '2026-09-02T10:00:00Z', [H.contact]: 'B', [H.email]: 'b@example.com', [H.name]: 'B', [H.type]: 'Extra' }),
    ];

    const p = profile({ player_match: null });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    expect(plan.findings.some((f) => f.code === 'CAPACITY_EXCEEDED')).toBe(true);

    await expect(commitImport({ target, filename: 'x.csv', plan })).rejects.toThrow(
      /cannot be committed/,
    );
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from registrations`;
    expect(Number(count)).toBe(0);
  });

  it('records the batch and stamps it on the registrations it created', async () => {
    const { segmentId } = await publicSegment(10);
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@example.com', [H.name]: 'A', [H.type]: 'Extra' }),
    ];

    const p = profile({ player_match: null });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    const outcome = await commitImport({ target, filename: 'round1.csv', plan });

    const [batch] = await sql<{
      id: string; status: string; filename: string; row_count: number; created_count: number;
    }[]>`select id, status, filename, row_count, created_count from import_batches`;
    expect(batch.status).toBe('COMMITTED');
    expect(batch.filename).toBe('round1.csv');
    expect(Number(batch.created_count)).toBe(1);

    const [reg] = await sql<{ import_batch_id: string }[]>`
      select import_batch_id from registrations where segment_id = ${segmentId}
    `;
    expect(Number(reg.import_batch_id)).toBe(outcome.batchId);
    expect(Number(batch.id)).toBe(outcome.batchId);
  });

  /**
   * A pre-existing registration with a null batch id must not be adopted by this
   * run's batch — the report of a committed run is the only account of what it
   * did (§9.1).
   */
  it('does not adopt registrations it did not create', async () => {
    const { showId, segmentId } = await publicSegment(10);
    const target = await loadSegmentTarget(segmentId);
    await sql`
      insert into registrations (show_id, segment_id, source, contact_name, status, requested_at)
      values (${showId}, ${segmentId}, 'IMPORT', 'Older run', 'CONFIRMED', now())
    `;

    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@example.com', [H.name]: 'A', [H.type]: 'Extra' }),
    ];
    const p = profile({ player_match: null });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    await commitImport({ target, filename: 'x.csv', plan });

    const [older] = await sql<{ import_batch_id: string | null }[]>`
      select import_batch_id from registrations where contact_name = 'Older run'
    `;
    expect(older.import_batch_id).toBeNull();
  });

  it('records a dry run without writing a registration', async () => {
    const { segmentId } = await publicSegment(10);
    const target = await loadSegmentTarget(segmentId);
    const rows = [
      row({ [H.ts]: '2026-09-01T10:00:00Z', [H.contact]: 'A', [H.email]: 'a@example.com', [H.name]: 'A', [H.type]: 'Extra' }),
    ];

    const p = profile({ player_match: null });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    const batchId = await recordDryRun({ target, filename: 'x.csv', plan });

    const [batch] = await sql<{ status: string }[]>`
      select status from import_batches where id = ${batchId}
    `;
    expect(batch.status).toBe('DRY_RUN');
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from registrations`;
    expect(Number(count)).toBe(0);
  });
});

describe('the player-invited path', () => {
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

  it('matches players by email and grants their base seats', async () => {
    const { concertId, segmentId, playerIds } = await playerSegment(50, 2, 2);
    const target = await loadSegmentTarget(segmentId);
    const [email] = await sql<{ email: string }[]>`
      select email from players where id = ${playerIds[0]}
    `;

    const at = '2026-09-01T10:00:00Z';
    const rows = [
      row({ [H.ts]: at, [H.contact]: 'P1', [H.email]: email.email, [H.name]: 'Guest one', [H.type]: 'Allocated' }),
      row({ [H.ts]: at, [H.contact]: 'P1', [H.email]: email.email, [H.name]: 'Guest two', [H.type]: 'Allocated' }),
    ];
    const p = profile({ player_match: { column: H.email, strategy: 'EMAIL' } });
    const ctx = await buildPlanContext(target, p, rows);
    expect(ctx.baseQuota).toBe(2);

    const plan = planImport(rows, p, ctx);
    expect(plan.counts.blocking).toBe(0);

    const outcome = await commitImport({ target, filename: 'players.csv', plan });
    expect(outcome.granted.base).toBe(2);

    const [reg] = await sql<{ player_id: string }[]>`
      select player_id from registrations where segment_id = ${segmentId}
    `;
    expect(Number(reg.player_id)).toBe(playerIds[0]);
    expect(concertId).toBeGreaterThan(0);
  });

  /**
   * The surplus the engine would have waitlisted. §9.5 makes it import's job to
   * promote it, and this is the proof the promotion actually reaches the seats:
   * two BASE confirmed, one EXTRA held for review under `REVIEW`.
   */
  it('promotes base surplus to extra so the engine does not waitlist it', async () => {
    const { segmentId, playerIds } = await playerSegment(50, 2, 1);
    const target = await loadSegmentTarget(segmentId);
    const [{ email }] = await sql<{ email: string }[]>`
      select email from players where id = ${playerIds[0]}
    `;

    const at = '2026-09-01T10:00:00Z';
    const rows = [1, 2, 3].map((n) =>
      row({ [H.ts]: at, [H.contact]: 'P1', [H.email]: email, [H.name]: `Guest ${n}`, [H.type]: 'Allocated' }),
    );
    const p = profile({ player_match: { column: H.email, strategy: 'EMAIL' } });
    const plan = planImport(rows, p, await buildPlanContext(target, p, rows));
    expect(plan.counts.promotedToExtra).toBe(1);

    const outcome = await commitImport({ target, filename: 'players.csv', plan });
    expect(outcome.granted.base).toBe(2);
    // Under REVIEW an extras request holds rather than granting (§7.4).
    expect(outcome.granted.pending).toBe(1);

    const rowsOut = await sql<{ allocation_type: string; status: string }[]>`
      select allocation_type, status from attendees
       where segment_id = ${segmentId} order by id
    `;
    expect(rowsOut.map((r) => `${r.allocation_type}/${r.status}`)).toEqual([
      'BASE/CONFIRMED',
      'BASE/CONFIRMED',
      'EXTRA/PENDING_REVIEW',
    ]);
  });

  it('reports the registration as PENDING_REVIEW when nothing confirmed', async () => {
    expect(
      registrationStatus({
        granted_base: 0,
        granted_extra: 0,
        granted_other: 0,
        pending: 2,
        waitlisted: 0,
      }),
    ).toBe('PENDING_REVIEW');
    expect(
      registrationStatus({
        granted_base: 1,
        granted_extra: 0,
        granted_other: 0,
        pending: 1,
        waitlisted: 0,
      }),
    ).toBe('CONFIRMED');
  });
});

describe('matchPlayers', () => {
  /**
   * **More than one value, always.** The bug this exists for: the value list was
   * built as `values ($1, $2, $3)`, which is one row of three columns rather
   * than three rows. Postgres does not error — it names the first column
   * `needle` and discards the rest — so the query matched only the first value
   * in the file and every player after it blocked with PLAYER_NOT_MATCHED.
   *
   * Every other test here happened to use a single distinct value, which is the
   * one input under which the defect is invisible. So this one is deliberately
   * three, for each strategy.
   */
  it('matches every distinct value, not just the first', async () => {
    const concertId = await createConcert();
    const playerIds = await createPlayers(concertId, 3);
    const emails = await sql<{ email: string }[]>`
      select email from players where id = any(${playerIds}) order by id
    `;
    const needles = emails.map((e) => e.email);

    const matches = await matchPlayers(concertId, needles, 'EMAIL', 1);
    expect([...matches.keys()].sort()).toEqual([...needles].sort());
    expect(new Set([...matches.values()].map((m) => m!.playerId)).size).toBe(3);
  });

  it('matches every distinct value by name too', async () => {
    const concertId = await createConcert();
    await createPlayers(concertId, 3);
    const names = ['Player 1', 'Player 2', 'Player 3'];

    const matches = await matchPlayers(concertId, names, 'NAME', 1);
    expect([...matches.keys()].sort()).toEqual([...names].sort());
  });

  it('scores every distinct value under NAME_FUZZY', async () => {
    const concertId = await createConcert();
    await createPlayers(concertId, 3);

    const matches = await matchPlayers(concertId, ['Player 1', 'Player 2'], 'NAME_FUZZY', 0.5);
    expect(matches.size).toBe(2);
  });

  /**
   * The map is keyed by the trimmed cell value because that is what the planner
   * looks up. Lower-casing the key in the context builder instead produced a map
   * no lookup could ever hit.
   */
  it('keys the map by the value it was given, so the planner can find it', async () => {
    const concertId = await createConcert();
    const [playerId] = await createPlayers(concertId, 1);
    const [{ email }] = await sql<{ email: string }[]>`
      select email from players where id = ${playerId}
    `;
    const shouted = email.toUpperCase();

    const matches = await matchPlayers(concertId, [shouted], 'EMAIL', 1);
    expect(matches.has(shouted)).toBe(true);
  });

  it('matches email case-insensitively through citext', async () => {
    const concertId = await createConcert();
    const [playerId] = await createPlayers(concertId, 1);
    const [{ email }] = await sql<{ email: string }[]>`
      select email from players where id = ${playerId}
    `;

    const matches = await matchPlayers(concertId, [email.toUpperCase()], 'EMAIL', 1);
    expect(matches.get(email.toUpperCase())?.playerId).toBe(playerId);
  });

  it('flags a fuzzy match below the threshold for confirmation', async () => {
    const concertId = await createConcert();
    await sql`
      insert into players (concert_id, full_name, email, invite_token)
      values (${concertId}, 'Wolfgang Amadeus', 'w@example.com', 'tok-fuzzy-1')
    `;

    const matches = await matchPlayers(concertId, ['Wolfgng Amadeus'], 'NAME_FUZZY', 0.99);
    const m = matches.get('Wolfgng Amadeus');
    expect(m).toBeTruthy();
    expect(m!.needsConfirmation).toBe(true);
    expect(m!.confidence).toBeLessThan(0.99);
  });
});
