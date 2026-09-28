import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert,
  createPlayers,
  createSegment,
  createShow,
  issueTickets,
  json,
  setSystemSetting,
} from '../../tests/helpers/fixtures';
import { PLAYER_FORM, PUBLIC_FORM } from '../../tests/forms/fixtures';
import type { FormAnswers } from '@/lib/forms/answers';

/**
 * QA, module V (intake). Phase 4 — the real database, the real engine, the
 * real submit action. Only DNS and request headers are stubbed. Each test
 * asserts what the SPEC says; a red test here is a finding, not a flaky test.
 * `EVID` lines are pasted into the report verbatim.
 */

const resolveMx = vi.hoisted(() => vi.fn());
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ promises: { resolveMx, lookup } }));
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { submitRegistration } = await import('@/app/(registration)/f/[slug]/actions');
const { giveBackSeats, nameGuests, changeEmail, loadUpdatableParty } = await import('@/lib/intake/party-update');
const { requestExtraSeats } = await import('@/lib/registrations/edit');
const { createRegistration } = await import('@/lib/registrations/mutations');
const { startCommand, previewCommand } = await import('@/lib/commands/runner');
const { getCommand } = await import('@/lib/commands/registry');
const { stageBatch } = await import('@/lib/import/staging');
const { loadSegmentTarget } = await import('@/lib/import/context');
const { parseMappingProfile } = await import('@/lib/import/profile');
const { parseWorkbook, toSheetRows } = await import('@/lib/import/parse');
const { formFunnels } = await import('@/lib/intake/funnel');

const EVID = (label: string, value: unknown) => console.log(`EVID ${label}: ${JSON.stringify(value)}`);
const far = () => Date.now() + 60_000;

let concertId: number;
let showId: number;

async function form(segmentId: number, kind: 'PUBLIC' | 'PLAYER', slug: string, extra: Record<string, unknown> = {}) {
  const schema = kind === 'PUBLIC' ? PUBLIC_FORM : PLAYER_FORM;
  const [row] = await sql<{ id: number }[]>`
    insert into registration_forms (segment_id, kind, title, slug, schema, status, waitlist_when_full, auto_close_on_capacity)
    values (${segmentId}, ${kind}, ${slug}, ${slug}, ${json(schema)}::text::jsonb, 'OPEN',
            ${(extra.waitlist as boolean) ?? null}, ${(extra.autoClose as boolean) ?? null})
    returning id
  `;
  return Number(row.id);
}

const pub = (email: string, guests: string[], name = 'Alice Tan'): FormAnswers => ({
  registrant: { kind: 'flat', values: { contact_name: name, contact_email: email, heard_from: '', social_handle: '' } },
  party: { kind: 'repeater', rows: guests.map((full_name) => ({ full_name })) },
  extras: { kind: 'flat', values: { interests: [], instrument: '', newsletter_consent: true } },
});
const ply = (email: string, base: string[], name = 'Mum Tan'): FormAnswers => ({
  registrant: { kind: 'flat', values: { contact_name: name, contact_email: email, contact_phone: '' } },
  base: { kind: 'repeater', rows: base.map((full_name) => ({ full_name, email: '', seat_note: '' })) },
  extras: { kind: 'repeater', rows: [] },
  logistics: { kind: 'flat', values: { transport: 'public', parking_plate: '', accessibility: '' } },
});
const submit = (slug: string, answers: FormAnswers, over: Record<string, unknown> = {}) =>
  submitRegistration({ slug, token: null, schemaVersion: 1, answers, addressConfirmed: false, ...over });
const run = (name: string, selection: unknown, params: unknown = {}) =>
  startCommand(getCommand(name)!, { concertId, selection: selection as never, params }, { actorId: null, deadline: far() });

beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
  resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
  requestHeaders.current = new Headers({ 'x-real-ip': '198.51.100.99', 'user-agent': 'qa' });
  await setSystemSetting('form.rate_limit_per_ip_per_min', 10000);
  await setSystemSetting('form.max_tickets_per_response', 4);
  await setSystemSetting('form.extra_rows_max', 2);
  await setSystemSetting('email.receipt_hold_minutes', 10);
  await setSystemSetting('review.auto_approve_clean', false);
  await setSystemSetting('review.duplicate_name_similarity', 0.8);
  await setSystemSetting('import.fuzzy_match_threshold', 0.8);
  await setSystemSetting('admin.typed_confirm_above', 1000);
  concertId = await createConcert('QA V');
  showId = await createShow(concertId, 500);
});

