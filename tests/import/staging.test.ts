import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';
import { startCommand, previewCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { getDb } from '@/db/client';
import { applyEdit, stageBatch, validateBatch, type StagedFields } from '@/lib/import/staging';
import { loadSegmentTarget } from '@/lib/import/context';
import { parseMappingProfile } from '@/lib/import/profile';
import type { SheetRow } from '@/lib/import/plan';

/**
 * The import staging grid (spec/v3.md §25.7): stage, fix, commit ready parties
 * in passes, recognise a re-uploaded sheet, map a wide sheet, undo.
 */

let concertId: number;
let showId: number;
let publicSeg: number;
let playerSeg: number;

const far = () => Date.now() + 60_000;
const run = (name: string, selection: unknown) =>
  startCommand(getCommand(name)!, { concertId, selection, params: {} }, { actorId: null, deadline: far() });

const LONG = parseMappingProfile({
  columns: {
    requested_at: 'Timestamp',
    contact_name: 'Name',
    contact_email: 'Email',
    attendee_name: 'Guest',
  },
  default_allocation_type: 'EXTRA',
});

const line = (n: number, cells: Record<string, string>): SheetRow => ({ rowNumber: n, cells });

async function stage(segmentId: number, rows: SheetRow[], profile = LONG, queueReceipts = false) {
  const target = await loadSegmentTarget(segmentId);
  return stageBatch({ target, filename: 'responses.csv', profile, rows, uploadedBy: null, queueReceipts });
}

async function staged(batchId: number) {
  return sql<{ id: number; row_number: number; status: string; party_key: string; issues: { code: string; level: string }[]; normalized: StagedFields; existing_action: string | null }[]>`
    select id::int, row_number, status::text, party_key, issues, normalized, existing_action::text
      from import_rows where batch_id = ${batchId} order by row_number, seat_index
  `;
}

async function partiesIn(segmentId: number) {
  return sql<{ id: number; contact_email: string; approved: boolean; source: string; seats: string[] }[]>`
    select r.id::int, r.contact_email::text, r.approved_at is not null as approved, r.source::text,
           array(select a.full_name from attendees a where a.registration_id = r.id and a.deleted_at is null order by a.id) as seats
      from registrations r where r.segment_id = ${segmentId} and r.deleted_at is null order by r.id
  `;
}

beforeEach(async () => {
  await resetDb();
  await setSystemSetting('review.duplicate_name_similarity', 0.8);
  await setSystemSetting('import.fuzzy_match_threshold', 0.8);
  await setSystemSetting('admin.typed_confirm_above', 20);
  concertId = await createConcert('Import');
  showId = await createShow(concertId, 200);
  publicSeg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 100, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: true });
  playerSeg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 100, baseQuota: 2, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: true });
});

