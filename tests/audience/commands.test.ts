import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';
import { previewCommand, startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { createRegistration, type NewSeat } from '@/lib/registrations/mutations';
import type { AudienceFilter } from '@/lib/audience/filter';

/**
 * The Audience workspace's commands — spec/v3.md §23.2, §23.4, §23.5, §25.4.
 *
 * Each runs through the real runner against local Postgres, the way the
 * console runs it: previewed, then worked one row per transaction. What is
 * asserted is what a guest or an admin would notice — which seats are
 * confirmed, which parties were skipped and why — never an internal call.
 */

let concertId: number;
let showId: number;
let reviewSeg: number;
let publicSeg: number;

const far = () => Date.now() + 60_000;

async function run(name: string, selection: unknown, params: unknown = {}, confirmPhrase?: string) {
  const def = getCommand(name);
  if (!def) throw new Error(`no command ${name}`);
  return startCommand(def, { concertId, selection, params, confirmPhrase }, { actorId: null, deadline: far() });
}

async function preview(name: string, selection: unknown, params: unknown = {}) {
  return previewCommand(getCommand(name)!, { concertId, selection, params }, null);
}

const byFilter = (filter: AudienceFilter) => ({ filter, excludedIds: [] });

const seats = (n: number, type: NewSeat['allocationType'], name = 'Guest'): NewSeat[] =>
  Array.from({ length: n }, (_, i) => ({ fullName: `${name} ${i + 1}`, allocationType: type }));

/** A party through the engine, the way the console creates one, then un-approved for review. */
async function party(
  segmentId: number,
  n: number,
  type: NewSeat['allocationType'],
  opts: { name?: string; approved?: boolean; requestedAt?: Date; playerId?: number } = {},
): Promise<number> {
  const { registrationId } = await createRegistration({
    segmentId,
    contactName: opts.name ?? 'Party',
    contactEmail: 'party@example.test',
    seats: seats(n, type, opts.name ?? 'Guest'),
    requestedAt: opts.requestedAt ?? null,
    playerId: opts.playerId ?? null,
  });
  if (opts.approved === false) {
    await sql`update registrations set approved_at = null where id = ${registrationId}`;
  }
  return registrationId;
}

async function statuses(registrationId: number): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`
    select status from attendees where registration_id = ${registrationId} and deleted_at is null order by id
  `;
  return rows.map((r) => r.status);
}

async function stage(registrationId: number): Promise<{ stage: string | null; flags: string[] }> {
  const [row] = await sql<{ stage: string | null; flags: string[] }[]>`
    select stage, flags from party_pipeline where registration_id = ${registrationId}
  `;
  return row;
}

const minutes = (n: number) => new Date(Date.UTC(2026, 8, 1, 10, n));

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Audience');
  showId = await createShow(concertId, 100);
  reviewSeg = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 4,
    extrasPolicy: 'REVIEW',
    allowPartialGrant: false,
    name: 'Review',
  });
  publicSeg = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: 3,
    extrasPolicy: 'AUTO_FCFS',
    allowPartialGrant: false,
    name: 'Open',
  });
  await setSystemSetting('admin.typed_confirm_above', 20);
});

describe('admin-created parties (§25.4)', () => {
  it('are approved on creation, so they never sit in Needs review', async () => {
    const id = await party(publicSeg, 2, 'EXTRA');
    const [row] = await sql<{ approved_at: Date | null }[]>`select approved_at from registrations where id = ${id}`;
    expect(row.approved_at).not.toBeNull();
    expect((await stage(id)).stage).toBe('NEEDS_TICKETS');
  });
});

describe('Approve', () => {
  it('approves clean parties in bulk, skips flagged ones with the flag named, and a re-run does nothing', async () => {
    const clean = await party(publicSeg, 1, 'EXTRA', { name: 'Clean', approved: false });
    const flagged = await party(publicSeg, 1, 'EXTRA', { name: 'Flagged', approved: false });
    await sql`update attendees set name_source = 'PLACEHOLDER' where registration_id = ${flagged}`;

    const report = await run('audience.approve', byFilter({ view: 'needs-review' }));
    expect(report.done).toBe(1);
    expect(report.skipped).toBe(1);
    const skippedItem = report.items.find((i) => i.entityId === flagged)!;
    expect(JSON.stringify(skippedItem.outcome)).toContain('Unnamed guests');
    expect((await stage(clean)).stage).toBe('NEEDS_TICKETS');

    // From the record, with the flags in front of the admin.
    const second = await run('audience.approve', { ids: [flagged, clean] }, { includeFlagged: true });
    expect(second.done).toBe(1);
    expect(second.skipped).toBe(1);
    expect((await stage(flagged)).stage).toBe('NEEDS_TICKETS');
  });
});