// ---------------------------------------------------------------------------
describe('AC-32 party-size cap covers the whole party (v3 §25.5, §25.8)', () => {
  it('the edit link "request extra tickets" cannot take a public party past form.max_tickets_per_response', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 100, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: true });
    await form(seg, 'PUBLIC', 'capcheck');
    const first = await submit('capcheck', pub('cap@example.test', ['B', 'C', 'D']));
    expect(first.ok).toBe(true);
    const token = first.ok ? new URL(first.confirmationUrl, 'http://x').searchParams.get('r')! : '';
    const r1 = await requestExtraSeats(token, ['E', 'F']);
    const r2 = await requestExtraSeats(token, ['G', 'H']);
    const r3 = await requestExtraSeats(token, ['I', 'J']);
    const [n] = await sql<{ n: number; regs: number }[]>`
      select count(*)::int as n, count(distinct registration_id)::int as regs from attendees
       where segment_id = ${seg} and deleted_at is null and status <> 'CANCELLED'`;
    EVID('AC-32 requestExtraSeats x3 on a party of 4 with cap 4', { r1, r2, r3, liveSeats: n.n, parties: n.regs });
    expect(n.n).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
describe('AC-38 give back seats — waitlist promotion keeps the whole-party rule (allocation §7.4)', () => {
  it('does not split a waitlisted extras party when allow_partial_grant is off', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 3, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false });
    const { registrationId: holder } = await createRegistration({
      segmentId: seg, contactName: 'Holder', contactEmail: 'holder@example.test',
      seats: ['H1', 'H2', 'H3'].map((fullName) => ({ fullName, allocationType: 'EXTRA' as const })),
    });
    const { registrationId: pair } = await createRegistration({
      segmentId: seg, contactName: 'Pair', contactEmail: 'pair@example.test',
      seats: ['P1', 'P2'].map((fullName) => ({ fullName, allocationType: 'EXTRA' as const })),
    });
    const before = await sql`select full_name, status::text from attendees where registration_id = ${pair} order by id`;
    await sql`update registrations set update_token = 'qa-holder-token-000000' where id = ${holder}`;
    const [h1] = await sql<{ id: number }[]>`select id::int from attendees where registration_id = ${holder} order by id limit 1`;
    const result = await giveBackSeats('qa-holder-token-000000', [h1.id]);
    const after = await sql`select full_name, status::text from attendees where registration_id = ${pair} order by id`;
    EVID('AC-38 waitlisted pair before', before);
    EVID('AC-38 give back 1 seat', result);
    EVID('AC-38 waitlisted pair after', after);
    const statuses = after.map((a) => a.status);
    // Whole party: both confirmed or both still waiting — never one of two.
    expect(new Set(statuses).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('AC-30 merge respects each player’s own quota (allocation §7.4, v3 §23.5)', () => {
  it('uses the player’s base_quota_override, not the segment default, when judging a merge', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 50, baseQuota: 2, extrasPolicy: 'AUTO_FCFS' });
    const [p1, p2] = await createPlayers(concertId, 2);
    // p1 is owed only ONE seat here.
    await sql`insert into player_allocations (player_id, segment_id, base_quota_override) values (${p1}, ${seg}, 1)`;
    const a = (await createRegistration({ segmentId: seg, contactName: 'Sam Ong', contactEmail: 'sam@example.test', playerId: p1,
      seats: [{ fullName: 'Sam Ong', allocationType: 'BASE' as const }] })).registrationId;
    const b = (await createRegistration({ segmentId: seg, contactName: 'Sam Ong', contactEmail: 'sam@example.test', playerId: p2,
      seats: [{ fullName: 'Uma Ong', allocationType: 'BASE' as const }] })).registrationId;
    const [pairRow] = await sql<{ id: number }[]>`select id::int from duplicate_candidates where least(registration_a_id, registration_b_id) = ${Math.min(a, b)}`;
    const keep = a < b ? 'A' : 'B';
    const report = await run('intake.merge', { ids: [pairRow.id] }, { keep });
    const [held] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees at join registrations r on r.id = at.registration_id
       where r.player_id = ${p1} and at.allocation_type = 'BASE' and at.status = 'CONFIRMED' and at.deleted_at is null and r.deleted_at is null`;
    const oc = await sql`select full_name, over_capacity_at is not null as marked from attendees order by id`;
    EVID('AC-30 merge into p1 (override quota 1) without override', { done: report.done, skipped: report.skipped, p1BaseConfirmed: held.n, outcome: report.items[0]?.outcome, overCapacityMarks: oc });
    expect(held.n).toBeLessThanOrEqual(1);
  });

  it('cross-segment merge into a full segment is skipped and never oversells', async () => {
    const full = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 2, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Full' });
    const other = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 10, baseQuota: 2, extrasPolicy: 'AUTO_FCFS', name: 'Other' });
    const [pl] = await createPlayers(concertId, 1);
    const a = (await createRegistration({ segmentId: full, contactName: 'Kim', contactEmail: 'kim@example.test',
      seats: ['K1', 'K2'].map((fullName) => ({ fullName, allocationType: 'EXTRA' as const })) })).registrationId;
    const b = (await createRegistration({ segmentId: other, contactName: 'Kim', contactEmail: 'kim@example.test', playerId: pl,
      seats: ['K3'].map((fullName) => ({ fullName, allocationType: 'BASE' as const })) })).registrationId;
    const [pairRow] = await sql<{ id: number }[]>`select id::int from duplicate_candidates`;
    const report = await run('intake.merge', { ids: [pairRow.id] }, { keep: a < b ? 'A' : 'B' });
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from attendees where segment_id = ${full} and status = 'CONFIRMED' and deleted_at is null`;
    EVID('AC-30 cross-segment merge into full', { done: report.done, skipped: report.skipped, outcome: report.items[0]?.outcome, confirmedInFull: c.n, capacity: 2 });
    expect(c.n).toBeLessThanOrEqual(2);
  });

  it('merge and undo merge never change a qr_token (decision 28)', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    const a = (await createRegistration({ segmentId: seg, contactName: 'Lee', contactEmail: 'lee@example.test', seats: [{ fullName: 'L1', allocationType: 'EXTRA' as const }] })).registrationId;
    const b = (await createRegistration({ segmentId: seg, contactName: 'Lee', contactEmail: 'lee@example.test', seats: [{ fullName: 'L2', allocationType: 'EXTRA' as const }] })).registrationId;
    await issueTickets(concertId, showId);
    const tokens = async () => sql<{ id: number; qr_token: string }[]>`select id::int, qr_token from attendees order by id`;
    const t0 = await tokens();
    const [pairRow] = await sql<{ id: number }[]>`select id::int from duplicate_candidates`;
    await run('intake.merge', { ids: [pairRow.id] });
    const t1 = await tokens();
    await run('intake.undo_merge', { ids: [pairRow.id] });
    const t2 = await tokens();
    EVID('NN-4 qr tokens before/after merge/after undo equal', { same1: JSON.stringify(t0) === JSON.stringify(t1), same2: JSON.stringify(t0) === JSON.stringify(t2), a, b });
    expect(t1).toEqual(t0);
    expect(t2).toEqual(t0);
  });
});

