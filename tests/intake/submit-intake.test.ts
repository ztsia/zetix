import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createSegment,
  createShow,
  json,
  setSystemSetting,
} from '../helpers/fixtures';
import { PLAYER_FORM, PUBLIC_FORM } from '../forms/fixtures';
import type { FormAnswers } from '@/lib/forms/answers';

/**
 * Intake on the form's submit path (spec/v3.md §25.3–§25.5, §24.6): one party
 * per email per segment, the receipt, the review gate, and the address verdict.
 *
 * The database and `claim_seats()` are real, as in `tests/forms/submit.test.ts`;
 * only DNS is mocked.
 */

const resolveMx = vi.hoisted(() => vi.fn());
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ promises: { resolveMx, lookup } }));

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { submitRegistration } = await import('@/app/(registration)/f/[slug]/actions');

const SLUG = 'intake-public';

async function seedForm(opts: {
  schema: typeof PUBLIC_FORM;
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
  capacity: number;
  baseQuota?: number | null;
  autoApprove?: boolean | null;
}) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, opts.capacity);
  const segmentId = await createSegment(showId, {
    audienceMode: opts.audienceMode,
    capacity: opts.capacity,
    baseQuota: opts.baseQuota ?? null,
    extrasPolicy: 'AUTO_FCFS',
    allowPartialGrant: true,
  });
  if (opts.autoApprove !== undefined) {
    await sql`update show_segments set auto_approve_clean = ${opts.autoApprove} where id = ${segmentId}`;
  }
  const [row] = await sql<{ id: number }[]>`
    insert into registration_forms (segment_id, kind, title, slug, schema, status)
    values (${segmentId}, ${opts.schema.kind}, 'Come to the concert', ${SLUG},
            ${json(opts.schema)}::text::jsonb, 'OPEN')
    returning id
  `;
  return { concertId, showId, segmentId, formId: Number(row.id) };
}

function publicAnswers(email: string, guests: string[], name = 'Alice Tan'): FormAnswers {
  return {
    registrant: {
      kind: 'flat',
      values: { contact_name: name, contact_email: email, heard_from: '', social_handle: '' },
    },
    party: { kind: 'repeater', rows: guests.map((full_name) => ({ full_name })) },
    extras: {
      kind: 'flat',
      values: { interests: [], instrument: '', newsletter_consent: true },
    },
  };
}

const submit = (answers: FormAnswers, over: Partial<Parameters<typeof submitRegistration>[0]> = {}) =>
  submitRegistration({ slug: SLUG, token: null, schemaVersion: 1, answers, addressConfirmed: false, ...over });

async function parties(segmentId: number) {
  return sql<{ id: number; contact_email: string; approved: boolean; email_issue: string | null }[]>`
    select id::int, contact_email::text, approved_at is not null as approved, email_issue
      from registrations where segment_id = ${segmentId} and deleted_at is null order by id
  `;
}

async function seats(registrationId: number) {
  return sql<{ full_name: string; requested_at: Date }[]>`
    select full_name, requested_at from attendees
     where registration_id = ${registrationId} and deleted_at is null order by id
  `;
}

async function receipts(registrationId: number) {
  return sql<
    {
      id: number;
      status: string;
      scheduled_for: Date | null;
      body_md: string;
      superseded_by_id: number | null;
      template_key: string;
    }[]
  >`
    select id::int, status::text, scheduled_for, body_md, superseded_by_id::int, template_key
      from email_outbox where registration_id = ${registrationId} and purpose = 'RECEIPT'
     order by id
  `;
}

beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
  resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
  requestHeaders.current = new Headers({ 'x-real-ip': '198.51.100.60', 'user-agent': 'vitest' });
  await setSystemSetting('form.rate_limit_per_ip_per_min', 1000);
  await setSystemSetting('form.max_tickets_per_response', 4);
  await setSystemSetting('form.extra_rows_max', 2);
  await setSystemSetting('email.receipt_hold_minutes', 10);
  await setSystemSetting('review.auto_approve_clean', false);
  await setSystemSetting('review.duplicate_name_similarity', 0.8);
});