describe('Grant extras — the first-come walk (§7.5, §22.2)', () => {
  it('grants in request order and stops at the first party that does not fit', async () => {
    const a = await party(reviewSeg, 2, 'EXTRA', { name: 'A', requestedAt: minutes(1) });
    const b = await party(reviewSeg, 3, 'EXTRA', { name: 'B', requestedAt: minutes(2) });
    const c = await party(reviewSeg, 1, 'EXTRA', { name: 'C', requestedAt: minutes(3) });

    // Ticked in reverse: the walk still goes first come first.
    const report = await run('audience.grant_extras', { ids: [c, b, a] });
    expect(await statuses(a)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await statuses(b)).toEqual(['PENDING_REVIEW', 'PENDING_REVIEW', 'PENDING_REVIEW']);
    // C would fit the two seats left, but B asked first: the clock decides.
    expect(await statuses(c)).toEqual(['PENDING_REVIEW']);
    expect(report.done).toBe(1);
    expect(report.skipped).toBe(2);
  });

  it('orders by each seat’s own request time, not the party’s (§21.3)', async () => {
    const early = await party(reviewSeg, 3, 'EXTRA', { name: 'Early', requestedAt: minutes(1) });
    const late = await party(reviewSeg, 2, 'EXTRA', { name: 'Late', requestedAt: minutes(2) });
    // A seat merged into the early party later asks later than Late's seats.
    await sql`update attendees set requested_at = ${minutes(5).toISOString()} where registration_id = ${early}`;

    await run('audience.grant_extras', byFilter({ view: 'needs-review' }));
    expect(await statuses(late)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await statuses(early)).toEqual(['PENDING_REVIEW', 'PENDING_REVIEW', 'PENDING_REVIEW']);
  });

  it('shows the pool in the preview, and the overage when the override is on (§23.5)', async () => {
    await party(reviewSeg, 3, 'EXTRA', { requestedAt: minutes(1) });
    await party(reviewSeg, 3, 'EXTRA', { requestedAt: minutes(2) });

    const plain = await preview('audience.grant_extras', byFilter({ view: 'needs-review' }));
    expect(plain.blastRadius[0].text).toContain('4 left in the pool');

    const over = await preview('audience.grant_extras', byFilter({ view: 'needs-review' }), { override: true });
    expect(over.blastRadius[0].text).toContain('at 6 of 4');
  });

  it('with the override, grants past capacity and flags the seats Over capacity', async () => {
    await party(reviewSeg, 3, 'EXTRA', { requestedAt: minutes(1) });
    const b = await party(reviewSeg, 3, 'EXTRA', { requestedAt: minutes(2) });

    const report = await run('audience.grant_extras', byFilter({ view: 'needs-review' }), { override: true });
    expect(report.done).toBe(2);
    expect(await statuses(b)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    expect((await stage(b)).flags).toContain('OVER_CAPACITY');
  });

  it('grants the boundary party in part when the segment allows it', async () => {
    await sql`update show_segments set allow_partial_grant = true where id = ${reviewSeg}`;
    await party(reviewSeg, 3, 'EXTRA', { requestedAt: minutes(1) });
    const b = await party(reviewSeg, 3, 'EXTRA', { requestedAt: minutes(2) });

    const report = await run('audience.grant_extras', byFilter({ view: 'needs-review' }));
    expect(await statuses(b)).toEqual(['CONFIRMED', 'PENDING_REVIEW', 'PENDING_REVIEW']);
    const item = report.items.find((i) => i.entityId === b)!;
    expect(JSON.stringify(item.outcome)).toContain('1 of 3 granted');
  });
});

describe('Decline extras, Confirm seats, Promote, Waitlist', () => {
  it('declines to the waitlist, then promotes when room frees', async () => {
    const a = await party(reviewSeg, 4, 'EXTRA', { requestedAt: minutes(1) });
    const b = await party(reviewSeg, 2, 'EXTRA', { requestedAt: minutes(2) });
    await run('audience.grant_extras', { ids: [a] });
    await run('audience.decline_extras', { ids: [b] });
    expect(await statuses(b)).toEqual(['WAITLIST', 'WAITLIST']);
    expect((await stage(b)).stage).toBe('WAITLISTED');

    // Full: promoting is skipped with the engine's reason.
    const refused = await run('audience.promote', byFilter({ view: 'waitlisted' }));
    expect(refused.skipped).toBe(1);

    await run('audience.waitlist', { ids: [a] });
    expect(await statuses(a)).toEqual(['WAITLIST', 'WAITLIST', 'WAITLIST', 'WAITLIST']);

    // First come first: A asked first, and A fits.
    const promoted = await run('audience.promote', byFilter({ view: 'waitlisted' }));
    expect(await statuses(a)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    expect(await statuses(b)).toEqual(['WAITLIST', 'WAITLIST']);
    expect(promoted.done).toBe(1);
  });

  it('Confirm seats refuses past capacity without the override, and confirms with it', async () => {
    await party(publicSeg, 3, 'EXTRA');
    const b = await party(publicSeg, 1, 'EXTRA');
    expect(await statuses(b)).toEqual(['WAITLIST']);

    const refused = await run('audience.confirm_seats', { ids: [b] });
    expect(refused.skipped).toBe(1);
    const forced = await run('audience.confirm_seats', { ids: [b] }, { override: true });
    expect(forced.done).toBe(1);
    expect(await statuses(b)).toEqual(['CONFIRMED']);
  });
});

describe('Move, Cancel, Restore, Delete', () => {
  it('a move into a full segment skips that party instead of failing the run', async () => {
    await party(publicSeg, 3, 'EXTRA');
    const mover = await party(reviewSeg, 2, 'COMP');
    const report = await run('audience.move', { ids: [mover] }, { segmentId: publicSeg });
    expect(report.status).toBe('COMPLETED');
    expect(report.failed + report.skipped).toBe(1);
    const [row] = await sql<{ segment_id: string }[]>`select segment_id from registrations where id = ${mover}`;
    expect(Number(row.segment_id)).toBe(reviewSeg);

    const forced = await run('audience.move', { ids: [mover] }, { segmentId: publicSeg, override: true });
    expect(forced.done).toBe(1);
  });

  it('cancel frees the seats and withdraws pending mail; restore re-decides them', async () => {
    const a = await party(publicSeg, 2, 'EXTRA');
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
      values (${a}, 'TICKETS', 'public_ticket', 'party@example.test', 's', 'b', 'QUEUED')
    `;
    const p = await preview('audience.cancel', { ids: [a] });
    expect(p.blastRadius.map((l) => l.text).join(' ')).toContain('withdrawn');

    await run('audience.cancel', { ids: [a] });
    expect((await stage(a)).stage).toBe('CANCELLED');
    const [mail] = await sql<{ status: string }[]>`select status from email_outbox where registration_id = ${a}`;
    expect(mail.status).toBe('CANCELLED');

    const again = await run('audience.cancel', { ids: [a] });
    expect(again.skipped).toBe(1);

    await run('audience.restore', byFilter({ view: 'cancelled' }));
    expect(await statuses(a)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('delete refuses a party with a guest inside', async () => {
    const a = await party(publicSeg, 1, 'EXTRA');
    await run('seats.check_in', byFilter({}));
    const report = await run('audience.delete', { ids: [a] });
    expect(report.skipped).toBe(1);
    await run('seats.undo_check_in', byFilter({}));
    const ok = await run('audience.delete', { ids: [a] });
    expect(ok.done).toBe(1);
    const [row] = await sql<{ deleted_at: Date | null }[]>`select deleted_at from registrations where id = ${a}`;
    expect(row.deleted_at).not.toBeNull();
  });
});

describe('Verification', () => {
  it('release stamps the timestamp and keeps the token; remind queues one message', async () => {
    const a = await party(publicSeg, 1, 'EXTRA');
    await sql`update registrations set verification_token = 'tok-a' where id = ${a}`;
    await sql`
      insert into email_templates (key, name, subject, body_md) values
        ('public_verify', 'Verify', 'Verify', 'Click {{verify_url}}')
      on conflict (key) do nothing
    `;
    expect((await stage(a)).stage).toBe('UNVERIFIED');

    const reminded = await run('audience.remind_verification', byFilter({ view: 'unverified' }));
    expect(reminded.done).toBe(1);
    const again = await run('audience.remind_verification', byFilter({ view: 'unverified' }));
    expect(again.skipped).toBe(1);
    const [mail] = await sql<{ status: string; purpose: string }[]>`
      select status, purpose from email_outbox where registration_id = ${a}`;
    expect(mail).toEqual({ status: 'QUEUED', purpose: 'VERIFICATION' });

    await run('audience.release', { ids: [a] });
    const [row] = await sql<{ token: string | null; at: Date | null }[]>`
      select verification_token as token, email_verified_at as at from registrations where id = ${a}`;
    expect(row.token).toBe('tok-a');
    expect(row.at).not.toBeNull();
    expect((await stage(a)).stage).toBe('NEEDS_TICKETS');
  });
});

describe('Tickets (§23.4)', () => {
  it('issue pins a design once; void replaces the QR and code, and nothing else can', async () => {
    await sql`
      insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Default', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', true)
    `;
    const a = await party(publicSeg, 2, 'EXTRA');
    const issued = await run('seats.issue', byFilter({ view: 'needs-tickets' }));
    expect(issued.done).toBe(2);
    expect((await stage(a)).stage).toBe('READY_TO_SEND');
    expect((await run('seats.issue', byFilter({}))).skipped).toBe(2);

    const [seat] = await sql<{ id: string; qr_token: string; ticket_code: string }[]>`
      select id, qr_token, ticket_code from attendees where registration_id = ${a} order by id limit 1`;
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL' where id = ${seat.id}`;

    // Immutable to everyone else, still.
    await expect(sql`update attendees set qr_token = 'x' || qr_token where id = ${seat.id}`).rejects.toThrow(/immutable/);

    const p = await preview('seats.void_qr', { ids: [Number(seat.id)] });
    expect(p.irreversible).toBe(true);
    expect(p.blastRadius[0].tone).toBe('danger');

    await run('seats.void_qr', { ids: [Number(seat.id)] });
    const [after] = await sql<{ qr_token: string; ticket_code: string; ticket_sent_at: Date | null }[]>`
      select qr_token, ticket_code, ticket_sent_at from attendees where id = ${seat.id}`;
    expect(after.qr_token).not.toBe(seat.qr_token);
    expect(after.ticket_code).not.toBe(seat.ticket_code);
    expect(after.ticket_sent_at).toBeNull();
    const [audit] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where action = 'attendee.qr_voided' and entity_id = ${seat.id}`;
    expect(audit.n).toBe(1);
  });

  it('reissue puts delivered seats back in Ready to send; dismiss clears the flag only', async () => {
    await sql`
      insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Default', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', true)
    `;
    const a = await party(publicSeg, 2, 'EXTRA');
    await run('seats.issue', byFilter({}));
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL', needs_reissue = true
               where registration_id = ${a}`;
    expect((await stage(a)).flags).toContain('CHANGED_AFTER_SEND');

    const [first] = await sql<{ id: string }[]>`select id from attendees where registration_id = ${a} order by id limit 1`;
    await run('seats.dismiss_reissue', { ids: [Number(first.id)] });
    await run('seats.reissue', byFilter({ ticket: 'needs-reissue' }));
    const rows = await sql<{ sent: boolean; flag: boolean }[]>`
      select ticket_sent_at is not null as sent, needs_reissue as flag from attendees
       where registration_id = ${a} order by id`;
    expect(rows).toEqual([
      { sent: true, flag: false },
      { sent: false, flag: false },
    ]);
    expect((await stage(a)).stage).toBe('READY_TO_SEND');
  });
});