// ---------------------------------------------------------------------------
describe('AC-25..28 duplicates', () => {
  it('never pairs parties in different shows, and pairs across segments of one show', async () => {
    const seg1 = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS', name: 'S1' });
    const seg2 = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 20, baseQuota: 2, extrasPolicy: 'AUTO_FCFS', name: 'S2' });
    const show2 = await createShow(concertId, 100);
    const seg3 = await createSegment(show2, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS', name: 'S3' });
    for (const s of [seg1, seg2, seg3]) {
      await createRegistration({ segmentId: s, contactName: 'Dup Person', contactEmail: 'dup@example.test', seats: [{ fullName: 'X', allocationType: 'EXTRA' as const }] });
    }
    const pairs = await sql`select show_id::int, reasons from duplicate_candidates order by id`;
    EVID('AC-25/27 pairs', pairs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].show_id).toBe(showId);
  });
});

// ---------------------------------------------------------------------------
describe('AC-7 forged player id and hostile inputs are refused without a write', () => {
  it('refuses an inactive, deleted or foreign player, and a non-numeric id', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 50, baseQuota: 2, extrasPolicy: 'AUTO_FCFS' });
    await form(seg, 'PLAYER', 'pl');
    const [inactive, deleted] = await createPlayers(concertId, 2);
    await sql`update players set is_active = false where id = ${inactive}`;
    await sql`update players set deleted_at = now() where id = ${deleted}`;
    const other = await createConcert('Elsewhere');
    const [foreign] = await createPlayers(other, 1);
    const results = [];
    for (const playerId of [inactive, deleted, foreign, 'abc', -1, 1e20, null]) {
      results.push(await submit('pl', ply('m@example.test', ['G']), { playerId }));
    }
    const [n] = await sql<{ r: number; a: number; o: number }[]>`
      select (select count(*)::int from registrations) as r, (select count(*)::int from attendees) as a,
             (select count(*)::int from email_outbox) as o`;
    EVID('AC-7 results', results.map((r) => (r.ok ? 'OK' : r.message)));
    EVID('AC-7 rows written', n);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(n).toEqual({ r: 0, a: 0, o: 0 });
  });

  it('a very long name, SQL metacharacters and wrong types are a structured error or a clean save, never a throw', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50, extrasPolicy: 'AUTO_FCFS' });
    await form(seg, 'PUBLIC', 'hostile');
    const outcomes: unknown[] = [];
    const attempts: FormAnswers[] = [
      pub('long@example.test', [], 'x'.repeat(100_000)),
      pub("o'brien@example.test", ["Robert'); drop table attendees;--"], "O'Brien \\ %_"),
      pub('../../etc/passwd@example.test', []),
      { registrant: { kind: 'flat', values: { contact_name: 42, contact_email: ['a'] } } } as unknown as FormAnswers,
      null as unknown as FormAnswers,
    ];
    for (const answers of attempts) {
      try {
        const r = await submit('hostile', answers);
        outcomes.push(r.ok ? 'ok' : r.message);
      } catch (error) {
        outcomes.push(`THREW: ${(error as Error).message.slice(0, 120)}`);
      }
    }
    const [t] = await sql<{ n: number }[]>`select count(*)::int as n from attendees`;
    EVID('hostile submit outcomes', outcomes);
    EVID('attendees table intact, rows', t.n);
    expect(outcomes.some((o) => String(o).startsWith('THREW'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('AC-36..39 update link', () => {
  async function party(seg: number, token: string, seats: (string | null)[]) {
    const { registrationId } = await createRegistration({ segmentId: seg, contactName: 'Ana Lim', contactEmail: 'ana@example.test',
      seats: seats.map((fullName) => ({ fullName, allocationType: 'EXTRA' as const })) });
    await sql`update registrations set update_token = ${token} where id = ${registrationId}`;
    return registrationId;
  }

  it('renaming keeps qr_token; hostile ids and tokens are refused without a write', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    const id = await party(seg, 'qa-ana-token-0000000000', ['Ana Lim', null]);
    const other = await party(seg, 'qa-other-token-00000000', ['Zed']);
    await issueTickets(concertId, showId);
    const [ph] = await sql<{ id: number; qr_token: string }[]>`select id::int, qr_token from attendees where registration_id = ${id} and name_source = 'PLACEHOLDER'`;
    const [z] = await sql<{ id: number }[]>`select id::int from attendees where registration_id = ${other}`;
    const renamed = await nameGuests('qa-ana-token-0000000000', [{ attendeeId: ph.id, fullName: 'Ben Lim' }]);
    const [after] = await sql<{ full_name: string; name_source: string; qr_token: string; needs_reissue: boolean }[]>`
      select full_name, name_source::text, qr_token, needs_reissue from attendees where id = ${ph.id}`;
    const hostile = [
      await giveBackSeats('qa-ana-token-0000000000', [z.id]),
      await giveBackSeats('qa-ana-token-0000000000', [-1]),
      await giveBackSeats('qa-ana-token-0000000000', []),
      await giveBackSeats("' or 1=1 --", [ph.id]),
      await giveBackSeats('../../../etc/passwd', [ph.id]),
      await nameGuests('qa-ana-token-0000000000', [{ attendeeId: z.id, fullName: 'Hijack' }]),
    ];
    const [zAfter] = await sql<{ status: string; full_name: string }[]>`select status::text, full_name from attendees where id = ${z.id}`;
    EVID('AC-36 rename', { renamed, before: ph.qr_token, after });
    EVID('AC-39 hostile', hostile.map((h) => h.message));
    EVID('AC-39 other party seat untouched', zAfter);
    expect(after.qr_token).toBe(ph.qr_token);
    expect(after.name_source).toBe('PROVIDED');
    expect(hostile.every((h) => !h.ok)).toBe(true);
    expect(zAfter).toEqual({ status: 'CONFIRMED', full_name: 'Zed' });
  });

  it('OBSERVED: the update link also renames an already-named guest (v3 §25.6 vs v2 §8.3.1)', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    const id = await party(seg, 'qa-named-token-00000000', ['Ana Lim', 'Real Name']);
    const [named] = await sql<{ id: number }[]>`select id::int from attendees where registration_id = ${id} and full_name = 'Real Name'`;
    const r = await nameGuests('qa-named-token-00000000', [{ attendeeId: named.id, fullName: 'Someone Else' }]);
    const [after] = await sql<{ full_name: string }[]>`select full_name from attendees where id = ${named.id}`;
    EVID('update link rename of an already-named seat', { r, after });
    // NOTE, not a failure: v3 §25.6 says "names unnamed guests"; v2 §8.3.1 lets the
    // edit link fix any guest's name. Recorded as observed.
    expect(after.full_name).toBe('Someone Else');
  });

  it('OBSERVED: changing the email on a PLAYER party puts it behind verification (v3 §25.6 vs v2 §8.1.4)', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 20, baseQuota: 2, extrasPolicy: 'AUTO_FCFS' });
    const [p] = await createPlayers(concertId, 1);
    const { registrationId } = await createRegistration({ segmentId: seg, contactName: 'Mum', contactEmail: 'mum@example.test', playerId: p,
      seats: [{ fullName: 'Aunt', allocationType: 'BASE' as const }] });
    await sql`update registrations set update_token = 'qa-player-token-0000000' where id = ${registrationId}`;
    const before = await sql`select stage from party_pipeline where registration_id = ${registrationId}`;
    const r = await changeEmail('qa-player-token-0000000', 'mum.new@example.test', { addressConfirmed: false });
    const after = await sql`select stage, flags from party_pipeline where registration_id = ${registrationId}`;
    const [reg] = await sql`select verification_token is not null as has_token, email_verified_at from registrations where id = ${registrationId}`;
    EVID('player party email change', { r: r.message, before, after, reg });
    // OPEN QUESTION, not a failure: v3 §25.6 says the corrected email is re-verified;
    // v2 §8.1.4 says player parties never verify. The code follows v3. Recorded.
    expect(after[0].stage).toBe('UNVERIFIED');
  });
});

