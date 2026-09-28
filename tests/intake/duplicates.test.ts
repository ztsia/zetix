import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow, issueTickets, setSystemSetting } from '../helpers/fixtures';
import { previewCommand, startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { createRegistration } from '@/lib/registrations/mutations';
import { loadPartyRecord } from '@/lib/audience/record';

/**
 * Merge parties, Not a duplicate and Undo merge (spec/v3.md §25.5, §23.2),
 * through the real runner against local Postgres.
 */

let concertId: number;
let showId: number;
let publicSeg: number;
let playerSeg: number;

const far = () => Date.now() + 60_000;

async function run(name: string, ids: number[], params: unknown = {}) {
  return startCommand(
    getCommand(name)!,
    { concertId, selection: { ids }, params },
    { actorId: null, deadline: far() },
  );
}

async function party(segmentId: number, name: string, email: string, seatNames: string[], playerId?: number) {
  const { registrationId } = await createRegistration({
    segmentId,
    contactName: name,
    contactEmail: email,
    playerId: playerId ?? null,
    seats: seatNames.map((fullName) => ({
      fullName,
      allocationType: segmentId === playerSeg && playerId ? ('BASE' as const) : ('EXTRA' as const),
    })),
  });
  return registrationId;
}

async function candidate(a: number, b: number): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    select id::int from duplicate_candidates
     where registration_a_id = ${Math.min(a, b)} and registration_b_id = ${Math.max(a, b)}
  `;
  return row.id;
}

async function seatsOf(registrationId: number) {
  return sql<{ id: number; full_name: string; qr_token: string | null; segment_id: number }[]>`
    select id::int, full_name, qr_token, segment_id::int from attendees
     where registration_id = ${registrationId} and deleted_at is null and status <> 'CANCELLED'
     order by id
  `;
}

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Dupes');
  showId = await createShow(concertId, 100);
  publicSeg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 40, extrasPolicy: 'AUTO_FCFS' });
  playerSeg = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 40,
    baseQuota: 2,
    extrasPolicy: 'AUTO_FCFS',
  });
  await setSystemSetting('review.duplicate_name_similarity', 0.8);
  await setSystemSetting('admin.typed_confirm_above', 20);
});

describe('Merge parties', () => {
  it('moves the later party into the earlier one, keeping tickets and each seat’s request time', async () => {
    const first = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Alice Tan', 'Bob Tan']);
    const second = await party(publicSeg, 'Alice Tan', 'ALICE@example.test', ['Cara Tan']);
    await issueTickets(concertId, showId);
    const [secondSeat] = await seatsOf(second);
    const pair = await candidate(first, second);

    const preview = await previewCommand(getCommand('intake.merge')!, { concertId, selection: { ids: [pair] }, params: {} }, null);
    expect(preview.rows[0].skip).toBeNull();

    const report = await run('intake.merge', [pair]);
    expect(report.done).toBe(1);

    const merged = await seatsOf(first);
    expect(merged.map((s) => s.full_name)).toEqual(['Alice Tan', 'Bob Tan', 'Cara Tan']);
    // The QR travels with the seat: a ticket already sent still admits.
    expect(merged[2].qr_token).toBe(secondSeat.qr_token);

    const [gone] = await sql<{ deleted: boolean; merged_into_id: number }[]>`
      select deleted_at is not null as deleted, merged_into_id::int from registrations where id = ${second}
    `;
    expect(gone).toEqual({ deleted: true, merged_into_id: first });
    const [row] = await sql<{ status: string }[]>`select status::text from duplicate_candidates where id = ${pair}`;
    expect(row.status).toBe('MERGED');

    const [flags] = await sql<{ flag_possible_duplicate: boolean }[]>`
      select flag_possible_duplicate from party_pipeline where registration_id = ${first}
    `;
    expect(flags.flag_possible_duplicate).toBe(false);
  });

  it('moves a party across segments through the move path, and undoes it back', async () => {
    const [player] = await createPlayers(concertId, 1);
    const inPublic = await party(publicSeg, 'Mum Lee', 'mum@example.test', ['Mum Lee']);
    const inPlayer = await party(playerSeg, 'Mum Lee', 'mum@example.test', ['Aunt May'], player);
    const pair = await candidate(inPublic, inPlayer);

    // Keep the player's party; the public one joins its segment.
    const keep = inPlayer > inPublic ? 'B' : 'A';
    await run('intake.merge', [pair], { keep });
    const merged = await seatsOf(inPlayer);
    expect(merged.map((s) => s.segment_id)).toEqual([playerSeg, playerSeg]);

    const report = await run('intake.undo_merge', [pair]);
    expect(report.done).toBe(1);
    expect((await seatsOf(inPublic)).map((s) => [s.full_name, s.segment_id])).toEqual([['Mum Lee', publicSeg]]);
    expect((await seatsOf(inPlayer)).map((s) => s.full_name)).toEqual(['Aunt May']);
    const [back] = await sql<{ deleted: boolean; segment_id: number }[]>`
      select deleted_at is not null as deleted, segment_id::int from registrations where id = ${inPublic}
    `;
    expect(back).toEqual({ deleted: false, segment_id: publicSeg });
    const [row] = await sql<{ status: string }[]>`select status::text from duplicate_candidates where id = ${pair}`;
    expect(row.status).toBe('DISMISSED');
  });

  it("refuses a merge that would put a player past their base quota, unless overridden", async () => {
    const [p1, p2] = await createPlayers(concertId, 2);
    const a = await party(playerSeg, 'Sam Ong', 'sam@example.test', ['Sam Ong', 'Tim Ong'], p1);
    const b = await party(playerSeg, 'Sam Ong', 'sam@example.test', ['Uma Ong'], p2);
    const pair = await candidate(a, b);

    const refused = await run('intake.merge', [pair]);
    expect(refused.skipped).toBe(1);
    expect(await seatsOf(b)).toHaveLength(1);

    const forced = await run('intake.merge', [pair], { override: true });
    expect(forced.done).toBe(1);
    expect(await seatsOf(a)).toHaveLength(3);
  });

  it('withdraws the absorbed party’s pending messages', async () => {
    const first = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Alice Tan']);
    const second = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Bob Tan']);
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
      values (${second}, 'TICKETS', 'public_ticket', 'alice@example.test', 's', 'b', 'DRAFT')
    `;
    await run('intake.merge', [await candidate(first, second)]);
    const [message] = await sql<{ status: string }[]>`
      select status::text from email_outbox where registration_id = ${second}
    `;
    expect(message.status).toBe('CANCELLED');
  });
});