describe('Set status and Delete (seats)', () => {
  it('sets a seat waitlisted and back through the engine', async () => {
    const a = await party(publicSeg, 2, 'EXTRA');
    const [seat] = await sql<{ id: string }[]>`select id from attendees where registration_id = ${a} order by id limit 1`;
    await run('seats.set_status', { ids: [Number(seat.id)] }, { status: 'WAITLIST' });
    expect(await statuses(a)).toEqual(['WAITLIST', 'CONFIRMED']);
    await run('seats.set_status', { ids: [Number(seat.id)] }, { status: 'CONFIRMED' });
    expect(await statuses(a)).toEqual(['CONFIRMED', 'CONFIRMED']);

    await run('seats.delete', { ids: [Number(seat.id)] });
    expect(await statuses(a)).toEqual(['CONFIRMED']);
  });
});

describe('Edit field', () => {
  it('links parties to a player of this concert, and refuses another concert’s player', async () => {
    const [player] = await createPlayers(concertId, 1);
    const other = await createConcert('Other');
    const [stranger] = await createPlayers(other, 1);
    const a = await party(publicSeg, 1, 'EXTRA');

    const refused = await run('audience.edit_field', { ids: [a] }, { field: 'player_id', value: stranger });
    expect(refused.skipped).toBe(1);
    await run('audience.edit_field', { ids: [a] }, { field: 'player_id', value: player });
    const [row] = await sql<{ player_id: string }[]>`select player_id from registrations where id = ${a}`;
    expect(Number(row.player_id)).toBe(player);
  });
});