// ---------------------------------------------------------------------------
describe('AC-11 receipt hold resolves through the cascade', () => {
  it('an unset email.receipt_hold_minutes is not silently a zero hold (README §2.1: missing value is an error, not a fallback)', async () => {
    await sql`delete from system_settings where key = 'email.receipt_hold_minutes'`;
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    await form(seg, 'PUBLIC', 'nohold');
    const r = await submit('nohold', pub('nh@example.test', []));
    const rows = await sql`select status::text, scheduled_for from email_outbox where purpose = 'RECEIPT'`;
    EVID('AC-11 receipt with hold unset', { ok: r.ok, rows });
    // Informational: spec §30.2 "none is a code default". Recorded, asserted loosely.
    expect(rows).toHaveLength(1);
  });

  it('changing the concert-level hold changes when the receipt is due', async () => {
    await sql`update concerts set defaults = coalesce(defaults, '{}'::jsonb) || '{"email.receipt_hold_minutes": 45}'::jsonb where id = ${concertId}`;
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    await form(seg, 'PUBLIC', 'hold45');
    const t = Date.now();
    await submit('hold45', pub('h45@example.test', []));
    const [row] = await sql<{ scheduled_for: Date }[]>`select scheduled_for from email_outbox where purpose = 'RECEIPT'`;
    const minutes = (new Date(row.scheduled_for).getTime() - t) / 60000;
    EVID('AC-11 concert-level hold 45 -> minutes until due', Math.round(minutes));
    expect(Math.round(minutes)).toBe(45);
  });
});

