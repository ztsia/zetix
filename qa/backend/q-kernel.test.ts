import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  json,
  setSystemSetting,
} from '../../tests/helpers/fixtures';
import { deleteRegistration, removeAttendee } from '@/lib/registrations/mutations';
import { CommandInputError, previewCommand, startCommand } from '@/lib/commands/runner';
import type { AnyCommand } from '@/lib/commands/define';
import { TRASH_COMMANDS, trashCommandName } from '@/lib/trash/commands';
import type { TrashKind } from '@/lib/trash/queries';
import { listActivity } from '@/lib/activity/queries';
import { writeAuditLog } from '@/lib/audit';

/**
 * QA for module Q (independent reviewer). Criteria in
 * qa-artifacts/Q-platform-kernel/01-acceptance.md, written before reading src/.
 */

let concertId: number;
let otherConcertId: number;
let showId: number;
let segmentId: number;

const far = () => Date.now() + 60_000;
const command = (kind: TrashKind, mode: 'restore' | 'purge'): AnyCommand =>
  TRASH_COMMANDS.find((c) => c.name === trashCommandName(kind, mode))!;

async function run(kind: TrashKind, mode: 'restore' | 'purge', ids: number[], opts: { confirmPhrase?: string; concert?: number } = {}) {
  return startCommand(
    command(kind, mode),
    { concertId: opts.concert ?? concertId, selection: { ids }, confirmPhrase: opts.confirmPhrase },
    { actorId: null, deadline: far() },
  );
}

async function party(seg: number, n: number, name: string, type = 'COMP', playerId: number | null = null, show = showId) {
  const id = await createRegistration({ showId: show, segmentId: seg, contactName: name, playerId });
  await sql`
    select claim_seats(${seg}::bigint, ${id}::bigint,
      ${json(Array.from({ length: n }, (_, i) => ({ full_name: `${name} ${i + 1}`, allocation_type: type })))}::jsonb, false)`;
  return id;
}

const seats = (rid: number) =>
  sql<{ id: string; status: string; deleted_at: Date | null; qr_token: string | null; ticket_code: string | null }[]>`
    select id, status, deleted_at, qr_token, ticket_code from attendees where registration_id = ${rid} order by id`;

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Q-QA');
  otherConcertId = await createConcert('Other');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 4, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false });
  await setSystemSetting('admin.typed_confirm_above', 20);
});

