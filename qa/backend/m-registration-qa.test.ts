/**
 * QA probes for module `M` — the registration surface.
 * Written from `docs/spec/` (v2.md §8.1–§8.4, allocation.md §7.6/§7.8,
 * email.md §11.4, tickets.md §10.6). Real database, real `claim_seats()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert,
  createSegment,
  createShow,
  json,
  setSystemSetting,
} from '../../tests/helpers/fixtures';
import { PUBLIC_FORM } from '../../tests/forms/fixtures';
import type { FormAnswers } from '@/lib/forms/answers';

const resolveMx = vi.hoisted(() => vi.fn());
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ promises: { resolveMx, lookup } }));
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { submitRegistration } = await import('@/app/(registration)/f/[slug]/actions');
const { applyResponseEdit, requestExtraSeats, loadEditableResponse } = await import(
  '@/lib/registrations/edit'
);

const SLUG = 'qa-m-public';

async function seedForm(opts: {
  capacity: number;
  allowPartialGrant?: boolean;
  allowEditUntil?: string | null;
  extrasPolicy?: 'AUTO_FCFS' | 'REVIEW';
}) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, opts.capacity);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: opts.capacity,
    baseQuota: null,
    extrasPolicy: opts.extrasPolicy ?? 'AUTO_FCFS',
    allowPartialGrant: opts.allowPartialGrant ?? true,
  });
  const [row] = await sql<{ id: number }[]>`
    insert into registration_forms (
      segment_id, kind, title, slug, schema, status, allow_edit_until
    ) values (
      ${segmentId}, 'PUBLIC', 'QA', ${SLUG}, ${json(PUBLIC_FORM)}::text::jsonb, 'OPEN',
      ${opts.allowEditUntil ?? null}
    ) returning id
  `;
  return { concertId, showId, segmentId, formId: Number(row.id) };
}

function answers(email: string, guests: string[]): FormAnswers {
  return {
    registrant: {
      kind: 'flat',
      values: { contact_name: 'Alice Tan', contact_email: email, heard_from: '', social_handle: '' },
    },
    party: { kind: 'repeater', rows: guests.map((full_name) => ({ full_name })) },
    extras: {
      kind: 'flat',
      values: { interests: [], instrument: '', newsletter_consent: true },
    },
  };
}

const submit = (over: Partial<Parameters<typeof submitRegistration>[0]> = {}) =>
  submitRegistration({
    slug: SLUG,
    token: null,
    schemaVersion: 1,
    answers: answers('alice@example.test', ['Bob Tan']),
    addressConfirmed: true,
    ...over,
  });

beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
  resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
  requestHeaders.current = new Headers({ 'x-real-ip': '198.51.100.77', 'user-agent': 'qa' });
  await setSystemSetting('form.rate_limit_per_ip_per_min', 1000);
  await setSystemSetting('form.max_tickets_per_response', 4);
  await setSystemSetting('form.extra_rows_max', 2);
});

/** AC-22 — party larger than remaining capacity, no partial grant. */
describe('AC-22 party larger than remaining capacity', () => {
  it('waitlists the whole party together when allow_partial_grant is false', async () => {
    const { segmentId } = await seedForm({ capacity: 1, allowPartialGrant: false });
    const result = await submit({ answers: answers('alice@example.test', ['Bob', 'Carol']) });
    const rows = await sql<{ status: string }[]>`
      select status::text from attendees where segment_id = ${segmentId}`;
    console.log('AC-22 result', JSON.stringify(result), 'statuses', rows.map((r) => r.status));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status !== 'CONFIRMED')).toBe(true);
  });
});