describe('Not a duplicate', () => {
  it('dismisses the pair, clears the flag, and the dismissal survives detection running again', async () => {
    const first = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Alice Tan']);
    const second = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Bob Tan']);
    const pair = await candidate(first, second);

    await run('intake.not_duplicate', [pair]);
    await sql`select refresh_duplicate_candidates(${second})`;

    const [row] = await sql<{ status: string }[]>`select status::text from duplicate_candidates where id = ${pair}`;
    expect(row.status).toBe('DISMISSED');
    const flags = await sql<{ flag_possible_duplicate: boolean }[]>`
      select flag_possible_duplicate from party_pipeline where registration_id in (${first}, ${second})
    `;
    expect(flags.every((f) => !f.flag_possible_duplicate)).toBe(true);
  });
});

describe('Delete permanently after a merge', () => {
  it('refuses to purge a party others were merged into', async () => {
    const first = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Alice Tan']);
    const second = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Bob Tan']);
    await run('intake.merge', [await candidate(first, second)]);
    await sql`update registrations set deleted_at = now() where id = ${first}`;

    const preview = await previewCommand(
      getCommand('trash.purge.party')!,
      { concertId, selection: { ids: [first] }, params: {} },
      null,
    );
    expect(preview.rows[0].skip).toMatch(/merged into this one/);
  });
});

describe('the party record', () => {
  it('lists open pairs on both parties, and a merge only on the survivor until it is undone', async () => {
    const first = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Alice Tan']);
    const second = await party(publicSeg, 'Alice Tan', 'alice@example.test', ['Bob Tan']);
    const pair = await candidate(first, second);

    const a = await loadPartyRecord(concertId, first);
    const b = await loadPartyRecord(concertId, second);
    expect(a!.duplicates).toMatchObject([{ candidateId: pair, status: 'OPEN', thisIsA: true, other: { id: second } }]);
    expect(b!.duplicates).toMatchObject([{ candidateId: pair, status: 'OPEN', thisIsA: false, other: { id: first } }]);

    await run('intake.merge', [pair]);
    expect((await loadPartyRecord(concertId, first))!.duplicates).toMatchObject([{ status: 'MERGED', other: { id: second } }]);

    await run('intake.undo_merge', [pair]);
    expect((await loadPartyRecord(concertId, first))!.duplicates).toEqual([]);
  });
});

describe("merge against the player's own quota (QA)", () => {
  it('reads the base_quota_override, and marks the seats the override was needed for', async () => {
    const [p1, p2] = await createPlayers(concertId, 2);
    await sql`insert into player_allocations (player_id, segment_id, base_quota_override) values (${p1}, ${playerSeg}, 1)`;
    const a = await party(playerSeg, 'Sam Ong', 'sam@example.test', ['Sam Ong'], p1);
    const b = await party(playerSeg, 'Sam Ong', 'sam@example.test', ['Uma Ong'], p2);
    const pair = await candidate(a, b);

    expect((await run('intake.merge', [pair])).skipped).toBe(1);
    expect((await run('intake.merge', [pair], { override: true })).done).toBe(1);
    const marks = await sql<{ full_name: string; over: boolean }[]>`
      select full_name, over_capacity_at is not null as over from attendees where registration_id = ${a} order by id
    `;
    expect(marks).toEqual([
      { full_name: 'Sam Ong', over: false },
      { full_name: 'Uma Ong', over: true },
    ]);
  });
});