describe('Restore re-decides seats without bypassing the engine (AC-22, allocation §7.3/§7.8)', () => {
  it('AC-22w: restoring a removed seat of a WAITLISTED party does not confirm it on its own', async () => {
    const filler = await party(segmentId, 4, 'Filler');
    const waiting = await party(segmentId, 2, 'Waiting');
    const before = await seats(waiting);
    expect(before.map((s) => s.status)).toEqual(['WAITLIST', 'WAITLIST']);

    // Room opens up (filler cancelled/deleted), the waiting party is NOT promoted by anyone.
    await deleteRegistration(filler);
    // Admin removes one waitlisted seat, then restores it from the Trash.
    await removeAttendee(Number(before[0].id));
    const report = await run('seat', 'restore', [Number(before[0].id)]);
    expect(report.status).toBe('COMPLETED');

    const after = await seats(waiting);
    // A restore must not jump the waitlist, and must not split the party.
    expect(after.map((s) => s.status)).toEqual(['WAITLIST', 'WAITLIST']);
  });

  it('AC-22r: restoring a removed EXTRA seat in a REVIEW segment does not bypass review', async () => {
    const playerSeg = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED', capacity: 50, baseQuota: 2, extrasPolicy: 'REVIEW', name: 'Players',
    });
    const [player] = await createPlayers(concertId, 1);
    const rid = await createRegistration({ showId, segmentId: playerSeg, playerId: player, contactName: 'Player Party' });
    await sql`select claim_seats(${playerSeg}::bigint, ${rid}::bigint,
      ${json([{ full_name: 'Extra One', allocation_type: 'EXTRA' }])}::jsonb, false)`;
    const [extra] = await seats(rid);
    expect(extra.status).toBe('PENDING_REVIEW');

    await removeAttendee(Number(extra.id));
    await run('seat', 'restore', [Number(extra.id)]);
    const [after] = await seats(rid);
    expect(after.status).toBe('PENDING_REVIEW');
  });

  it('AC-36: restore keeps qr_token and ticket_code (decision 28)', async () => {
    const id = await party(segmentId, 2, 'Tokens');
    await issueTickets(concertId, showId);
    const before = await seats(id);
    expect(before.every((s) => s.qr_token)).toBe(true);
    await deleteRegistration(id);
    await run('party', 'restore', [id]);
    const after = await seats(id);
    expect(after.map((s) => [s.qr_token, s.ticket_code, s.status])).toEqual(
      before.map((s) => [s.qr_token, s.ticket_code, 'CONFIRMED']),
    );
  });

  it('AC-41: restore does not resurrect withdrawn outbox rows', async () => {
    const id = await party(segmentId, 1, 'Mail');
    await sql`insert into email_outbox (registration_id, to_email, template_key, purpose, subject, body_md, status)
              values (${id}, 'm@example.test', 'tickets', 'TICKETS', 's', 'b', 'QUEUED')`;
    await deleteRegistration(id);
    await run('party', 'restore', [id]);
    const rows = await sql<{ status: string }[]>`select status from email_outbox where registration_id = ${id}`;
    expect(rows.map((r) => r.status)).toEqual(['CANCELLED']);
  });

  it('AC-16/cancelled party: a cancelled-then-deleted party restores cancelled with no seat confirmed', async () => {
    const id = await party(segmentId, 2, 'Cancelled');
    await sql`update attendees set status = 'CANCELLED' where registration_id = ${id}`;
    await sql`update registrations set status = 'CANCELLED' where id = ${id}`;
    await deleteRegistration(id);
    await run('party', 'restore', [id]);
    const after = await seats(id);
    expect(after.map((s) => s.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });
});

