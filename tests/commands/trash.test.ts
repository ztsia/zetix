import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  json,
  setSystemSetting,
} from '../helpers/fixtures';
import { deleteRegistration, removeAttendee } from '@/lib/registrations/mutations';
import { previewCommand, startCommand } from '@/lib/commands/runner';
import type { AnyCommand } from '@/lib/commands/define';
import { TRASH_COMMANDS, trashCommandName } from '@/lib/trash/commands';
import { listTrash, type TrashKind } from '@/lib/trash/queries';

/**
 * The Trash — spec/v3.md §23.6, §23.3, §23.4; decision 46.
 *
 * Deletion stays soft and lands here; Restore brings a row back without
 * bypassing the seat engine; Delete permanently is a real `DELETE` whose blast
 * radius is counted from real data and which refuses where a cascade would
 * damage something outside the Trash.
 */

let concertId: number;
let showId: number;
let segmentId: number;

const far = () => Date.now() + 60_000;

function command(kind: TrashKind, mode: 'restore' | 'purge'): AnyCommand {
  return TRASH_COMMANDS.find((c) => c.name === trashCommandName(kind, mode))!;
}

async function run(kind: TrashKind, mode: 'restore' | 'purge', ids: number[], confirmPhrase?: string) {
  return startCommand(
    command(kind, mode),
    { concertId, selection: { ids }, confirmPhrase },
    { actorId: null, deadline: far() },
  );
}

/** A party of `n` seats granted by the engine, the way every real party is. */
async function party(n: number, name = 'Tan Family'): Promise<number> {
  const id = await createRegistration({ showId, segmentId, contactName: name });
  await sql`
    select claim_seats(${segmentId}::bigint, ${id}::bigint,
      ${json(Array.from({ length: n }, (_, i) => ({ full_name: `${name} ${i + 1}`, allocation_type: 'COMP' })))}::jsonb,
      false)
  `;
  return id;
}

async function seats(registrationId: number) {
  return sql<{ id: string; status: string; deleted_at: Date | null }[]>`
    select id, status, deleted_at from attendees where registration_id = ${registrationId} order by id
  `;
}

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Trash');
  showId = await createShow(concertId, 10);
  segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: 4,
    extrasPolicy: 'AUTO_FCFS',
    allowPartialGrant: false,
  });
  await setSystemSetting('admin.typed_confirm_above', 20);
});

describe('what the Trash lists', () => {
  it('lists a deleted party, and not its seats separately', async () => {
    const id = await party(2);
    await deleteRegistration(id);

    const trash = await listTrash(concertId, 'party', { search: '', pageIndex: 0, pageSize: 25 });
    expect(trash.rows.map((row) => row.id)).toEqual([id]);
    expect(trash.counts).toMatchObject({ party: 1, seat: 0 });
  });

  it('lists a seat removed on its own from a live party', async () => {
    const id = await party(2);
    const [first] = await seats(id);
    await removeAttendee(Number(first.id));

    const trash = await listTrash(concertId, 'seat', { search: '', pageIndex: 0, pageSize: 25 });
    expect(trash.rows.map((row) => row.id)).toEqual([Number(first.id)]);
  });

  it('never lists another concert’s rows', async () => {
    const otherConcert = await createConcert('Other');
    const [player] = await createPlayers(otherConcert, 1);
    await sql`update players set deleted_at = now() where id = ${player}`;
    const trash = await listTrash(concertId, 'player', { search: '', pageIndex: 0, pageSize: 25 });
    expect(trash.total).toBe(0);
  });
});