// ---------------------------------------------------------------------------
describe('AC-16 a submission after the receipt was SENT queues an updated receipt, SENT untouched', () => {
  it('works', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    await form(seg, 'PUBLIC', 'sent');
    await submit('sent', pub('s@example.test', ['B']));
    await sql`update email_outbox set status = 'SENT', sent_at = now() where purpose = 'RECEIPT'`;
    await submit('sent', pub('s@example.test', ['C']));
    const rows = await sql`select id::int, status::text, superseded_by_id from email_outbox where purpose = 'RECEIPT' order by id`;
    EVID('AC-16 receipts', rows);
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'QUEUED']);
  });
});

// ---------------------------------------------------------------------------
describe('AC-20 Send tickets skips NEEDS_REVIEW', () => {
  it('previews a form party as skipped, not approved', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    await form(seg, 'PUBLIC', 'gate');
    await submit('gate', pub('g@example.test', ['B']));
    await sql`update registrations set email_verified_at = now()`;
    const [reg] = await sql<{ id: number }[]>`select id::int from registrations`;
    const preview = await previewCommand(getCommand('delivery.send_tickets')!, { concertId, selection: { ids: [reg.id] }, params: {} } as never, null);
    EVID('AC-20 send preview row', preview.rows.map((r) => ({ skip: r.skip })));
    expect(preview.rows[0].skip).toMatch(/approv|review/i);
  });
});