describe('staging', () => {
  it('lands one row per seat, grouped by contact email, with issues on the cell and nothing claimed', async () => {
    const { batchId } = await stage(publicSeg, [
      line(2, { Timestamp: '', Name: 'Alice Tan', Email: 'Alice@Example.test', Guest: 'Alice Tan' }),
      line(3, { Timestamp: '', Name: 'Alice Tan', Email: 'alice@example.test', Guest: 'Bob Tan' }),
      line(4, { Timestamp: '', Name: '', Email: 'carl@example.test', Guest: 'Carl Ng' }),
      line(5, { Timestamp: 'not a date', Name: 'Dee Ong', Email: 'dee@example..test', Guest: '' }),
    ]);
    const rows = await staged(batchId);
    expect(rows.map((r) => r.party_key)).toEqual([
      'e:alice@example.test',
      'e:alice@example.test',
      'e:carl@example.test',
      'e:dee@example..test',
    ]);
    expect(rows[2].issues.map((i) => i.code)).toContain('CONTACT_NAME_MISSING');
    expect(rows[3].issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['REQUESTED_AT_UNREADABLE', 'CONTACT_EMAIL_MALFORMED', 'PLACEHOLDER_NAME']),
    );
    expect(await partiesIn(publicSeg)).toEqual([]);
  });

  it('commits ready parties in file order, leaves blocked ones staged, and commits them once fixed', async () => {
    const { batchId } = await stage(publicSeg, [
      line(2, { Timestamp: '', Name: 'Alice Tan', Email: 'alice@example.test', Guest: 'Alice Tan' }),
      line(3, { Timestamp: '', Name: '', Email: 'carl@example.test', Guest: 'Carl Ng' }),
      line(4, { Timestamp: '', Name: 'Alice Tan', Email: 'alice@example.test', Guest: 'Bob Tan' }),
    ]);
    const first = await run('intake.commit_rows', { filter: { batchId }, excludedIds: [] });
    expect(first.done).toBe(1);

    const parties = await partiesIn(publicSeg);
    expect(parties).toMatchObject([{ contact_email: 'alice@example.test', approved: false, source: 'IMPORT', seats: ['Alice Tan', 'Bob Tan'] }]);
    const [link] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees where import_row_id is not null and registration_id = ${parties[0].id}
    `;
    expect(link.n).toBe(2);

    // Fix the blocked row, as the grid does.
    const [carl] = (await staged(batchId)).filter((r) => r.status === 'STAGED');
    await getDb().transaction(async (tx) => {
      const fields = applyEdit(carl.normalized, 'contactName', 'Carl Ng');
      await tx.execute(
        (await import('drizzle-orm')).sql`update import_rows set normalized = ${JSON.stringify(fields)}::jsonb where id = ${carl.id}`,
      );
      await validateBatch(tx, batchId);
    });
    const second = await run('intake.commit_rows', { filter: { batchId }, excludedIds: [] });
    expect(second.done).toBe(1);
    expect((await partiesIn(publicSeg)).map((p) => p.contact_email)).toEqual(['alice@example.test', 'carl@example.test']);
    const [batch] = await sql<{ status: string; created_count: number }[]>`
      select status::text, created_count from import_batches where id = ${batchId}
    `;
    expect(batch).toEqual({ status: 'COMMITTED', created_count: 3 });
  });

  it('recognises a re-uploaded cumulative sheet by email and seat names, adding only what is new', async () => {
    const round1 = await stage(publicSeg, [
      line(2, { Timestamp: '', Name: 'Alice Tan', Email: 'alice@example.test', Guest: 'Alice Tan' }),
    ]);
    await run('intake.commit_rows', { filter: { batchId: round1.batchId }, excludedIds: [] });

    const round2 = await stage(publicSeg, [
      line(2, { Timestamp: '', Name: 'Alice Tan', Email: 'alice@example.test', Guest: 'Alice Tan' }),
      line(3, { Timestamp: '', Name: 'Alice Tan', Email: 'alice@example.test', Guest: 'Bob Tan' }),
    ]);
    const rows = await staged(round2.batchId);
    expect(rows[0].issues.map((i) => i.code)).toEqual(expect.arrayContaining(['EXISTING_PARTY', 'ALREADY_IMPORTED']));
    expect(rows[0].existing_action).toBe('ADD_SEATS');

    const report = await run('intake.commit_rows', { filter: { batchId: round2.batchId }, excludedIds: [] });
    expect(report.done).toBe(1);
    const parties = await partiesIn(publicSeg);
    expect(parties).toHaveLength(1);
    expect(parties[0].seats).toEqual(['Alice Tan', 'Bob Tan']);
    const statuses = (await staged(round2.batchId)).map((r) => r.status);
    expect(statuses).toEqual(['SKIPPED', 'COMMITTED']);
  });

  it('keeps a matched party separate, or skips it, when the admin says so', async () => {
    const round1 = await stage(publicSeg, [line(2, { Timestamp: '', Name: 'Alice', Email: 'a@example.test', Guest: 'A1' })]);
    await run('intake.commit_rows', { filter: { batchId: round1.batchId }, excludedIds: [] });

    const round2 = await stage(publicSeg, [
      line(2, { Timestamp: '', Name: 'Alice', Email: 'a@example.test', Guest: 'A2' }),
    ]);
    await sql`update import_rows set existing_action = 'SEPARATE' where batch_id = ${round2.batchId}`;
    await run('intake.commit_rows', { filter: { batchId: round2.batchId }, excludedIds: [] });
    expect(await partiesIn(publicSeg)).toHaveLength(2);

    const round3 = await stage(publicSeg, [line(2, { Timestamp: '', Name: 'Alice', Email: 'a@example.test', Guest: 'A3' })]);
    await sql`update import_rows set existing_action = 'SKIP' where batch_id = ${round3.batchId}`;
    await run('intake.commit_rows', { filter: { batchId: round3.batchId }, excludedIds: [] });
    expect(await partiesIn(publicSeg)).toHaveLength(2);
    expect((await staged(round3.batchId))[0].status).toBe('SKIPPED');
  });

  it('maps a wide sheet: the contact as a seat plus each filled guest group, previewed as rows', async () => {
    const wide = parseMappingProfile({
      columns: { requested_at: null, contact_name: 'Name', contact_email: 'Email' },
      seat_groups: [
        { attendee_name: 'Guest 1 Name', attendee_email: 'Guest 1 Email' },
        { attendee_name: 'Guest 2 Name' },
        { attendee_name: 'Guest 3 Name' },
      ],
      registrant_seat: true,
      default_allocation_type: 'EXTRA',
    });
    const { batchId } = await stage(
      publicSeg,
      [line(2, { Name: 'Alice', Email: 'a@example.test', 'Guest 1 Name': 'Bea', 'Guest 1 Email': 'bea@example.test', 'Guest 2 Name': 'Cy', 'Guest 3 Name': '' })],
      wide,
    );
    const rows = await staged(batchId);
    expect(rows.map((r) => r.normalized.attendeeName)).toEqual(['Alice', 'Bea', 'Cy']);
    await run('intake.commit_rows', { filter: { batchId }, excludedIds: [] });
    expect((await partiesIn(publicSeg))[0].seats).toEqual(['Alice', 'Bea', 'Cy']);
  });

  it('blocks an unmatched player, and requests base past the quota as extra', async () => {
    await createPlayers(concertId, 1); // "Player 1"
    const profile = parseMappingProfile({
      columns: { requested_at: null, contact_name: 'Name', contact_email: 'Email', attendee_name: 'Guest' },
      player_match: { column: 'Player', strategy: 'NAME' },
      default_allocation_type: 'BASE',
    });
    const { batchId } = await stage(
      playerSeg,
      [
        line(2, { Name: 'Mum', Email: 'mum@example.test', Guest: 'G1', Player: 'Player 1' }),
        line(3, { Name: 'Mum', Email: 'mum@example.test', Guest: 'G2', Player: 'Player 1' }),
        line(4, { Name: 'Mum', Email: 'mum@example.test', Guest: 'G3', Player: 'Player 1' }),
        line(5, { Name: 'Nobody', Email: 'no@example.test', Guest: 'N1', Player: 'Unknown Person' }),
      ],
      profile,
    );
    const rows = await staged(batchId);
    expect(rows[3].issues.map((i) => i.code)).toContain('PLAYER_NOT_MATCHED');

    const report = await run('intake.commit_rows', { filter: { batchId }, excludedIds: [] });
    expect(report.done).toBe(1);
    const types = await sql<{ allocation_type: string; status: string }[]>`
      select allocation_type::text, status::text from attendees where segment_id = ${playerSeg} order by id
    `;
    expect(types.map((t) => t.allocation_type)).toEqual(['BASE', 'BASE', 'EXTRA']);
  });

  it('undoes a batch: its parties to the Trash, seats it added to other parties removed', async () => {
    const round1 = await stage(publicSeg, [line(2, { Timestamp: '', Name: 'Alice', Email: 'a@example.test', Guest: 'A1' })]);
    await run('intake.commit_rows', { filter: { batchId: round1.batchId }, excludedIds: [] });
    const round2 = await stage(publicSeg, [
      line(2, { Timestamp: '', Name: 'Alice', Email: 'a@example.test', Guest: 'A2' }),
      line(3, { Timestamp: '', Name: 'Bo', Email: 'b@example.test', Guest: 'B1' }),
    ]);
    await run('intake.commit_rows', { filter: { batchId: round2.batchId }, excludedIds: [] });
    expect((await partiesIn(publicSeg)).map((p) => p.seats)).toEqual([['A1', 'A2'], ['B1']]);

    const preview = await previewCommand(
      getCommand('intake.undo_import')!,
      { concertId, selection: { ids: [round2.batchId] }, params: {} },
      null,
    );
    expect(preview.rows[0].skip).toBeNull();
    const report = await run('intake.undo_import', { ids: [round2.batchId] });
    expect(report.done).toBe(1);
    expect((await partiesIn(publicSeg)).map((p) => p.seats)).toEqual([['A1']]);
    const [batch] = await sql<{ status: string }[]>`select status::text from import_batches where id = ${round2.batchId}`;
    expect(batch.status).toBe('UNDONE');
  });

  it('queues receipts only when the batch asks for them', async () => {
    const { batchId } = await stage(publicSeg, [line(2, { Timestamp: '', Name: 'Alice', Email: 'a@example.test', Guest: 'A1' })], LONG, true);
    await run('intake.commit_rows', { filter: { batchId }, excludedIds: [] });
    const [receipt] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where purpose = 'RECEIPT'`;
    expect(receipt.n).toBe(1);
  });
});