describe('one party per email per segment (§25.5)', () => {
  it('adds a second submission from the same address to the first party, at the back of the queue', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });

    expect((await submit(publicAnswers('alice@example.test', ['Bob Tan']))).ok).toBe(true);
    // Case differs: citext folds it, and the party is still the same one.
    expect((await submit(publicAnswers('ALICE@example.test', ['Cara Tan']))).ok).toBe(true);

    const rows = await parties(segmentId);
    expect(rows).toHaveLength(1);
    const party = await seats(rows[0].id);
    expect(party.map((s) => s.full_name)).toEqual(['Alice Tan', 'Bob Tan', 'Alice Tan', 'Cara Tan']);
    // §21.3: the later submission's seats carry their own, later time.
    expect(new Date(party[2].requested_at).getTime()).toBeGreaterThan(new Date(party[0].requested_at).getTime());

    const [links] = await sql<{ n: number }[]>`
      select count(*)::int as n from form_responses where registration_id = ${rows[0].id}
    `;
    expect(links.n).toBe(2);
  });

  it('treats the same answers submitted again as the same submission', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    const answers = publicAnswers('alice@example.test', ['Bob Tan']);

    const first = await submit(answers);
    const second = await submit(answers);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.confirmationUrl).toBe(first.confirmationUrl);

    const rows = await parties(segmentId);
    expect(rows).toHaveLength(1);
    expect(await seats(rows[0].id)).toHaveLength(2);
    const [responses] = await sql<{ n: number }[]>`select count(*)::int as n from form_responses`;
    expect(responses.n).toBe(1);
  });

  it('holds the whole party to the party-size cap, not each submission', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    expect((await submit(publicAnswers('alice@example.test', ['Bob Tan', 'Cara Tan']))).ok).toBe(true);

    const over = await submit(publicAnswers('alice@example.test', ['Dan Tan', 'Eve Tan']));
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.message).toMatch(/at most 4/);
    expect(over.message).toMatch(/add 1 more/);

    const rows = await parties(segmentId);
    expect(await seats(rows[0].id)).toHaveLength(3);
  });

  it('keeps parties of different players apart, and flags them as possible duplicates', async () => {
    const { concertId, segmentId } = await seedForm({
      schema: PLAYER_FORM,
      audienceMode: 'PLAYER_INVITED',
      capacity: 50,
      baseQuota: 2,
    });
    const [p1, p2] = await createPlayers(concertId, 2);
    const tokens = await sql<{ id: number; invite_token: string }[]>`
      select id::int, invite_token from players where id in (${p1}, ${p2}) order by id
    `;
    const answers = (guest: string): FormAnswers => ({
      registrant: { kind: 'flat', values: { contact_name: 'Mum', contact_email: 'mum@example.test', contact_phone: '' } },
      base: { kind: 'repeater', rows: [{ full_name: guest, email: '', seat_note: '' }] },
      extras: { kind: 'repeater', rows: [] },
      logistics: { kind: 'flat', values: { transport: 'public', parking_plate: '', accessibility: '' } },
    });

    expect((await submit(answers('Aunt May'), { token: tokens[0].invite_token })).ok).toBe(true);
    expect((await submit(answers('Uncle Ben'), { token: tokens[1].invite_token })).ok).toBe(true);

    const rows = await parties(segmentId);
    expect(rows).toHaveLength(2);
    const [pair] = await sql<{ reasons: string[]; status: string }[]>`
      select reasons, status::text from duplicate_candidates
    `;
    expect(pair.reasons).toContain('EMAIL');
    expect(pair.status).toBe('OPEN');
    const flagged = await sql<{ flag_possible_duplicate: boolean }[]>`
      select flag_possible_duplicate from party_pipeline where segment_id = ${segmentId}
    `;
    expect(flagged.every((f) => f.flag_possible_duplicate)).toBe(true);
  });
});