describe('Restore', () => {
  it('brings a party back with its seats confirmed when they still fit', async () => {
    const id = await party(2);
    await deleteRegistration(id);

    const report = await run('party', 'restore', [id]);
    expect(report).toMatchObject({ status: 'COMPLETED', done: 1 });
    expect(report.items[0].outcome).toMatchObject({ seats: 2, confirmed: 2, waitlisted: 0 });

    const after = await seats(id);
    expect(after.every((seat) => seat.status === 'CONFIRMED' && seat.deleted_at === null)).toBe(true);
    const [registration] = await sql<{ deleted_at: Date | null; status: string }[]>`
      select deleted_at, status from registrations where id = ${id}
    `;
    expect(registration).toEqual({ deleted_at: null, status: 'CONFIRMED' });
  });

  it('never bypasses capacity: if the room was given away, the seats come back waitlisted', async () => {
    const id = await party(3);
    await deleteRegistration(id);
    await party(2, 'Lim Family'); // takes the segment to 2 of 4

    const preview = await previewCommand(command('party', 'restore'), { concertId, selection: { ids: [id] } }, null);
    expect(preview.blastRadius[0]).toMatchObject({ count: 3, tone: 'warning' });

    const report = await run('party', 'restore', [id]);
    expect(report.items[0].outcome).toMatchObject({ confirmed: 0, waitlisted: 3 });
    expect((report.items[0].outcome as { refused: string }).refused).toMatch(/over/);

    const [{ confirmed }] = await sql<{ confirmed: number }[]>`
      select count(*)::int as confirmed from attendees
       where segment_id = ${segmentId} and status = 'CONFIRMED' and deleted_at is null
    `;
    expect(confirmed).toBe(2);
    expect((await seats(id)).every((seat) => seat.status === 'WAITLIST')).toBe(true);
  });

  it('keeps a seat removed earlier in the Trash when its party is restored', async () => {
    const id = await party(2);
    const [first] = await seats(id);
    await removeAttendee(Number(first.id));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await deleteRegistration(id);

    await run('party', 'restore', [id]);
    const after = await seats(id);
    expect(after[0].deleted_at).not.toBeNull();
    expect(after[1]).toMatchObject({ status: 'CONFIRMED', deleted_at: null });
  });

  it('restores a single seat through the engine', async () => {
    const id = await party(2);
    const [first] = await seats(id);
    await removeAttendee(Number(first.id));

    const report = await run('seat', 'restore', [Number(first.id)]);
    expect(report.items[0].outcome).toMatchObject({ confirmed: 1 });
    expect((await seats(id))[0]).toMatchObject({ status: 'CONFIRMED', deleted_at: null });
  });

  it('skips a seat whose party is cancelled, and says what to do instead', async () => {
    const id = await party(2);
    const [first] = await seats(id);
    await removeAttendee(Number(first.id));
    await sql`update registrations set status = 'CANCELLED' where id = ${id}`;

    const report = await run('seat', 'restore', [Number(first.id)]);
    expect(report.items[0]).toMatchObject({
      status: 'SKIPPED',
      outcome: { reason: 'Its party is cancelled. Restore the party first.' },
    });
  });

  it('is idempotent: restoring again does nothing', async () => {
    const id = await party(1);
    await deleteRegistration(id);
    await run('party', 'restore', [id]);
    const again = await run('party', 'restore', [id]);
    expect(again).toMatchObject({ done: 0, skipped: 1 });
  });

  it('writes an audit row scoped to the concert and the run', async () => {
    const id = await party(1);
    await deleteRegistration(id);
    const report = await run('party', 'restore', [id]);

    const [row] = await sql<{ concert_id: string; command_run_id: string; action: string }[]>`
      select concert_id, command_run_id, action from audit_log where action = 'registration.restored'
    `;
    expect(row).toEqual({
      concert_id: String(concertId),
      command_run_id: String(report.id),
      action: 'registration.restored',
    });
  });
});