describe('Delete permanently refusals (AC-25..31)', () => {
  it('AC-29p: a party whose message is SENDING right now is refused, not cascaded away', async () => {
    const id = await party(segmentId, 1, 'Sending');
    await deleteRegistration(id);
    await sql`insert into email_outbox (registration_id, to_email, template_key, purpose, subject, body_md, status)
              values (${id}, 's@example.test', 'tickets', 'TICKETS', 's', 'b', 'SENDING')`;
    const report = await run('party', 'purge', [id]);
    expect(report.items[0].status).toBe('SKIPPED');
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from registrations where id = ${id}`;
    expect(n).toBe(1);
  });

  it('AC-29pl: a player whose invite is SENDING right now is refused', async () => {
    const [player] = await createPlayers(concertId, 1);
    await sql`insert into email_outbox (player_id, to_email, template_key, purpose, subject, body_md, status)
              values (${player}, 'p@example.test', 'player_invite', 'PLAYER_INVITE', 's', 'b', 'SENDING')`;
    await sql`update players set deleted_at = now() where id = ${player}`;
    const report = await run('player', 'purge', [player]);
    expect(report.items[0].status).toBe('SKIPPED');
  });

  it('AC-31: ids of another concert are not purged through this concert', async () => {
    const otherShow = await createShow(otherConcertId, 100);
    const otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 10, extrasPolicy: 'AUTO_FCFS' });
    const foreign = await party(otherSeg, 1, 'Foreign', 'COMP', null, otherShow);
    await deleteRegistration(foreign);
    const report = await run('party', 'purge', [foreign]);
    expect(report.items[0].status).toBe('SKIPPED');
    const restore = await run('party', 'restore', [foreign]);
    expect(restore.items[0].status).toBe('SKIPPED');
    const [{ n, d }] = await sql<{ n: number; d: Date | null }[]>`
      select count(*)::int as n, max(deleted_at) as d from registrations where id = ${foreign}`;
    expect(n).toBe(1);
    expect(d).not.toBeNull();
  });

  it('AC-8: re-running a purge is a no-op with no second audit row', async () => {
    const id = await party(segmentId, 1, 'Twice');
    await deleteRegistration(id);
    await run('party', 'purge', [id]);
    const again = await run('party', 'purge', [id]);
    expect(again).toMatchObject({ done: 0, skipped: 1 });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'registration.purged'`;
    expect(n).toBe(1);
  });

  it('§23.6 chain: purging a party keeps a response chain another party points into', async () => {
    const [form] = await sql<{ id: string }[]>`
      insert into registration_forms (segment_id, kind, title, slug, status)
      values (${segmentId}, 'PUBLIC', 'R1', 'r1', 'OPEN') returning id`;
    const [r1] = await sql<{ id: string }[]>`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${form.id}, '{"v":1}', '{"blocks":[]}', now()) returning id`;
    const [r2] = await sql<{ id: string }[]>`
      insert into form_responses (form_id, raw, form_schema, submitted_at, supersedes_id)
      values (${form.id}, '{"v":2}', '{"blocks":[]}', now(), ${r1.id}) returning id`;
    const x = await party(segmentId, 1, 'X');
    const y = await party(segmentId, 1, 'Y');
    // Both parties point into the same chain, at its head.
    await sql`update registrations set form_response_id = ${r2.id} where id in (${x}, ${y})`;
    await deleteRegistration(x);
    await run('party', 'purge', [x]);
    const rows = await sql<{ id: string; supersedes_id: string | null }[]>`
      select id, supersedes_id from form_responses order by id`;
    // Y's chain must be intact: r1 kept, and r2 still supersedes it.
    expect(rows).toEqual([
      { id: r1.id, supersedes_id: null },
      { id: r2.id, supersedes_id: r1.id },
    ]);
  });
});

describe('Typed confirmation (AC-14..18)', () => {
  it('AC-18: a wrong phrase is refused, nothing written, and the message does not claim the selection changed', async () => {
    await setSystemSetting('admin.typed_confirm_above', 1);
    const ids = [await party(segmentId, 1, 'A'), await party(segmentId, 1, 'B')];
    for (const id of ids) await deleteRegistration(id);
    const err = await run('party', 'purge', ids, { confirmPhrase: 'delete permanently 2 partys' }).catch((e) => e);
    expect(err).toBeInstanceOf(CommandInputError);
    const [{ runs }] = await sql<{ runs: number }[]>`select count(*)::int as runs from command_runs`;
    expect(runs).toBe(0);
    expect((await sql`select id from registrations where id = any(${ids})`).length).toBe(2);
    // Record the message verbatim for the report.
    console.log('WRONG-PHRASE MESSAGE:', (err as Error).message);
    expect((err as Error).message).not.toMatch(/now comes to/);
  });

  it('AC-15: threshold is read from settings (lowering it to 0 requires the phrase for 1 row)', async () => {
    await setSystemSetting('admin.typed_confirm_above', 0);
    const id = await party(segmentId, 1, 'One');
    await deleteRegistration(id);
    const preview = await previewCommand(command('party', 'purge'), { concertId, selection: { ids: [id] } }, null);
    expect(preview.confirmation).toMatchObject({ required: true, phrase: 'delete permanently 1 party', threshold: 0 });
  });

  it('AC-4: preview writes nothing', async () => {
    const id = await party(segmentId, 1, 'Preview');
    await deleteRegistration(id);
    const count = async () => (await sql<{ s: string }[]>`
      select (select count(*) from audit_log) || '/' || (select count(*) from command_runs) || '/' ||
             (select count(*) from command_run_items) || '/' || (select count(*) from registrations) as s`)[0].s;
    const before = await count();
    await previewCommand(command('party', 'purge'), { concertId, selection: { filter: { search: '' }, excludedIds: [] } }, null);
    await previewCommand(command('party', 'restore'), { concertId, selection: { ids: [id] } }, null);
    expect(await count()).toBe(before);
  });
});

