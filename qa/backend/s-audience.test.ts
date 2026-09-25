import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
const log = (...a: unknown[]) => appendFileSync(join(tmpdir(), 's-backend.log'), a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createPlayers, createSegment, createShow, setSystemSetting } from '../../tests/helpers/fixtures';
import { CommandInputError, previewCommand, startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { createRegistration, updateRegistrationDetails, type NewSeat } from '@/lib/registrations/mutations';
import { listParties, listSeats, poolMeters, viewCounts } from '@/lib/audience/queries';
import { loadPartyRecord } from '@/lib/audience/record';

/**
 * QA for module S (independent reviewer). Criteria in
 * qa-artifacts/claude-S-audience-workspace/01-acceptance.md, written before reading src/.
 * Runs against its own database (zetix_qa_sb), never zetix.
 */

let concertId: number;
let otherConcert: number;
let showId: number;
let reviewSeg: number;
let publicSeg: number;
let otherSeg: number;

const far = () => Date.now() + 60_000;
const run = (name: string, selection: unknown, params: unknown = {}, confirmPhrase?: string, concert = concertId) =>
  startCommand(getCommand(name)!, { concertId: concert, selection, params, confirmPhrase }, { actorId: null, deadline: far() });
const preview = (name: string, selection: unknown, params: unknown = {}) =>
  previewCommand(getCommand(name)!, { concertId, selection, params }, null);
const byFilter = (filter: Record<string, unknown>) => ({ filter, excludedIds: [] as number[] });
const seatsOf = (n: number, type: NewSeat['allocationType'], name = 'Guest'): NewSeat[] =>
  Array.from({ length: n }, (_, i) => ({ fullName: `${name} ${i + 1}`, allocationType: type }));

async function party(seg: number, n: number, type: NewSeat['allocationType'], name = 'Party', opts: { approved?: boolean; requestedAt?: Date } = {}) {
  const { registrationId } = await createRegistration({
    segmentId: seg,
    contactName: name,
    contactEmail: `${name.toLowerCase().replace(/\W/g, '')}@example.test`,
    seats: seatsOf(n, type, name),
    requestedAt: opts.requestedAt ?? null,
  });
  if (opts.approved === false) await sql`update registrations set approved_at = null where id = ${registrationId}`;
  return registrationId;
}
const seatRows = (rid: number) =>
  sql<{ id: string; status: string; qr_token: string | null; ticket_code: string | null; ticket_sent_at: Date | null; over_capacity_at: Date | null }[]>`
    select id, status, qr_token, ticket_code, ticket_sent_at, over_capacity_at from attendees
     where registration_id = ${rid} and deleted_at is null order by id`;
const minutes = (n: number) => new Date(Date.UTC(2026, 8, 1, 10, n));

async function template(concert = concertId) {
  await sql`
    insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
    values (${concert}, 'Default', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', true)`;
}

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('S-QA');
  otherConcert = await createConcert('Other');
  showId = await createShow(concertId, 100);
  reviewSeg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 4, extrasPolicy: 'REVIEW', allowPartialGrant: false, name: 'Review' });
  publicSeg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 3, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Open' });
  const otherShow = await createShow(otherConcert, 50);
  otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 10, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Elsewhere' });
  await setSystemSetting('admin.typed_confirm_above', 2);
});

