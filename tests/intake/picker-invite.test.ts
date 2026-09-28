import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow, json, setSystemSetting } from '../helpers/fixtures';
import { PLAYER_FORM } from '../forms/fixtures';
import type { FormAnswers } from '@/lib/forms/answers';
import { startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';

/**
 * The player form without tokens (spec/v3.md §25.2) and the optional
 * *Invite players* email.
 */

const resolveMx = vi.hoisted(() => vi.fn());
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ promises: { resolveMx, lookup } }));
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { submitRegistration } = await import('@/app/(registration)/f/[slug]/actions');
const { rosterForPicker } = await import('@/lib/forms/registrant');

const SLUG = 'players-round';
let concertId: number;
let segmentId: number;
let formId: number;
let players: number[];

const answers = (guest: string): FormAnswers => ({
  registrant: { kind: 'flat', values: { contact_name: 'Mum Tan', contact_email: 'mum@example.test', contact_phone: '' } },
  base: { kind: 'repeater', rows: [{ full_name: guest, email: '', seat_note: '' }] },
  extras: { kind: 'repeater', rows: [] },
  logistics: { kind: 'flat', values: { transport: 'public', parking_plate: '', accessibility: '' } },
});

const submit = (over: Partial<Parameters<typeof submitRegistration>[0]>) =>
  submitRegistration({ slug: SLUG, token: null, schemaVersion: 1, answers: answers('Aunt May'), addressConfirmed: false, ...over });

beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
  resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
  requestHeaders.current = new Headers({ 'x-real-ip': '198.51.100.70' });
  await setSystemSetting('form.rate_limit_per_ip_per_min', 1000);
  await setSystemSetting('form.extra_rows_max', 2);
  await setSystemSetting('email.receipt_hold_minutes', 10);
  await setSystemSetting('review.duplicate_name_similarity', 0.8);

  concertId = await createConcert();
  const showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 50,
    baseQuota: 2,
    extrasPolicy: 'AUTO_FCFS',
    allowPartialGrant: true,
  });
  players = await createPlayers(concertId, 3);
  const [form] = await sql<{ id: number }[]>`
    insert into registration_forms (segment_id, kind, title, slug, schema, status)
    values (${segmentId}, 'PLAYER', 'Round 1', ${SLUG}, ${json(PLAYER_FORM)}::text::jsonb, 'OPEN')
    returning id
  `;
  formId = Number(form.id);
});

describe('the picker (§25.2)', () => {
  it('lists the active roster with the base seats each has left', async () => {
    await sql`update players set is_active = false where id = ${players[2]}`;
    await sql`insert into player_allocations (player_id, segment_id, base_quota_override) values (${players[1]}, ${segmentId}, 4)`;
    await submit({ playerId: players[0] });

    const roster = await rosterForPicker(concertId, segmentId);
    expect(roster).toEqual([
      { id: players[0], name: 'Player 1', remaining: 1 },
      { id: players[1], name: 'Player 2', remaining: 4 },
    ]);
  });

  it('links the party to the picked player and books their base seats', async () => {
    const result = await submit({ playerId: players[1] });
    expect(result.ok).toBe(true);
    const [party] = await sql<{ player_id: number }[]>`select player_id::int from registrations`;
    expect(party.player_id).toBe(players[1]);
    const [seat] = await sql<{ allocation_type: string; status: string }[]>`
      select allocation_type::text, status::text from attendees
    `;
    expect(seat).toEqual({ allocation_type: 'BASE', status: 'CONFIRMED' });
  });

  it('refuses a player form with no player named, and a player of another concert', async () => {
    const none = await submit({});
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors?.__player).toBeTruthy();

    const otherConcert = await createConcert('Other');
    const [stranger] = await createPlayers(otherConcert, 1);
    const foreign = await submit({ playerId: stranger });
    expect(foreign.ok).toBe(false);

    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from registrations`;
    expect(count.n).toBe(0);
  });

  it('still takes the invite link as a shortcut', async () => {
    const [player] = await sql<{ invite_token: string }[]>`select invite_token from players where id = ${players[0]}`;
    const result = await submit({ token: player.invite_token });
    expect(result.ok).toBe(true);
    const [party] = await sql<{ player_id: number }[]>`select player_id::int from registrations`;
    expect(party.player_id).toBe(players[0]);
  });
});

describe('Invite players', () => {
  const run = (selection: unknown, params: unknown) =>
    startCommand(
      getCommand('intake.invite_players')!,
      { concertId, selection, params },
      { actorId: null, deadline: Date.now() + 60_000 },
    );

  it('queues each active player their own link, skips who has no address, and a re-run sends nothing', async () => {
    await sql`update players set email = null where id = ${players[2]}`;
    const report = await run({ filter: { active: true }, excludedIds: [] }, { formId });
    expect(report.done).toBe(2);
    expect(report.skipped).toBe(1);

    const messages = await sql<{ player_id: number; status: string; body_md: string; purpose: string }[]>`
      select player_id::int, status::text, body_md, purpose::text from email_outbox order by player_id
    `;
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.purpose === 'PLAYER_INVITE' && m.status === 'QUEUED')).toBe(true);
    expect(messages[0].body_md).toContain(`/f/${SLUG}?k=tok-${concertId}-1`);

    const again = await run({ filter: { active: true }, excludedIds: [] }, { formId });
    expect(again.done).toBe(0);
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox`;
    expect(count.n).toBe(2);
  });

  it('sends again when asked, superseding a pending invite rather than doubling it', async () => {
    await run({ ids: [players[0]] }, { formId });
    await run({ ids: [players[0]] }, { formId, again: true });
    const rows = await sql<{ status: string }[]>`
      select status::text from email_outbox where player_id = ${players[0]} order by id
    `;
    expect(rows.map((r) => r.status)).toEqual(['CANCELLED', 'QUEUED']);
  });

  it('refuses a form that is not open', async () => {
    await sql`update registration_forms set status = 'DRAFT' where id = ${formId}`;
    const report = await run({ ids: [players[0]] }, { formId });
    expect(report.done).toBe(0);
    expect(JSON.stringify(report.items[0].outcome)).toMatch(/not open/);
  });
});