describe('Hostile input at the runner boundary', () => {
  it.each([
    ['missing selection', { concertId: 1 }],
    ['string ids', { concertId: 1, selection: { ids: ['1'] } }],
    ['negative id', { concertId: 1, selection: { ids: [-1] } }],
    ['both shapes', { concertId: 1, selection: { ids: [1], filter: { search: '' }, excludedIds: [] } }],
    ['extra filter key (SQL)', { concertId: 1, selection: { filter: { search: '', "x'; drop table registrations;--": 1 }, excludedIds: [] } }],
    ['overlong search', { concertId: 1, selection: { filter: { search: 'x'.repeat(201) }, excludedIds: [] } }],
    ['concert 0', { concertId: 0, selection: { ids: [1] } }],
    ['reason too long', { concertId: 1, selection: { ids: [1] }, reason: 'r'.repeat(2001) }],
  ])('%s → CommandInputError, no run', async (_label, input) => {
    const err = await previewCommand(command('party', 'purge'), input as never, null).catch((e) => e);
    expect(err).toBeInstanceOf(CommandInputError);
    const err2 = await startCommand(command('party', 'purge'), input as never, { actorId: null, deadline: far() }).catch((e) => e);
    expect(err2).toBeInstanceOf(CommandInputError);
    const [{ runs }] = await sql<{ runs: number }[]>`select count(*)::int as runs from command_runs`;
    expect(runs).toBe(0);
  });

  it('search with SQL metacharacters is data, not SQL', async () => {
    const id = await party(segmentId, 1, "O'Brien %_ Family");
    await deleteRegistration(id);
    const preview = await previewCommand(
      command('party', 'purge'),
      { concertId, selection: { filter: { search: "O'Brien" }, excludedIds: [] } },
      null,
    );
    expect(preview.total).toBe(1);
  });
});

describe('Activity after a permanent delete (AC-24, AC-34, decision 46)', () => {
  it('AC-34: the purge row is still in the concert Activity', async () => {
    const id = await party(segmentId, 1, 'Gone');
    await deleteRegistration(id);
    await run('party', 'purge', [id]);
    const page = await listActivity(concertId, { view: null, search: '', runId: null, pageIndex: 0, pageSize: 50 });
    expect(page.rows.some((r) => r.action === 'registration.purged' && r.entityId === String(id))).toBe(true);
    const other = await listActivity(otherConcertId, { view: null, search: '', runId: null, pageIndex: 0, pageSize: 50 });
    expect(other.total).toBe(0);
  });

  it('AC-24b: after purging a player, the concert Activity no longer shows their email or name', async () => {
    const [player] = await createPlayers(concertId, 1);
    // Exactly what players/actions.ts writes on create and delete.
    await writeAuditLog({ action: 'player.created', entityType: 'player', entityId: player,
      after: { fullName: 'Player 1', email: 'player1@example.test' }, actorId: null });
    await sql`update players set deleted_at = now() where id = ${player}`;
    await writeAuditLog({ action: 'player.deleted', entityType: 'player', entityId: player,
      before: { fullName: 'Player 1' }, actorId: null });
    const report = await run('player', 'purge', [player]);
    expect(report.done).toBe(1);
    expect((await sql`select 1 from players where id = ${player}`).length).toBe(0);

    const page = await listActivity(concertId, { view: null, search: '', runId: null, pageIndex: 0, pageSize: 50 });
    const text = JSON.stringify(page.rows);
    console.log('ACTIVITY AFTER PURGE:', JSON.stringify(page.rows.map((r) => ({ action: r.action, before: r.before, after: r.after }))));
    expect(text).not.toMatch(/player1@example\.test/);
    expect(text).not.toMatch(/Player 1/);
  });
});