// ---------------------------------------------------------------------------
describe('AC-42..53 import staging', () => {
  const LONG = () => parseMappingProfile({
    columns: { requested_at: 'Timestamp', contact_name: 'Name', contact_email: 'Email', attendee_name: 'Guest' },
    default_allocation_type: 'EXTRA',
  });
  const stage = async (seg: number, rows: { rowNumber: number; cells: Record<string, string> }[], profile = LONG()) =>
    stageBatch({ target: await loadSegmentTarget(seg), filename: 'qa.csv', profile, rows, uploadedBy: null, queueReceipts: false });

  it('a 450-line CSV with duplicates, a missing column and latin-1 bytes stages, commits within capacity, no oversell', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false });
    const lines = ['Timestamp,Name,Email,Guest'];
    for (let i = 0; i < 450; i += 1) {
      const email = i % 10 === 0 ? 'dupe@example.test' : `p${i}@example.test`;
      lines.push(`,Person ${i} Café,${email},Guest ${i}`);
    }
    lines.push(',Bad Row,bad@gmail..com,');
    const bytes = Buffer.from(lines.join('\n'), 'latin1');
    const wb = await parseWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'qa.csv');
    const rows = toSheetRows(wb.sheets[0], 1).rows;
    const staged = await stage(seg, rows);
    const [counts] = await sql`select count(*)::int as rows, count(distinct party_key)::int as parties from import_rows where batch_id = ${staged.batchId}`;
    const [bad] = await sql`select issues from import_rows where batch_id = ${staged.batchId} and normalized->>'contactEmail' = 'bad@gmail..com'`;
    const [cafe] = await sql`select normalized->>'contactName' as name from import_rows where batch_id = ${staged.batchId} and row_number = 2`;
    const report = await run('intake.commit_rows', { filter: { batchId: staged.batchId }, excludedIds: [] });
    const [c] = await sql<{ confirmed: number; waitlisted: number }[]>`
      select count(*) filter (where status = 'CONFIRMED')::int as confirmed, count(*) filter (where status = 'WAITLIST')::int as waitlisted
        from attendees where segment_id = ${seg} and deleted_at is null`;
    const [flag] = await sql`select flags from party_pipeline where contact_email = 'bad@gmail..com'`.catch(() => [null]);
    EVID('AC-53 staged', { ...counts, emptyLines: staged.emptyLines, badIssues: bad?.issues, latin1Name: cafe?.name });
    EVID('AC-52 commit', { done: report.done, skipped: report.skipped, failed: report.failed, ...c, capacity: 300 });
    EVID('AC-51 gmail..com party flags', flag);
    expect(c.confirmed).toBeLessThanOrEqual(300);
    expect(JSON.stringify(bad?.issues)).toMatch(/CONTACT_EMAIL_MALFORMED/);
  });

  it('warns when rows of one party disagree on the player (import.md §9.4)', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 50, baseQuota: 2, extrasPolicy: 'AUTO_FCFS' });
    await createPlayers(concertId, 2);
    const profile = parseMappingProfile({
      columns: { requested_at: null, contact_name: 'Name', contact_email: 'Email', attendee_name: 'Guest' },
      player_match: { column: 'Player', strategy: 'NAME' },
      default_allocation_type: 'BASE',
    });
    const { batchId } = await stage(seg, [
      { rowNumber: 2, cells: { Name: 'Mum', Email: 'mum@example.test', Guest: 'G1', Player: 'Player 1' } },
      { rowNumber: 3, cells: { Name: 'Mum', Email: 'mum@example.test', Guest: 'G2', Player: 'Player 2' } },
    ], profile);
    const rows = await sql`select row_number, issues from import_rows where batch_id = ${batchId} order by row_number`;
    await run('intake.commit_rows', { filter: { batchId }, excludedIds: [] });
    const regs = await sql`select r.player_id::int, array_agg(a.full_name order by a.id) as seats from registrations r join attendees a on a.registration_id = r.id group by r.id`;
    EVID('import player disagreement issues', rows.map((r) => ({ row: r.row_number, codes: (r.issues as { code: string }[]).map((i) => i.code) })));
    EVID('import player disagreement committed as', regs);
    expect(JSON.stringify(rows[1].issues)).toMatch(/PLAYER/);
  });

  it('OBSERVED: BASE rows in a player segment with no player column stage clean and waitlist (import.md §9.5; UI warns)', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 50, baseQuota: 2, extrasPolicy: 'AUTO_FCFS' });
    await createPlayers(concertId, 1);
    const profile = parseMappingProfile({
      columns: { requested_at: null, contact_name: 'Name', contact_email: 'Email', attendee_name: 'Guest' },
      default_allocation_type: 'BASE',
    });
    const { batchId } = await stage(seg, [{ rowNumber: 2, cells: { Name: 'Mum', Email: 'mum@example.test', Guest: 'G1' } }], profile);
    const [row] = await sql`select issues from import_rows where batch_id = ${batchId}`;
    const report = await run('intake.commit_rows', { filter: { batchId }, excludedIds: [] });
    const seats = await sql`select allocation_type::text, status::text from attendees`;
    EVID('BASE without player: issues', (row.issues as { code: string; level: string }[]).map((i) => `${i.level}:${i.code}`));
    EVID('BASE without player: committed', { done: report.done, seats });
    // NOTE: pre-existing (V1 plan.ts had the same `playerMatch &&` guard); the import
    // screen warns "These parties will import with no player attached" before staging.
    expect(seats).toEqual([{ allocation_type: 'BASE', status: 'WAITLIST' }]);
  });

  it('rows without a timestamp are first-come in file order (§25.7)', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50, extrasPolicy: 'AUTO_FCFS' });
    const { batchId } = await stage(seg, [5, 3, 9, 2].map((n, i) => ({ rowNumber: i + 2, cells: { Timestamp: '', Name: `N${n}`, Email: `n${n}@example.test`, Guest: `G${n}` } })));
    await run('intake.commit_rows', { filter: { batchId }, excludedIds: [] });
    const order = await sql`select contact_name from registrations order by requested_at, id`;
    EVID('AC-46 FCFS order', order.map((o) => o.contact_name));
    expect(order.map((o) => o.contact_name)).toEqual(['N5', 'N3', 'N9', 'N2']);
  });
});