describe('the receipt (§25.3)', () => {
  it('queues one held receipt carrying the verification link, and no separate verification email', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    const before = Date.now();
    await submit(publicAnswers('alice@example.test', ['Bob Tan']));

    const [party] = await parties(segmentId);
    const [receipt] = await receipts(party.id);
    expect(receipt.status).toBe('QUEUED');
    expect(receipt.template_key).toBe('registration_receipt');
    expect(new Date(receipt.scheduled_for!).getTime()).toBeGreaterThanOrEqual(before + 9 * 60_000);
    expect(receipt.body_md).toMatch(/\/f\/verify\?t=/);
    expect(receipt.body_md).toMatch(/Alice Tan, Bob Tan/);
    expect(receipt.body_md).toMatch(/\/f\/update\?t=/);

    const [verification] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where purpose = 'VERIFICATION'
    `;
    expect(verification.n).toBe(0);
  });

  it('supersedes the held receipt when the same address submits again, so one email covers every seat', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    await submit(publicAnswers('alice@example.test', ['Bob Tan']));
    await submit(publicAnswers('alice@example.test', ['Cara Tan']));

    const [party] = await parties(segmentId);
    const rows = await receipts(party.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('CANCELLED');
    expect(rows[0].superseded_by_id).toBe(rows[1].id);
    expect(rows[1].status).toBe('QUEUED');
    expect(rows[1].body_md).toMatch(/4 seat/);
    expect(rows[1].body_md).toMatch(/Cara Tan/);
  });

  it('sends the receipt on a player form without a verification line', async () => {
    const { concertId, segmentId } = await seedForm({
      schema: PLAYER_FORM,
      audienceMode: 'PLAYER_INVITED',
      capacity: 50,
      baseQuota: 2,
    });
    const [playerId] = await createPlayers(concertId, 1);
    const [player] = await sql<{ invite_token: string }[]>`select invite_token from players where id = ${playerId}`;
    await submit(
      {
        registrant: { kind: 'flat', values: { contact_name: 'Mum', contact_email: 'mum@example.test', contact_phone: '' } },
        base: { kind: 'repeater', rows: [{ full_name: 'Aunt May', email: '', seat_note: '' }] },
        extras: { kind: 'repeater', rows: [] },
        logistics: { kind: 'flat', values: { transport: 'public', parking_plate: '', accessibility: '' } },
      },
      { token: player.invite_token },
    );
    const [party] = await parties(segmentId);
    const [receipt] = await receipts(party.id);
    expect(receipt.status).toBe('QUEUED');
    expect(receipt.body_md).not.toMatch(/verify/);
  });
});

describe('the review gate (§25.4) and the address verdict (§24.6)', () => {
  it('leaves a new party unapproved by default', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    await submit(publicAnswers('alice@example.test', ['Bob Tan']));
    const [party] = await parties(segmentId);
    expect(party.approved).toBe(false);
    const [stage] = await sql<{ stage: string }[]>`
      select stage from party_pipeline where registration_id = ${party.id}
    `;
    expect(stage.stage).toBe('NEEDS_REVIEW');
  });

  it('auto-approves a clean party where the segment says so', async () => {
    const { segmentId } = await seedForm({
      schema: PUBLIC_FORM,
      audienceMode: 'PUBLIC',
      capacity: 50,
      autoApprove: true,
    });
    await submit(publicAnswers('alice@example.test', ['Bob Tan']));
    const [party] = await parties(segmentId);
    expect(party.approved).toBe(true);
  });

  it('stores a suspicious address and keeps that party out of auto-approval', async () => {
    const { segmentId } = await seedForm({
      schema: PUBLIC_FORM,
      audienceMode: 'PUBLIC',
      capacity: 50,
      autoApprove: true,
    });
    const nx = Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' });
    resolveMx.mockRejectedValue(nx);
    lookup.mockRejectedValue(nx);

    const warned = await submit(publicAnswers('alice@nosuchdomain.test', ['Bob Tan']));
    expect(warned.ok).toBe(false);
    const accepted = await submit(publicAnswers('alice@nosuchdomain.test', ['Bob Tan']), { addressConfirmed: true });
    expect(accepted.ok).toBe(true);

    const [party] = await parties(segmentId);
    expect(party.email_issue).toMatch(/mail server/);
    expect(party.approved).toBe(false);
    const [flags] = await sql<{ flags: string[] }[]>`
      select flags from party_pipeline where registration_id = ${party.id}
    `;
    expect(flags.flags).toContain('SUSPICIOUS_ADDRESS');
  });

  it('takes back approval when a submission adds seats to an approved party', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    await submit(publicAnswers('alice@example.test', ['Bob Tan']));
    const [party] = await parties(segmentId);
    await sql`update registrations set approved_at = now() where id = ${party.id}`;

    await submit(publicAnswers('alice@example.test', ['Cara Tan']));
    const [after] = await parties(segmentId);
    expect(after.approved).toBe(false);
  });
});

describe('duplicate detection (§25.5)', () => {
  it('matches by phone across countries, by similar names, and keeps a dismissal', async () => {
    // A one-letter typo scores 0.625 under pg_trgm; the threshold is the admin's.
    await setSystemSetting('review.duplicate_name_similarity', 0.6);
    const concertId = await createConcert();
    const showId = await createShow(concertId, 100);
    const a = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50, name: 'A' });
    const b = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 50, name: 'B' });

    const insert = async (segmentId: number, name: string, email: string, phone: string | null) => {
      const [row] = await sql<{ id: number }[]>`
        insert into registrations (show_id, segment_id, source, contact_name, contact_email, contact_phone, status, requested_at)
        values (${showId}, ${segmentId}, 'ADMIN', ${name}, ${email}, ${phone}, 'WAITLIST', now())
        returning id
      `;
      return Number(row.id);
    };
    const first = await insert(a, 'Jonathan Lim', 'jon@example.test', '+65 9123 4567');
    const second = await insert(b, 'Someone Else', 'other@example.test', '91234567');
    const third = await insert(b, 'Jonathon Lim', 'third@example.test', null);
    const unrelated = await insert(b, 'Priya Nair', 'priya@example.test', '81112222');

    await sql`select refresh_duplicate_candidates(${first})`;
    const pairs = await sql<{ a: number; b: number; reasons: string[] }[]>`
      select registration_a_id::int as a, registration_b_id::int as b, reasons
        from duplicate_candidates order by registration_b_id
    `;
    expect(pairs).toEqual([
      { a: first, b: second, reasons: ['PHONE'] },
      { a: first, b: third, reasons: ['NAME'] },
    ]);
    expect(pairs.some((p) => p.b === unrelated)).toBe(false);

    await sql`update duplicate_candidates set status = 'DISMISSED' where registration_b_id = ${second}`;
    await sql`select refresh_duplicate_candidates(${second})`;
    const [kept] = await sql<{ status: string }[]>`
      select status::text from duplicate_candidates where registration_b_id = ${second}
    `;
    expect(kept.status).toBe('DISMISSED');
  });
});