describe('scope', () => {
  it('never reaches another concert’s parties, by id or by filter', async () => {
    const mine = await party(publicSeg, 1, 'EXTRA', { approved: false });
    const otherConcert = await createConcert('Elsewhere');
    const otherShow = await createShow(otherConcert, 10);
    const otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 5, extrasPolicy: 'AUTO_FCFS' });
    const theirs = await party(otherSeg, 1, 'EXTRA', { approved: false });

    const report = await run('audience.approve', { ids: [mine, theirs] });
    expect(report.done).toBe(1);
    const [row] = await sql<{ approved_at: Date | null }[]>`select approved_at from registrations where id = ${theirs}`;
    expect(row.approved_at).toBeNull();
  });
});

describe('what QA found the suite would not notice', () => {
  async function withTemplate() {
    await sql`
      insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Default', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', true)
    `;
  }
  const queueTickets = (registrationId: number) => sql`
    insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
    values (${registrationId}, 'TICKETS', 'public_ticket', 'party@example.test', 's', 'b', 'QUEUED')
  `;
  const mailStatus = async (registrationId: number) =>
    (await sql<{ status: string }[]>`select status from email_outbox where registration_id = ${registrationId}`)[0]
      ?.status;

  it('Reissue never touches the QR token or the ticket code (decision 28)', async () => {
    await withTemplate();
    const a = await party(publicSeg, 1, 'EXTRA');
    await run('seats.issue', byFilter({}));
    const [before] = await sql<{ qr_token: string; ticket_code: string }[]>`
      select qr_token, ticket_code from attendees where registration_id = ${a}`;
    await sql`update attendees set ticket_sent_at = now() where registration_id = ${a}`;
    const report = await run('seats.reissue', byFilter({}));
    expect(report.done).toBe(1);
    const [after] = await sql<{ qr_token: string; ticket_code: string }[]>`
      select qr_token, ticket_code from attendees where registration_id = ${a}`;
    expect(after).toEqual(before);
  });

  it('seat commands never reach another concert’s seats', async () => {
    await withTemplate();
    const otherConcert = await createConcert('Elsewhere');
    const otherShow = await createShow(otherConcert, 10);
    const otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 5, extrasPolicy: 'AUTO_FCFS' });
    const theirs = await party(otherSeg, 1, 'EXTRA');
    const [seat] = await sql<{ id: string }[]>`select id from attendees where registration_id = ${theirs}`;
    await sql`update attendees set qr_token = 'AAAAAAAAAAAAAAAAAAAAAA', ticket_code = 'ORC-ZZZZ' where id = ${seat.id}`;

    for (const command of ['seats.void_qr', 'seats.delete', 'seats.check_in', 'seats.set_status']) {
      const params = command === 'seats.set_status' ? { status: 'WAITLIST' } : {};
      const report = await run(command, { ids: [Number(seat.id)] }, params, 'void and re-issue 0 seats');
      expect(report.done, command).toBe(0);
    }
    const [row] = await sql<{ qr_token: string; status: string; deleted_at: Date | null; admitted: number }[]>`
      select qr_token, status, deleted_at,
             (select count(*)::int from check_ins where attendee_id = a.id) as admitted
        from attendees a where id = ${seat.id}`;
    expect(row).toEqual({ qr_token: 'AAAAAAAAAAAAAAAAAAAAAA', status: 'CONFIRMED', deleted_at: null, admitted: 0 });
  });

  it('checks a guest in once; a second run skips them', async () => {
    const a = await party(publicSeg, 1, 'EXTRA');
    await run('seats.check_in', byFilter({}));
    const again = await run('seats.check_in', byFilter({}));
    expect(again.skipped).toBe(1);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from check_ins c join attendees x on x.id = c.attendee_id
       where x.registration_id = ${a} and c.reverted_at is null`;
    expect(row.n).toBe(1);
  });

  it('Waitlist withdraws the pending ticket email of a party left with no seat', async () => {
    const a = await party(publicSeg, 2, 'EXTRA');
    await queueTickets(a);
    const report = await run('audience.waitlist', { ids: [a] });
    expect(JSON.stringify(report.items[0].outcome)).toContain('withdrawn');
    expect(await mailStatus(a)).toBe('CANCELLED');
  });

  it('Set status withdraws it only once no seat is confirmed', async () => {
    const a = await party(publicSeg, 2, 'EXTRA');
    await queueTickets(a);
    const seatIds = (await sql<{ id: string }[]>`select id from attendees where registration_id = ${a} order by id`).map(
      (r) => Number(r.id),
    );
    await run('seats.set_status', { ids: [seatIds[0]] }, { status: 'CANCELLED' });
    expect(await mailStatus(a)).toBe('QUEUED');
    await run('seats.set_status', { ids: [seatIds[1]] }, { status: 'CANCELLED' });
    expect(await mailStatus(a)).toBe('CANCELLED');
  });

  it('a filter naming no view is refused, not read as the whole concert', async () => {
    await party(publicSeg, 1, 'EXTRA', { approved: false });
    await expect(run('audience.approve', byFilter({ view: 'no-such-view' }))).rejects.toThrow(/malformed/);
  });
});

describe('editing the contact email (§24.3, §24.6)', () => {
  it('re-addresses pending messages, never sent ones, and stores the check', async () => {
    const { updateRegistrationDetails } = await import('@/lib/registrations/mutations');
    const a = await party(publicSeg, 1, 'EXTRA');
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, sent_at)
      values (${a}, 'TICKETS', 'public_ticket', 'party@example.test', 's', 'b', 'SENT', now()),
             (${a}, 'REMINDER', 'reminder', 'party@example.test', 's', 'b', 'QUEUED', null)
    `;
    const result = await updateRegistrationDetails(a, {
      contactName: 'Party',
      contactEmail: 'new@gmail.con',
      emailIssue: 'We could not find the mail server for “gmail.con”.',
    });
    expect(result).toMatchObject({ emailChanged: true, readdressed: 1 });
    const mail = await sql<{ status: string; to_email: string }[]>`
      select status, to_email from email_outbox where registration_id = ${a} order by id`;
    expect(mail).toEqual([
      { status: 'SENT', to_email: 'party@example.test' },
      { status: 'QUEUED', to_email: 'new@gmail.con' },
    ]);
    expect((await stage(a)).flags).toContain('SUSPICIOUS_ADDRESS');
  });

  it('withdraws pending messages when the address is cleared', async () => {
    const { updateRegistrationDetails } = await import('@/lib/registrations/mutations');
    const a = await party(publicSeg, 1, 'EXTRA');
    await queueTicketsFor(a);
    const result = await updateRegistrationDetails(a, { contactName: 'Party', contactEmail: null });
    expect(result.withdrawn).toBe(1);
    const [mail] = await sql<{ status: string }[]>`select status from email_outbox where registration_id = ${a}`;
    expect(mail.status).toBe('CANCELLED');
  });
});

function queueTicketsFor(registrationId: number) {
  return sql`
    insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
    values (${registrationId}, 'TICKETS', 'public_ticket', 'party@example.test', 's', 'b', 'QUEUED')
  `;
}