describe('Delete permanently', () => {
  it('deletes the party and everything that hangs off it, and nothing else', async () => {
    const keep = await party(1, 'Keep');
    const id = await party(2);
    const [form] = await sql<{ id: string }[]>`
      insert into registration_forms (segment_id, kind, title, slug, status)
      values (${segmentId}, 'PUBLIC', 'Round 1', 'round-1', 'OPEN') returning id
    `;
    const [original] = await sql<{ id: string }[]>`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${form.id}, '{"name":"Tan"}', '{"blocks":[]}', now()) returning id
    `;
    const [edit] = await sql<{ id: string }[]>`
      insert into form_responses (form_id, raw, form_schema, submitted_at, supersedes_id)
      values (${form.id}, '{"name":"Tan B"}', '{"blocks":[]}', now(), ${original.id}) returning id
    `;
    await sql`update registrations set form_response_id = ${edit.id} where id = ${id}`;
    await sql`
      insert into email_outbox (registration_id, to_email, template_key, purpose, subject, body_md, status)
      values (${id}, 'tan@example.com', 'tickets', 'TICKETS', 's', 'b', 'SENT')
    `;
    await deleteRegistration(id);

    const report = await run('party', 'purge', [id]);
    expect(report).toMatchObject({ status: 'COMPLETED', done: 1 });

    const [counts] = await sql<{ r: number; a: number; o: number; f: number; kept: number }[]>`
      select (select count(*)::int from registrations where id = ${id}) as r,
             (select count(*)::int from attendees where registration_id = ${id}) as a,
             (select count(*)::int from email_outbox where registration_id = ${id}) as o,
             (select count(*)::int from form_responses) as f,
             (select count(*)::int from attendees where registration_id = ${keep}) as kept
    `;
    expect(counts).toEqual({ r: 0, a: 0, o: 0, f: 0, kept: 1 });
  });

  it('only acts on rows in the Trash', async () => {
    const live = await party(1);
    const report = await run('party', 'purge', [live]);
    expect(report.items[0]).toMatchObject({
      status: 'SKIPPED',
      outcome: { reason: 'No longer exists in this concert.' },
    });
    expect(await seats(live)).toHaveLength(1);
  });

  it('refuses a party with a guest admitted at the door, but not one whose check-in was reverted', async () => {
    const admitted = await party(1, 'Admitted');
    const reverted = await party(1, 'Reverted');
    for (const [id, revertedAt] of [[admitted, null], [reverted, new Date().toISOString()]] as const) {
      const [seat] = await seats(id);
      await sql`
        insert into check_ins (attendee_id, show_id, scanned_at, source, reverted_at)
        values (${seat.id}, ${showId}, now(), 'MANUAL', ${revertedAt})
      `;
    }
    // deleteRegistration refuses an admitted party, so soft-delete it directly.
    await sql`update registrations set deleted_at = now() where id in (${admitted}, ${reverted})`;

    const preview = await previewCommand(
      command('party', 'purge'),
      { concertId, selection: { ids: [admitted, reverted] } },
      null,
    );
    expect(preview.runnable).toBe(1);
    expect(preview.skipped[0].reason).toMatch(/admitted at the door/);
    expect(preview.blastRadius).toContainEqual(
      expect.objectContaining({ count: 1, text: expect.stringMatching(/reverted check-ins/) }),
    );

    const report = await run('party', 'purge', [admitted, reverted]);
    expect(report).toMatchObject({ done: 1, skipped: 1 });
    expect(await seats(admitted)).toHaveLength(1);
  });

  it('counts delivered tickets in the blast radius', async () => {
    const id = await party(2);
    await issueTickets(concertId, showId);
    await sql`update attendees set ticket_sent_at = now() where registration_id = ${id}`;
    await deleteRegistration(id);

    const preview = await previewCommand(command('party', 'purge'), { concertId, selection: { ids: [id] } }, null);
    expect(preview.blastRadius).toContainEqual({
      count: 2,
      text: 'tickets already delivered. Their QR codes will never resolve at the door again.',
      tone: 'danger',
    });
  });

  it('asks for the typed phrase above the threshold', async () => {
    await setSystemSetting('admin.typed_confirm_above', 1);
    const ids = [await party(1, 'A'), await party(1, 'B')];
    for (const id of ids) await deleteRegistration(id);

    await expect(run('party', 'purge', ids)).rejects.toThrow('Type "delete permanently 2 parties" to confirm.');
    const report = await run('party', 'purge', ids, 'delete permanently 2 parties');
    expect(report.done).toBe(2);
  });

  it('keeps personal data out of the audit row it leaves', async () => {
    const id = await party(1, 'Very Private Person');
    await deleteRegistration(id);
    await run('party', 'purge', [id]);

    const rows = await sql<{ row: string }[]>`
      select row_to_json(l)::text as row from audit_log l where action = 'registration.purged'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].row).not.toMatch(/Very Private Person|reg@example\.test/);
    const items = await sql<{ outcome: string }[]>`select outcome::text from command_run_items`;
    expect(items[0].outcome).not.toMatch(/Very Private Person/);
  });

  it('refuses a ticket design any ticket is pinned to', async () => {
    await party(1);
    await issueTickets(concertId, showId);
    const [template] = await sql<{ id: string }[]>`select id from ticket_templates`;
    await sql`update ticket_templates set deleted_at = now() where id = ${template.id}`;

    const report = await run('ticket_template', 'purge', [Number(template.id)]);
    expect(report.items[0]).toMatchObject({ status: 'SKIPPED' });
    expect((report.items[0].outcome as { reason: string }).reason).toMatch(/pinned/);
  });

  it('refuses a player a live party is linked to', async () => {
    const [player] = await createPlayers(concertId, 1);
    await createRegistration({ showId, segmentId, playerId: player });
    await sql`update players set deleted_at = now() where id = ${player}`;

    const report = await run('player', 'purge', [player]);
    expect((report.items[0].outcome as { reason: string }).reason).toMatch(/1 live party is linked/);
  });

  it('refuses a form a live party registered through, and allows it once that party is gone', async () => {
    const id = await party(1);
    const [form] = await sql<{ id: string }[]>`
      insert into registration_forms (segment_id, kind, title, slug, status, deleted_at)
      values (${segmentId}, 'PUBLIC', 'Round 1', 'round-1', 'CLOSED', now()) returning id
    `;
    const [response] = await sql<{ id: string }[]>`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${form.id}, '{}', '{"blocks":[]}', now()) returning id
    `;
    await sql`update registrations set form_response_id = ${response.id} where id = ${id}`;

    const blocked = await run('form', 'purge', [Number(form.id)]);
    expect((blocked.items[0].outcome as { reason: string }).reason).toMatch(/1 live party registered/);

    await deleteRegistration(id);
    const report = await run('form', 'purge', [Number(form.id)]);
    expect(report.done).toBe(1);
  });

  it('selects everything matching the Trash search, minus exclusions', async () => {
    const a = await party(1, 'Alpha');
    const b = await party(1, 'Alphonse');
    const c = await party(1, 'Beta');
    for (const id of [a, b, c]) await deleteRegistration(id);

    const preview = await previewCommand(
      command('party', 'restore'),
      { concertId, selection: { filter: { search: 'alph' }, excludedIds: [b] } },
      null,
    );
    expect(preview.rows.map((row) => row.id)).toEqual([a]);
  });

  it('refuses a party or player while a message to them is being sent', async () => {
    const id = await party(1);
    const [player] = await createPlayers(concertId, 1);
    await sql`
      insert into email_outbox (registration_id, to_email, template_key, purpose, subject, body_md, status)
      values (${id}, 'a@example.com', 'tickets', 'TICKETS', 's', 'b', 'SENDING')
    `;
    await sql`
      insert into email_outbox (player_id, to_email, template_key, purpose, subject, body_md, status)
      values (${player}, 'p@example.com', 'player_invite', 'PLAYER_INVITE', 's', 'b', 'SENDING')
    `;
    await sql`update registrations set deleted_at = now() where id = ${id}`;
    await sql`update players set deleted_at = now() where id = ${player}`;

    expect((await run('party', 'purge', [id])).items[0].outcome).toEqual({
      reason: 'A message to this party is being sent right now.',
    });
    expect((await run('player', 'purge', [player])).items[0].outcome).toEqual({
      reason: 'A message to this player is being sent right now.',
    });
  });

  it('keeps the form history another party shares', async () => {
    const [form] = await sql<{ id: string }[]>`
      insert into registration_forms (segment_id, kind, title, slug, status)
      values (${segmentId}, 'PUBLIC', 'Round 1', 'round-1', 'OPEN') returning id
    `;
    const respond = async (supersedes: string | null) =>
      (await sql<{ id: string }[]>`
        insert into form_responses (form_id, raw, form_schema, submitted_at, supersedes_id)
        values (${form.id}, '{}', '{"blocks":[]}', now(), ${supersedes}) returning id
      `)[0].id;
    const shared = await respond(null);
    const mine = await respond(shared);
    const theirs = await respond(shared);

    const doomed = await party(1, 'Doomed');
    const other = await party(1, 'Other');
    await sql`update registrations set form_response_id = ${mine} where id = ${doomed}`;
    await sql`update registrations set form_response_id = ${theirs} where id = ${other}`;
    await deleteRegistration(doomed);

    const report = await run('party', 'purge', [doomed]);
    expect(report.items[0].outcome).toMatchObject({ responses: 1 });
    const left = await sql<{ id: string }[]>`select id from form_responses order by id`;
    expect(left.map((row) => row.id)).toEqual([shared, theirs]);
  });

  it('redacts the details of earlier Activity rows about what it deleted', async () => {
    const [player] = await createPlayers(concertId, 1);
    await sql`
      insert into audit_log (action, entity_type, entity_id, after)
      values ('player.created', 'player', ${String(player)},
              '{"email":"player1@example.test","fullName":"Player 1"}')
    `;
    await sql`update players set deleted_at = now() where id = ${player}`;
    const restored = await run('player', 'restore', [player]);
    expect(restored.items[0].outcome).toMatchObject({ label: 'Player 1' });
    await sql`update players set deleted_at = now() where id = ${player}`;

    const preview = await previewCommand(command('player', 'purge'), { concertId, selection: { ids: [player] } }, null);
    expect(preview.blastRadius).toContainEqual(
      expect.objectContaining({ text: expect.stringMatching(/earlier Activity entries/) }),
    );
    await run('player', 'purge', [player]);

    const rows = await sql<{ row: string }[]>`select row_to_json(l)::text as row from audit_log l`;
    for (const row of rows) expect(row.row).not.toMatch(/player1@example\.test|Player 1/);
    const items = await sql<{ outcome: string }[]>`select outcome::text from command_run_items`;
    for (const item of items) expect(item.outcome ?? '').not.toMatch(/Player 1/);
  });

  it('treats % and _ in the search as text', async () => {
    const id = await party(1, '50% Off');
    const other = await party(1, 'Plain');
    for (const x of [id, other]) await deleteRegistration(x);
    const trash = await listTrash(concertId, 'party', { search: '%', pageIndex: 0, pageSize: 25 });
    expect(trash.rows.map((row) => row.id)).toEqual([id]);
  });
});

describe('concert scoping', () => {
  it('never restores or deletes another concert\u2019s rows, by id or by filter', async () => {
    const otherConcert = await createConcert('Elsewhere');
    const otherShow = await createShow(otherConcert, 10);
    const otherSegment = await createSegment(otherShow, {
      audienceMode: 'PUBLIC',
      capacity: 4,
      extrasPolicy: 'AUTO_FCFS',
    });
    const [foreign] = await sql<{ id: string }[]>`
      insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, deleted_at)
      values (${otherShow}, ${otherSegment}, 'ADMIN', 'Foreign', 'f@example.test', 'CONFIRMED', now(), now())
      returning id
    `;
    const foreignId = Number(foreign.id);

    for (const mode of ['restore', 'purge'] as const) {
      const report = await run('party', mode, [foreignId]);
      expect(report.items[0]).toMatchObject({
        status: 'SKIPPED',
        outcome: { reason: 'No longer exists in this concert.' },
      });
    }
    const byFilter = await previewCommand(
      command('party', 'purge'),
      { concertId, selection: { filter: { search: 'Foreign' }, excludedIds: [] } },
      null,
    );
    expect(byFilter.total).toBe(0);

    const [row] = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from registrations where id = ${foreignId}
    `;
    expect(row.deleted_at).not.toBeNull();
  });
});