/** AC-9 — a native form never manufactures a PLACEHOLDER seat. */
describe('AC-9 every seat carries a name', () => {
  it('refuses a guest row with a blank name beside content', async () => {
    const { segmentId } = await seedForm({ capacity: 20 });
    const a = answers('alice@example.test', []);
    a.party = { kind: 'repeater', rows: [{ full_name: '', email: 'someone@example.test' }] };
    const result = await submit({ answers: a });
    const rows = await sql`select * from attendees where segment_id = ${segmentId}`;
    console.log('AC-9', JSON.stringify(result), 'attendees', rows.length);
    expect('ok' in result && result.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it('creates no PLACEHOLDER name_source from a native form', async () => {
    const { segmentId } = await seedForm({ capacity: 20 });
    await submit({ answers: answers('alice@example.test', ['Bob Tan']) });
    const rows = await sql<{ name_source: string }[]>`
      select name_source::text from attendees where segment_id = ${segmentId}`;
    console.log('AC-9b name_source', rows.map((r) => r.name_source));
    expect(rows.every((r) => r.name_source === 'PROVIDED')).toBe(true);
  });
});

/** AC-26 — verification gates the email, never the seat. */
describe('AC-26 submit creates public_verify only, and holds the seats', () => {
  it('confirms the registration, drafts public_verify, drafts no public_ticket', async () => {
    await sql`insert into email_templates (key, name, subject, body_md)
      values ('public_verify','Verify','Confirm {{ show.name }}','Click {{ verify_url }}')
      on conflict (key) do nothing`;
    const { segmentId } = await seedForm({ capacity: 20 });
    await submit();
    const [reg] = await sql<{ status: string; verification_token: string | null; email_verified_at: string | null }[]>`
      select status::text, verification_token, email_verified_at::text
        from registrations where segment_id = ${segmentId}`;
    const outbox = await sql<{ template_key: string; status: string; registration_id: number | null; body_md: string }[]>`
      select template_key, status::text, registration_id, body_md from email_outbox`;
    console.log('AC-26 reg', reg, 'outbox', outbox);
    expect(reg.status).toBe('CONFIRMED');
    expect(reg.verification_token).not.toBeNull();
    expect(reg.email_verified_at).toBeNull();
    expect(outbox.map((o) => o.template_key)).toEqual(['public_verify']);
    expect(outbox[0].registration_id).not.toBeNull();
    expect(outbox[0].status).toBe('DRAFT');
  });
});

/**
 * §8.3.1 / §7.6 — "Once tickets are sent, editing is closed to the registrant;
 * changes go through admin." The edit screen's two actions are `saveEdit` and
 * `requestExtraSeats`; both are server actions reachable with the token alone.
 */
describe('the edit window on the extras path', () => {
  async function partyWithEditToken(capacity: number, allowEditUntil: string | null) {
    const seeded = await seedForm({ capacity, allowEditUntil });
    await submit();
    const [row] = await sql<{ edit_token: string }[]>`select edit_token from form_responses limit 1`;
    return { ...seeded, editToken: row.edit_token };
  }

  it('AC-40/48: refuses requestExtraSeats after allow_edit_until has passed', async () => {
    const { editToken, segmentId } = await partyWithEditToken(20, '2020-01-01T00:00:00Z');
    const before = await sql<{ n: number }[]>`select count(*)::int as n from attendees where segment_id = ${segmentId}`;
    const result = await requestExtraSeats(editToken, ['Sneaky One', 'Sneaky Two']);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from attendees where segment_id = ${segmentId}`;
    const loaded = await loadEditableResponse(editToken);
    console.log('closedReason', loaded?.closedReason, 'result', JSON.stringify(result),
      'attendees before/after', before[0].n, after[0].n);
    expect('error' in result).toBe(true);
    expect(after[0].n).toBe(before[0].n);
  });

  it('AC-44: refuses requestExtraSeats once the party tickets are sent', async () => {
    const { editToken, segmentId } = await partyWithEditToken(20, null);
    await sql`update attendees set ticket_sent_at = now() where segment_id = ${segmentId}`;
    const before = await sql<{ n: number }[]>`select count(*)::int as n from attendees where segment_id = ${segmentId}`;
    const result = await requestExtraSeats(editToken, ['After The Blast']);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from attendees where segment_id = ${segmentId}`;
    console.log('AC-44 result', JSON.stringify(result), 'before/after', before[0].n, after[0].n);
    expect('error' in result).toBe(true);
    expect(after[0].n).toBe(before[0].n);
  });

  it('AC-7: caps the extras request at form.extra_rows_max', async () => {
    const { editToken, segmentId } = await partyWithEditToken(200, null);
    const names = Array.from({ length: 40 }, (_, i) => `Ghost ${i}`);
    const result = await requestExtraSeats(editToken, names);
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees where segment_id = ${segmentId}`;
    console.log('AC-7 extra_rows_max=2, requested 40, result', JSON.stringify(result),
      'attendees now', rows[0].n);
    expect('error' in result).toBe(true);
  });
});

/**
 * `tickets.md` §10.6 — and the resolution QA's finding 6 led to.
 *
 * The reissue flag is **not this screen's**. §8.3.1's own table closes editing
 * to the registrant once tickets are sent, so a party with any live sent seat
 * never reaches the writer at all — the branch that used to flag `needs_reissue`
 * here was unreachable, and the count it returned was always zero because
 * `RETURNING` sees the updated row.
 *
 * Both are gone. §8.3.1 sends the reissue decision to admin
 * (`allocation.md` §7.6), where module `B` already makes it properly:
 * `renameAttendee()` → `flagReissueForChangedFields()`, which checks whether the
 * pinned template actually prints the field rather than assuming every name
 * change matters.
 *
 * What is asserted now is the rule that makes that true: a sent ticket closes
 * the registrant's edit screen.
 */
describe('AC-43 a sent ticket closes editing, so reissue is admin work', () => {
  it('refuses the edit rather than flagging a reissue itself', async () => {
    const { segmentId } = await seedForm({ capacity: 20 });
    await submit({ answers: answers('alice@example.test', ['Bob Tan']) });
    await sql`update attendees set ticket_sent_at = now() where segment_id = ${segmentId}`;

    const [reg] = await sql<{ id: number }[]>`select id from registrations where segment_id = ${segmentId}`;
    const seats = await sql<{ id: number; full_name: string }[]>`
      select id, full_name from attendees where registration_id = ${reg.id} order by id`;
    const [resp] = await sql<{ edit_token: string }[]>`select edit_token from form_responses limit 1`;

    const loaded = await loadEditableResponse(resp.edit_token);
    expect(loaded?.closedReason).toBe('TICKETS_SENT');

    const result = await applyResponseEdit(resp.edit_token, {
      contactName: 'Alice Tan',
      contactPhone: null,
      custom: null,
      seats: seats.map((s) => ({ attendeeId: s.id, fullName: `${s.full_name} Renamed`, email: null })),
      raw: {},
    });
    expect(result).toHaveProperty('error');

    // And nothing was written: the names are untouched.
    const after = await sql<{ full_name: string }[]>`
      select full_name from attendees where registration_id = ${reg.id} order by id`;
    expect(after.map((a) => a.full_name)).toEqual(seats.map((s) => s.full_name));
  });
});


/**
 * allocation.md §7.8 — real contention for the last seat, through the same
 * transaction shape the submit path uses (response + registration + claim).
 * Two independent connections, so the row lock is genuinely contended; the
 * application pool is `max: 1` and would serialise them into a non-test.
 */
describe('AC-21 two concurrent parties race for the last seat', () => {
  it('grants exactly one and never oversells', async () => {
    const postgres = (await import('postgres')).default;
    const { segmentId, showId } = await seedForm({ capacity: 1, allowPartialGrant: false });
    const url = process.env.DATABASE_URL!;

    // The registrations exist first, so the two transactions contend on the
    // `shows` row lock alone. (Creating them inside the transaction deadlocks —
    // see qa/backend/m-deadlock-qa.test.ts, reported separately.)
    const mk = async (who: string) => {
      const [reg] = await sql<{ id: number }[]>`
        insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                                   status, requested_at)
        values (${showId}, ${segmentId}, 'FORM', ${who}, ${who + '@example.test'},
                'WAITLIST', now()) returning id`;
      return Number(reg.id);
    };
    const ra = await mk('racer-a');
    const rb = await mk('racer-b');

    const a = postgres(url, { prepare: false, max: 1 });
    const b = postgres(url, { prepare: false, max: 1 });
    const claim = (conn: ReturnType<typeof postgres>, regId: number, who: string) =>
      conn.begin(async (tx) => {
        const [out] = await tx`select claim_seats(${segmentId}::bigint, ${regId}::bigint,
          ${JSON.stringify([{ full_name: who, email: null, allocation_type: 'EXTRA' }])}::text::jsonb)
          as result`;
        await tx`select pg_sleep(0.2)`;
        return out.result as { granted_extra: number; waitlisted: number };
      });

    const [oa, ob] = await Promise.all([claim(a, ra, 'racer-a'), claim(b, rb, 'racer-b')]);
    await a.end();
    await b.end();
    const rows = await sql<{ status: string }[]>`
      select status::text from attendees where segment_id = ${segmentId}`;
    const confirmed = rows.filter((r) => r.status === 'CONFIRMED').length;
    console.log('AC-21 outcomes', JSON.stringify(oa), JSON.stringify(ob),
      '| confirmed seats in a capacity-1 segment:', confirmed);
    expect(confirmed).toBe(1);
    expect(oa.granted_extra + ob.granted_extra).toBe(1);
  });
});

/** email.md §11.4 — pressing Send twice is still harmless after M's changes. */
describe('AC-37/38 blast idempotency after the verification gate', () => {
  it('queues a verified party once, holds an unverified one, and no-ops on a second press', async () => {
    const { queueBlast, blastSplit } = await import('@/lib/email/queue');
    await sql`insert into email_templates (key, name, subject, body_md)
      values ('public_ticket','Ticket','Your ticket','Hello {{ registration.contact_name }}')
      on conflict (key) do nothing`;
    const { segmentId } = await seedForm({ capacity: 20 });

    await submit({ answers: answers('verified@example.test', ['G1']) });
    await submit({ answers: answers('unverified@example.test', ['G2']) });
    await sql`update registrations set email_verified_at = now()
               where contact_email = 'verified@example.test'`;
    // Ticket-bearing templates need issued tickets, or item 4 of §11.4 holds
    // the whole party back for a different reason.
    const [tpl] = await sql<{ id: number }[]>`
      insert into ticket_templates (concert_id, name, version, background_kind,
                                    page_width_pt, page_height_pt, layout, is_default)
      select c.id, 'QA', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb, false
        from concerts c limit 1 returning id`;
    await sql`update attendees set qr_token = 'qr-' || id::text,
                 ticket_template_id = ${tpl.id}
               where segment_id = ${segmentId}`;

    const split = await blastSplit({ segmentId, templateKey: 'public_ticket' });
    const first = await queueBlast({ segmentId, templateKey: 'public_ticket' });
    const afterFirst = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where template_key = 'public_ticket'`;
    const second = await queueBlast({ segmentId, templateKey: 'public_ticket' });
    const afterSecond = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where template_key = 'public_ticket'`;
    const queuedTo = await sql<{ to_email: string }[]>`
      select to_email from email_outbox where template_key = 'public_ticket'`;

    console.log('AC-37 split', JSON.stringify(split));
    console.log('AC-37 first press', JSON.stringify(first), 'rows', afterFirst[0].n);
    console.log('AC-37 second press', JSON.stringify(second), 'rows', afterSecond[0].n);
    console.log('AC-37 addressed to', queuedTo.map((r) => r.to_email));

    expect(split.heldForVerification).toBe(1);
    expect(afterFirst[0].n).toBe(1);
    expect(afterSecond[0].n).toBe(1);
    expect(queuedTo.map((r) => r.to_email)).toEqual(['verified@example.test']);
  });
});