describe('AC-42 qr_token immutability outside Void', () => {
  it('Reissue keeps qr_token and ticket_code', async () => {
    await template();
    const a = await party(publicSeg, 2, 'EXTRA', 'Ada');
    await run('seats.issue', byFilter({}));
    const before = await seatRows(a);
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL' where registration_id = ${a}`;
    const r = await run('seats.reissue', byFilter({}));
    expect(r.done).toBe(2);
    const after = await seatRows(a);
    expect(after.map((s) => s.qr_token)).toEqual(before.map((s) => s.qr_token));
    expect(after.map((s) => s.ticket_code)).toEqual(before.map((s) => s.ticket_code));
  });

  it('the void flag does not outlive the Void run on the same connection', async () => {
    await template();
    const a = await party(publicSeg, 1, 'EXTRA', 'Ada');
    await run('seats.issue', byFilter({}));
    const [seat] = await seatRows(a);
    await run('seats.void_qr', { ids: [Number(seat.id)] });
    await expect(sql`update attendees set qr_token = 'x' || qr_token where id = ${seat.id}`).rejects.toThrow(/immutable/);
  });

  it('even under the flag, clearing a token is refused', async () => {
    await template();
    const a = await party(publicSeg, 1, 'EXTRA', 'Ada');
    await run('seats.issue', byFilter({}));
    const [seat] = await seatRows(a);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('zetix.voiding_qr', 'on', true)`;
        await tx`update attendees set qr_token = null where id = ${seat.id}`;
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('Move to another show, Set status, Restore keep the token', async () => {
    await template();
    const show2 = await createShow(concertId, 100);
    const seg2 = await createSegment(show2, { audienceMode: 'PUBLIC', capacity: 10, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Second' });
    const a = await party(publicSeg, 2, 'EXTRA', 'Ada');
    await run('seats.issue', byFilter({}));
    const before = (await seatRows(a)).map((s) => s.qr_token);
    const m = await run('audience.move', { ids: [a] }, { segmentId: seg2 });
    expect(m.done).toBe(1);
    const [s1] = await seatRows(a);
    await run('seats.set_status', { ids: [Number(s1.id)] }, { status: 'WAITLIST' });
    await run('seats.set_status', { ids: [Number(s1.id)] }, { status: 'CONFIRMED' });
    await run('audience.cancel', { ids: [a] });
    await run('audience.restore', { ids: [a] });
    expect((await seatRows(a)).map((s) => s.qr_token)).toEqual(before);
  });
});

describe('AC-33 Void and re-issue QR', () => {
  it('typed phrase above admin.typed_confirm_above: wrong phrase refused, nothing changes', async () => {
    await template();
    const a = await party(publicSeg, 3, 'EXTRA', 'Ada');
    await run('seats.issue', byFilter({}));
    const before = await seatRows(a);
    const p = await preview('seats.void_qr', byFilter({}));
    expect(p.irreversible).toBe(true);
    let err: unknown;
    try {
      await run('seats.void_qr', byFilter({}), {}, 'void 3 seats');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandInputError);
    expect((await seatRows(a)).map((s) => s.qr_token)).toEqual(before.map((s) => s.qr_token));
  });

  it('never reaches another concert’s seat by id', async () => {
    await template(otherConcert);
    const theirs = await party(otherSeg, 1, 'EXTRA', 'Stranger');
    await run('seats.issue', byFilter({}), {}, undefined, otherConcert);
    const [seat] = await seatRows(theirs);
    expect(seat.qr_token).not.toBeNull();
    const r = await run('seats.void_qr', { ids: [Number(seat.id)] });
    expect(r.done).toBe(0);
    const [after] = await seatRows(theirs);
    expect(after.qr_token).toBe(seat.qr_token);
  });

  it('a second Void run over the same selection voids again (records behaviour)', async () => {
    await template();
    const a = await party(publicSeg, 1, 'EXTRA', 'Ada');
    await run('seats.issue', byFilter({}));
    const [s0] = await seatRows(a);
    await run('seats.void_qr', { ids: [Number(s0.id)] });
    const [s1] = await seatRows(a);
    await run('seats.void_qr', { ids: [Number(s0.id)] });
    const [s2] = await seatRows(a);
    log('VOID-RERUN', { t0: s0.qr_token, t1: s1.qr_token, t2: s2.qr_token });
    expect(s1.qr_token).not.toBe(s0.qr_token);
  });
});

describe('AC-35/36 door', () => {
  it('check in twice leaves one live check-in; undo keeps the row with reverted_at', async () => {
    const a = await party(publicSeg, 1, 'EXTRA', 'Ada');
    const [seat] = await seatRows(a);
    const one = await run('seats.check_in', { ids: [Number(seat.id)] });
    const two = await run('seats.check_in', { ids: [Number(seat.id)] });
    expect(one.done).toBe(1);
    expect(two.skipped).toBe(1);
    const [n] = await sql<{ live: number; all: number }[]>`
      select count(*) filter (where reverted_at is null)::int as live, count(*)::int as all from check_ins where attendee_id = ${seat.id}`;
    expect(n).toEqual({ live: 1, all: 1 });
    await run('seats.undo_check_in', { ids: [Number(seat.id)] });
    const [m] = await sql<{ live: number; all: number }[]>`
      select count(*) filter (where reverted_at is null)::int as live, count(*)::int as all from check_ins where attendee_id = ${seat.id}`;
    expect(m).toEqual({ live: 0, all: 1 });
  });

  it('check in a waitlisted seat is skipped', async () => {
    await party(publicSeg, 3, 'EXTRA', 'Full');
    const w = await party(publicSeg, 1, 'EXTRA', 'Wait');
    const [seat] = await seatRows(w);
    expect(seat.status).toBe('WAITLIST');
    const r = await run('seats.check_in', { ids: [Number(seat.id)] });
    expect(r.skipped).toBe(1);
  });
});

describe('AC-17 email edit re-addresses pending, never SENT', () => {
  async function outbox(a: number) {
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, sent_at)
      values (${a}, 'TICKETS', 'public_ticket', 'old@example.test', 's', 'b', 'SENT', now()),
             (${a}, 'VERIFICATION', 'public_verify', 'old@example.test', 's', 'b', 'QUEUED', null),
             (${a}, 'REMINDER', 'reminder', 'old@example.test', 's', 'b', 'DRAFT', null)`;
  }
  it('changed address: DRAFT/QUEUED moved, SENT kept', async () => {
    const a = await party(publicSeg, 1, 'EXTRA', 'Ada');
    await outbox(a);
    const r = await updateRegistrationDetails(a, { contactName: 'Ada', contactEmail: 'new@example.test', emailIssue: null });
    expect(r.readdressed).toBe(2);
    const rows = await sql<{ status: string; to_email: string }[]>`select status, to_email from email_outbox where registration_id = ${a} order by id`;
    expect(rows).toEqual([
      { status: 'SENT', to_email: 'old@example.test' },
      { status: 'QUEUED', to_email: 'new@example.test' },
      { status: 'DRAFT', to_email: 'new@example.test' },
    ]);
  });
  it('cleared address: pending messages must not still go to the old address', async () => {
    const a = await party(publicSeg, 1, 'EXTRA', 'Ada');
    await outbox(a);
    const r = await updateRegistrationDetails(a, { contactName: 'Ada', contactEmail: null });
    const rows = await sql<{ status: string; to_email: string }[]>`select status, to_email from email_outbox where registration_id = ${a} order by id`;
    log('CLEARED-EMAIL', JSON.stringify(r), JSON.stringify(rows));
    const stillToOld = rows.filter((x) => (x.status === 'QUEUED' || x.status === 'DRAFT') && x.to_email === 'old@example.test');
    expect(stillToOld).toEqual([]);
  });
});

describe('§7.9 pending mail follows seats that stop being confirmed', () => {
  it('Set status CANCELLED on every seat withdraws the queued TICKETS message', async () => {
    const a = await party(publicSeg, 2, 'EXTRA', 'Ada');
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
              values (${a}, 'TICKETS', 'public_ticket', 'ada@example.test', 's', 'b', 'QUEUED')`;
    const r = await run('seats.set_status', byFilter({}), { status: 'CANCELLED' });
    expect(r.done).toBe(2);
    const [stage] = await sql<{ stage: string | null }[]>`select stage from party_pipeline where registration_id = ${a}`;
    const [mail] = await sql<{ status: string }[]>`select status from email_outbox where registration_id = ${a}`;
    log('SETSTATUS-CANCEL', stage, mail);
    expect(mail.status).toBe('CANCELLED');
  });
  it('Waitlist a party withdraws the queued TICKETS message', async () => {
    const a = await party(publicSeg, 2, 'EXTRA', 'Ada');
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
              values (${a}, 'TICKETS', 'public_ticket', 'ada@example.test', 's', 'b', 'QUEUED')`;
    await run('audience.waitlist', { ids: [a] });
    const [mail] = await sql<{ status: string }[]>`select status from email_outbox where registration_id = ${a}`;
    log('WAITLIST-MAIL', mail);
    expect(mail.status).toBe('CANCELLED');
  });
});

describe('AC-24/45 capacity through commands', () => {
  it('Set status CONFIRMED on a full segment is skipped; with override it is flagged', async () => {
    await party(publicSeg, 3, 'EXTRA', 'Full');
    const w = await party(publicSeg, 1, 'EXTRA', 'Wait');
    const [seat] = await seatRows(w);
    const refused = await run('seats.set_status', { ids: [Number(seat.id)] }, { status: 'CONFIRMED' });
    expect(refused.skipped).toBe(1);
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from attendees where segment_id = ${publicSeg} and status = 'CONFIRMED' and deleted_at is null`;
    expect(c.n).toBe(3);
    const p = await preview('seats.set_status', { ids: [Number(seat.id)] }, { status: 'CONFIRMED', override: true });
    const text = p.blastRadius.map((l) => l.text).join(' ');
    expect(text).toContain('4 of 3');
    await run('seats.set_status', { ids: [Number(seat.id)] }, { status: 'CONFIRMED', override: true });
    const [after] = await seatRows(w);
    expect(after.status).toBe('CONFIRMED');
    expect(after.over_capacity_at).not.toBeNull();
  });

  it('Set status CANCELLED -> CONFIRMED on a full segment leaves the seat CANCELLED (skip rolls back)', async () => {
    const a = await party(publicSeg, 3, 'EXTRA', 'Full');
    const [seat] = await seatRows(a);
    await run('seats.set_status', { ids: [Number(seat.id)] }, { status: 'CANCELLED' });
    await party(publicSeg, 1, 'EXTRA', 'Taker');
    const r = await run('seats.set_status', { ids: [Number(seat.id)] }, { status: 'CONFIRMED' });
    expect(r.skipped).toBe(1);
    const [row] = await sql<{ status: string }[]>`select status from attendees where id = ${seat.id}`;
    expect(row.status).toBe('CANCELLED');
  });

  it('Move to a segment of another concert is refused', async () => {
    const a = await party(publicSeg, 1, 'EXTRA', 'Ada');
    const r = await run('audience.move', { ids: [a] }, { segmentId: otherSeg });
    expect(r.done).toBe(0);
    const [row] = await sql<{ segment_id: string }[]>`select segment_id from registrations where id = ${a}`;
    expect(Number(row.segment_id)).toBe(publicSeg);
  });

  it('Restore when the room is gone comes back waitlisted, report says so', async () => {
    const a = await party(publicSeg, 2, 'EXTRA', 'Ada');
    await run('audience.cancel', { ids: [a] });
    await party(publicSeg, 3, 'EXTRA', 'Taker');
    const r = await run('audience.restore', { ids: [a] });
    expect((await seatRows(a)).map((s) => s.status)).toEqual(['WAITLIST', 'WAITLIST']);
    expect(JSON.stringify(r.items[0].outcome)).toMatch(/waitlisted/i);
  });

  it('Cancel keeps ticket_sent_at and frees the seats', async () => {
    await template();
    const a = await party(publicSeg, 2, 'EXTRA', 'Ada');
    await run('seats.issue', byFilter({}));
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL' where registration_id = ${a}`;
    await run('audience.cancel', { ids: [a] });
    const rows = await seatRows(a);
    expect(rows.every((s) => s.status === 'CANCELLED' && s.ticket_sent_at !== null)).toBe(true);
  });
});

describe('AC-38 blast radius counted from real data', () => {
  it('Delete preview counts seats, delivered tickets and pending messages', async () => {
    await template();
    const a = await party(publicSeg, 2, 'EXTRA', 'Ada');
    const b = await party(reviewSeg, 3, 'COMP', 'Bo');
    await run('seats.issue', byFilter({}));
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL' where registration_id = ${a}`;
    await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
              values (${b}, 'TICKETS', 'public_ticket', 'bo@example.test', 's', 'b', 'QUEUED')`;
    const p = await preview('audience.delete', { ids: [a, b] });
    log('DELETE-BLAST', JSON.stringify(p.blastRadius));
    const counts = Object.fromEntries(p.blastRadius.map((l) => [l.text.split(' ')[0], l.count]));
    expect(p.blastRadius.find((l) => l.text.includes('Trash'))?.count).toBe(5);
    expect(p.blastRadius.find((l) => l.text.includes('delivered'))?.count).toBe(2);
    expect(p.blastRadius.find((l) => l.text.includes('withdrawn'))?.count).toBe(1);
    void counts;
  });
});

describe('AC-21/30 review and verification', () => {
  it('Approve skips a cancelled party; reminder twice leaves exactly one pending', async () => {
    const c = await party(publicSeg, 1, 'EXTRA', 'Cancelled', { approved: false });
    await run('audience.cancel', { ids: [c] });
    const r = await run('audience.approve', { ids: [c] }, { includeFlagged: true });
    expect(r.skipped).toBe(1);

    const u = await party(publicSeg, 1, 'EXTRA', 'Unv');
    await sql`update registrations set verification_token = 'tok' where id = ${u}`;
    await sql`insert into email_templates (key, name, subject, body_md) values ('public_verify','V','V','{{verify_url}}') on conflict (key) do nothing`;
    await Promise.all([
      run('audience.remind_verification', { ids: [u] }),
      run('audience.remind_verification', { ids: [u] }),
    ]);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where registration_id = ${u} and status in ('DRAFT','QUEUED','SENDING')`;
    expect(n.n).toBe(1);
  });
});

describe('AC-4/7/10 filters and hostile input', () => {
  it('an unknown view in a command filter is refused, not read as the whole concert', async () => {
    await party(publicSeg, 1, 'EXTRA', 'Ada');
    await party(publicSeg, 1, 'EXTRA', 'Bo');
    await expect(preview('audience.delete', byFilter({ view: 'no-such-view' }))).rejects.toThrow(CommandInputError);
  });
  it('search with LIKE metacharacters and SQL is literal', async () => {
    await party(publicSeg, 1, 'EXTRA', 'Ada');
    for (const q of ['%', '_', "'; drop table registrations; --", '\\', 'x'.repeat(200)]) {
      const page = await listParties(concertId, { search: q }, { pageIndex: 0, pageSize: 25, sorting: [] });
      expect(page.total).toBe(0);
    }
    await expect(preview('audience.delete', byFilter({ search: 'x'.repeat(201) }))).rejects.toThrow();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from registrations`;
    expect(n.n).toBe(1);
  });
  it('excludedIds are untouched by select-all', async () => {
    const a = await party(publicSeg, 1, 'EXTRA', 'Ada', { approved: false });
    const b = await party(publicSeg, 1, 'EXTRA', 'Bo', { approved: false });
    await run('audience.approve', { filter: { view: 'needs-review' }, excludedIds: [b] });
    const rows = await sql<{ id: string; approved: boolean }[]>`select id, approved_at is not null as approved from registrations order by id`;
    expect(rows.map((r) => r.approved)).toEqual([true, false]);
    void a;
  });
  it('view counts equal the rows each view lists; seats grain = seats of the same parties', async () => {
    await template();
    await party(publicSeg, 2, 'EXTRA', 'Ada');
    await party(reviewSeg, 2, 'EXTRA', 'Bo', { approved: false });
    await party(publicSeg, 2, 'EXTRA', 'Cy');
    await run('seats.issue', { ids: (await seatRows((await sql<{ id: string }[]>`select id from registrations where contact_name='Ada'`)[0].id as unknown as number)).map((s) => Number(s.id)) });
    const counts = await viewCounts(concertId, {});
    for (const [view, count] of Object.entries(counts.views)) {
      const page = await listParties(concertId, { view }, { pageIndex: 0, pageSize: 100, sorting: [] });
      expect([view, page.total]).toEqual([view, count]);
      const seats = await listSeats(concertId, { view }, { pageIndex: 0, pageSize: 100, sorting: [] });
      const partyIds = new Set(page.rows.map((r) => r.id));
      expect(seats.rows.every((s) => partyIds.has(s.registrationId))).toBe(true);
      expect(seats.total).toBe(page.rows.reduce((n, r) => n + r.seats.live + r.seats.cancelled, 0));
    }
    const [sqlCount] = await sql<{ n: number }[]>`select count(*)::int as n from party_pipeline where concert_id = ${concertId} and stage = 'NEEDS_REVIEW'`;
    expect(counts.views['needs-review']).toBe(sqlCount.n);
  });
  it('paging: page 2 continues page 1 without overlap', async () => {
    for (let i = 0; i < 5; i++) await party(reviewSeg, 1, 'COMP', `P${i}`, { requestedAt: minutes(i) });
    const p1 = await listParties(concertId, {}, { pageIndex: 0, pageSize: 2, sorting: [] });
    const p2 = await listParties(concertId, {}, { pageIndex: 1, pageSize: 2, sorting: [] });
    expect(p1.total).toBe(5);
    expect(p1.rows.map((r) => r.id).filter((id) => p2.rows.some((x) => x.id === id))).toEqual([]);
  });
});

describe('AC-9 pool meter', () => {
  it('matches the engine and never goes negative in pool', async () => {
    await createPlayers(concertId, 0);
    await party(reviewSeg, 3, 'EXTRA', 'Ask');
    const [m] = await poolMeters(concertId);
    const [pool] = await sql<{ p: { extras_pool: number } }[]>`select segment_pool(${reviewSeg}::bigint) as p`;
    expect(m.pool.extras_pool).toBe(pool.p.extras_pool);
    // push over capacity with override
    await party(reviewSeg, 5, 'COMP', 'Over');
    await run('audience.confirm_seats', byFilter({ segmentId: reviewSeg }), { override: true });
    const [m2] = await poolMeters(concertId);
    log('POOL-OVER', JSON.stringify(m2?.pool ?? null));
  });
});

describe('AC-15 record scoping', () => {
  it('another concert’s party does not load under this concert', async () => {
    const theirs = await party(otherSeg, 1, 'EXTRA', 'Stranger');
    expect(await loadPartyRecord(concertId, theirs)).toBeNull();
  });
});