describe('Restore a single seat (§23.4)', () => {
  it('waits with a party that holds no confirmed seat rather than jumping its queue', async () => {
    const id = await party(2);
    const seatsNow = await seats(id);
    await sql`update attendees set status = 'WAITLIST' where registration_id = ${id}`;
    await sql`update registrations set status = 'WAITLIST' where id = ${id}`;
    await removeAttendee(Number(seatsNow[0].id));

    const report = await run('seat', 'restore', [Number(seatsNow[0].id)]);
    expect(report.items[0].outcome).toMatchObject({ confirmed: 0, waitlisted: 1 });
    expect((await seats(id)).map((seat) => seat.status)).toEqual(['WAITLIST', 'WAITLIST']);
  });

  it('sends an extra in a REVIEW segment back to review', async () => {
    const reviewSegment = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 4,
      baseQuota: 1,
      extrasPolicy: 'REVIEW',
      allowPartialGrant: false,
      name: 'Invited',
    });
    const [player] = await createPlayers(concertId, 1);
    const id = await createRegistration({ showId, segmentId: reviewSegment, playerId: player });
    await sql`
      select claim_seats(${reviewSegment}::bigint, ${id}::bigint,
        ${json([{ full_name: 'Base', allocation_type: 'BASE' }, { full_name: 'Extra', allocation_type: 'EXTRA' }])}::jsonb,
        false)
    `;
    const [, extra] = await seats(id);
    await removeAttendee(Number(extra.id));

    const report = await run('seat', 'restore', [Number(extra.id)]);
    expect(report.items[0].outcome).toMatchObject({ pendingReview: 1, note: 'Back in extras review.' });
    expect((await seats(id))[1].status).toBe('PENDING_REVIEW');
  });

  it('says so in the report when a restored party came back waitlisted', async () => {
    const id = await party(3);
    await deleteRegistration(id);
    await party(2, 'Lim Family');
    const report = await run('party', 'restore', [id]);
    expect((report.items[0].outcome as { note: string }).note).toMatch(/^Came back waitlisted: /);
  });
});