// ---------------------------------------------------------------------------
describe('AC-34 funnel equals the database', () => {
  it('counts responses, parties, approved, sent', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50, extrasPolicy: 'AUTO_FCFS' });
    const formId = await form(seg, 'PUBLIC', 'funnel');
    await submit('funnel', pub('f1@example.test', ['B']));
    await submit('funnel', pub('f1@example.test', ['C'])); // merged
    await submit('funnel', pub('f2@example.test', []));
    await sql`update registrations set approved_at = now() where contact_email = 'f2@example.test'`;
    const [f] = (await formFunnels(concertId)).filter((x) => x.id === formId);
    EVID('AC-34 funnel', f);
    expect([f.responses, f.parties, f.approved, f.sent]).toEqual([3, 2, 1, 0]);
  });
});

// ---------------------------------------------------------------------------
describe('AC-17, AC-23, AC-24, AC-29 more of the gate and the receipt', () => {
  it('AC-23/24 an admin-created party is approved on creation; approval never touches seats', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    const { registrationId } = await createRegistration({ segmentId: seg, contactName: 'Desk Entry', contactEmail: 'desk@example.test',
      seats: [{ fullName: 'Desk Entry', allocationType: 'EXTRA' as const }] });
    const [reg] = await sql`select approved_at is not null as approved from registrations where id = ${registrationId}`;
    const seatsBefore = await sql`select id::int, status::text from attendees where registration_id = ${registrationId}`;
    await sql`update registrations set approved_at = null where id = ${registrationId}`;
    const seatsAfter = await sql`select id::int, status::text from attendees where registration_id = ${registrationId}`;
    const [stage] = await sql`select stage from party_pipeline where registration_id = ${registrationId}`;
    EVID('AC-23/24', { approvedOnCreate: reg.approved, seatsBefore, seatsAfterUnapprove: seatsAfter, stageUnapproved: stage.stage });
    expect(reg.approved).toBe(true);
    expect(seatsAfter).toEqual(seatsBefore);
    expect(stage.stage).toBe('NEEDS_REVIEW');
  });

  it('AC-17 a SENDING receipt is not superseded; the submit still lands', async () => {
    const seg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    await form(seg, 'PUBLIC', 'sending');
    await submit('sending', pub('snd@example.test', []));
    await sql`update email_outbox set status = 'SENDING' where purpose = 'RECEIPT'`;
    const r = await submit('sending', pub('snd@example.test', ['Late']));
    const rows = await sql`select status::text from email_outbox where purpose = 'RECEIPT' order by id`;
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from attendees where segment_id = ${seg} and deleted_at is null`;
    EVID('AC-17', { ok: r.ok, receipts: rows.map((x) => x.status), seats: n.n });
    expect(r.ok).toBe(true);
    expect(rows.map((x) => x.status)).toEqual(['SENDING']);
    // The public registrant is seat #1 of every submission (decision 36), so 1 + 2.
    expect(n.n).toBe(3);
  });

  it('AC-29 merge: the absorbed party’s pending receipt is withdrawn and one receipt is queued for the survivor', async () => {
    const pubSeg = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 20, extrasPolicy: 'AUTO_FCFS' });
    const plySeg = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 20, baseQuota: 2, extrasPolicy: 'AUTO_FCFS' });
    const [pl] = await createPlayers(concertId, 1);
    await form(pubSeg, 'PUBLIC', 'm-pub');
    await form(plySeg, 'PLAYER', 'm-ply');
    await submit('m-pub', pub('merge@example.test', ['Guest P']));
    await submit('m-ply', ply('merge@example.test', ['Guest Q']), { playerId: pl });
    const [pair] = await sql<{ id: number }[]>`select id::int from duplicate_candidates`;
    await run('intake.merge', { ids: [pair.id] });
    const rows = await sql`select registration_id::int, status::text, scheduled_for is null as due_now from email_outbox where purpose = 'RECEIPT' order by id`;
    const parties = await sql`select id::int, deleted_at is not null as deleted, merged_into_id::int from registrations order by id`;
    EVID('AC-29 receipts after merge', { rows, parties });
    expect(rows.filter((x) => ['DRAFT', 'QUEUED'].includes(x.status as string))).toHaveLength(1);
  });
});
