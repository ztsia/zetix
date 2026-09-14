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
import { PLAYER_FORM, PUBLIC_FORM } from './fixtures';
import type { FormAnswers } from '@/lib/forms/answers';

/**
 * Submitting `/f/{slug}` (spec/v2.md §8.1–§8.4).
 *
 * **The database is real and `claim_seats()` is the real one.** This action's
 * whole job is to route a party through the engine without inventing a second
 * allocation path (`CLAUDE.md`), so a mocked engine would test the one thing
 * that cannot be allowed to be wrong against a stub of itself.
 *
 * DNS is mocked because the address check is not what these are about; the
 * address behaviour has its own suite in `tests/email/address.test.ts`.
 */

const resolveMx = vi.hoisted(() => vi.fn());
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ promises: { resolveMx, lookup } }));

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { submitRegistration } = await import('@/app/(registration)/f/[slug]/actions');

const SLUG = 'autumn-public';

async function seedForm(opts: {
  schema: typeof PUBLIC_FORM;
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
  capacity: number;
  baseQuota?: number | null;
  maxResponses?: number | null;
  oneResponsePerIdentity?: boolean;
  autoCloseOnCapacity?: boolean;
  status?: 'OPEN' | 'CLOSED';
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
  const [row] = await sql<{ id: number }[]>`
    insert into registration_forms (
      segment_id, kind, title, slug, schema, status,
      max_responses, one_response_per_identity, auto_close_on_capacity
    ) values (
      ${segmentId}, ${opts.schema.kind}, 'Come to the concert', ${SLUG},
      ${json(opts.schema)}::text::jsonb, ${opts.status ?? 'OPEN'},
      ${opts.maxResponses ?? null}, ${opts.oneResponsePerIdentity ?? false},
      ${opts.autoCloseOnCapacity ?? false}
    )
    returning id
  `;
  return { concertId, showId, segmentId, formId: Number(row.id) };
}

/** A public form's answers: the registrant, plus `guests` extra party rows. */
function publicAnswers(email: string, guests: string[]): FormAnswers {
  return {
    registrant: {
      kind: 'flat',
      values: { contact_name: 'Alice Tan', contact_email: email, heard_from: '', social_handle: '' },
    },
    party: { kind: 'repeater', rows: guests.map((full_name) => ({ full_name })) },
    extras: {
      kind: 'flat',
      // Required by the fixture, and correctly refused when missing: a consent
      // box somebody can satisfy by leaving it alone is not a consent box.
      values: { interests: [], instrument: '', newsletter_consent: true },
    },
  };
}

async function attendees(segmentId: number) {
  return sql<{ full_name: string; allocation_type: string; status: string }[]>`
    select full_name, allocation_type::text, status::text
      from attendees where segment_id = ${segmentId} order by id
  `;
}

beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
  // A domain that resolves, so the address check is a no-op unless a test says
  // otherwise. Failing open would hide a bug where the check refuses wrongly.
  resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
  requestHeaders.current = new Headers({ 'x-real-ip': '198.51.100.50', 'user-agent': 'vitest' });

  /**
   * Stated, never defaulted — the same rule the fixtures follow. Without these
   * the repeater caps resolve to nothing and every form refuses to render, which
   * is `limits.ts` behaving correctly and is exactly how these tests first
   * failed. A party cap of 4 renders three guest rows (decision 36).
   */
  await setSystemSetting('form.rate_limit_per_ip_per_min', 1000);
  await setSystemSetting('form.max_tickets_per_response', 4);
  await setSystemSetting('form.extra_rows_max', 2);
});

const submit = (over: Partial<Parameters<typeof submitRegistration>[0]> = {}) =>
  submitRegistration({
    slug: SLUG,
    token: null,
    schemaVersion: 1,
    answers: publicAnswers('alice@example.test', ['Bob Tan']),
    addressConfirmed: false,
    ...over,
  });

describe('submitRegistration — the public form', () => {
  /**
   * **Decision 36.** The REGISTRANT block carries `creates_seat`, so the person
   * filling the form is seat #1 and a cap of 4 renders three guest rows. Getting
   * this wrong under-issues one ticket per party, and it is noticed when someone
   * reaches the door with nothing.
   */
  it('makes the registrant seat #1 alongside the guests', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });

    const result = await submit({ answers: publicAnswers('alice@example.test', ['Bob Tan', 'Cara Tan']) });
    expect(result.ok).toBe(true);

    const rows = await attendees(segmentId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.full_name)).toEqual(['Alice Tan', 'Bob Tan', 'Cara Tan']);
  });

  /** §8.1.2 — a PUBLIC segment has no base, and no new allocation type exists. */
  it('books every public seat as EXTRA', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    await submit({ answers: publicAnswers('alice@example.test', ['Bob Tan']) });

    const rows = await attendees(segmentId);
    expect(rows.every((r) => r.allocation_type === 'EXTRA')).toBe(true);
  });

  it('records the party through claim_seats(), not around it', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    await submit();

    const [reg] = await sql<{ source: string; status: string; form_response_id: number | null }[]>`
      select source::text, status::text, form_response_id from registrations
       where segment_id = ${segmentId}
    `;
    expect(reg.source).toBe('FORM');
    expect(reg.status).toBe('CONFIRMED');
    // §8.3.1: the registration points at its newest response. The edit flow and
    // the confirmation screen both resolve through this link.
    expect(reg.form_response_id).not.toBeNull();
  });

  /**
   * **Oversell must be impossible** (`CLAUDE.md`). The form's caps are advisory
   * and this proves the engine, not the action, is what decides.
   */
  it('cannot oversell the segment, whatever the form offered', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 2 });

    const result = await submit({
      answers: publicAnswers('alice@example.test', ['Bob Tan', 'Cara Tan', 'Dan Tan']),
    });
    expect(result.ok).toBe(true);

    const rows = await attendees(segmentId);
    const confirmed = rows.filter((r) => r.status === 'CONFIRMED');
    expect(confirmed).toHaveLength(2);
    // The rest exist and are honest about what they are, rather than vanishing.
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.some((r) => r.status === 'WAITLIST')).toBe(true);
  });

  it('pins the schema and keeps raw exactly as submitted', async () => {
    const { formId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    const answers = publicAnswers('alice@example.test', ['Bob Tan']);
    await submit({ answers });

    const [row] = await sql<{ raw: unknown; form_schema: { kind: string } }[]>`
      select raw, form_schema from form_responses where form_id = ${formId}
    `;
    expect(row.raw).toEqual(answers);
    expect(row.form_schema.kind).toBe('PUBLIC');
  });

  /**
   * **Every custom answer in the flat scope, not just the REGISTRANT block's.**
   * `PUBLIC_FORM` keeps its interesting questions in a separate `CUSTOM` block,
   * which is the normal shape — gathering only the registrant block would leave
   * those answers in `raw` and blank in every export and admin filter, with
   * nothing to report it.
   */
  it('writes custom answers from every flat block to the queryable copy', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    const answers = publicAnswers('alice@example.test', ['Bob Tan']);
    (answers.registrant as { kind: 'flat'; values: Record<string, unknown> }).values.heard_from =
      'poster';
    (answers.extras as { kind: 'flat'; values: Record<string, unknown> }).values.instrument =
      'Viola';
    await submit({ answers });

    const [reg] = await sql<{ custom: Record<string, unknown> | null }[]>`
      select custom from registrations where segment_id = ${segmentId}
    `;
    expect(reg.custom).toMatchObject({ heard_from: 'poster', instrument: 'Viola' });
  });

  /** An "add" button pressed once too often is not a person. */
  it('does not book an entirely blank guest row as a seat', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    const answers = publicAnswers('alice@example.test', ['Bob Tan']);
    (answers.party as { kind: 'repeater'; rows: Record<string, unknown>[] }).rows.push({
      full_name: '   ',
    });
    await submit({ answers });

    expect(await attendees(segmentId)).toHaveLength(2);
  });
});

describe('submitRegistration — the player form', () => {
  it('books base rows as BASE and extra rows as EXTRA', async () => {
    const { concertId, segmentId } = await seedForm({
      schema: PLAYER_FORM,
      audienceMode: 'PLAYER_INVITED',
      capacity: 50,
      baseQuota: 2,
    });
    await createPlayers(concertId, 1);

    const result = await submitRegistration({
      slug: SLUG,
      token: `tok-${concertId}-1`,
      schemaVersion: 1,
      addressConfirmed: false,
      answers: {
        registrant: {
          kind: 'flat',
          values: { contact_name: 'Player 1', contact_email: 'p1@example.test', contact_phone: '' },
        },
        base: { kind: 'repeater', rows: [{ full_name: 'Guest A', email: '', seat_note: '' }] },
        extras: { kind: 'repeater', rows: [{ full_name: 'Guest B', email: '' }] },
        // The fixture's custom block, whose radio is required.
        logistics: { kind: 'flat', values: { transport: 'car', parking_plate: '', accessibility: '' } },
      } as FormAnswers,
    });
    expect(result.ok).toBe(true);

    const rows = await attendees(segmentId);
    expect(rows.find((r) => r.full_name === 'Guest A')?.allocation_type).toBe('BASE');
    expect(rows.find((r) => r.full_name === 'Guest B')?.allocation_type).toBe('EXTRA');
    // The player is a performer, not audience (decision 3): `creates_seat` is
    // false on a player form, so they take no seat of their own.
    expect(rows.some((r) => r.full_name === 'Player 1')).toBe(false);
  });
});

describe('submitRegistration — response limiting (§8.3)', () => {
  it('refuses a closed form', async () => {
    await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50, status: 'CLOSED' });
    const result = await submit();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/closed/i);
  });

  it('refuses once max_responses is reached', async () => {
    await seedForm({
      schema: PUBLIC_FORM,
      audienceMode: 'PUBLIC',
      capacity: 50,
      maxResponses: 1,
    });
    expect((await submit({ answers: publicAnswers('a@example.test', []) })).ok).toBe(true);

    const second = await submit({ answers: publicAnswers('b@example.test', []) });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toMatch(/limit of responses/i);
  });

  /**
   * **The database refuses this, not a query.** A read-then-write check is a
   * race at exactly the moment scarce seats attract double-clicks, which is the
   * same reasoning that makes `claim_seats()` a Postgres function.
   */
  it('refuses a second response from one identity when the form asks for it', async () => {
    await seedForm({
      schema: PUBLIC_FORM,
      audienceMode: 'PUBLIC',
      capacity: 50,
      oneResponsePerIdentity: true,
    });
    expect((await submit({ answers: publicAnswers('alice@example.test', []) })).ok).toBe(true);

    const second = await submit({ answers: publicAnswers('alice@example.test', []) });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toMatch(/already registered/i);
  });

  /** `citext`, so the case folding is the column's job and not the handler's. */
  it('treats a differently-cased email as the same identity', async () => {
    await seedForm({
      schema: PUBLIC_FORM,
      audienceMode: 'PUBLIC',
      capacity: 50,
      oneResponsePerIdentity: true,
    });
    expect((await submit({ answers: publicAnswers('alice@example.test', []) })).ok).toBe(true);

    const second = await submit({ answers: publicAnswers('ALICE@example.test', []) });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    // Asserted by message, not merely by failure: `ok: false` is satisfied by
    // any refusal at all, so without this the test passed while the identity
    // index was being reported as "something went wrong".
    expect(second.message).toMatch(/already registered/i);
  });

  /**
   * The mirror image, and the reason `identity_key` is null rather than always
   * written: a form that does not limit by identity must take two responses
   * from one person.
   */
  it('allows a second response when the form does not limit by identity', async () => {
    await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    expect((await submit({ answers: publicAnswers('alice@example.test', []) })).ok).toBe(true);
    expect((await submit({ answers: publicAnswers('alice@example.test', []) })).ok).toBe(true);
  });

  it('closes the form on the submit that fills it when auto_close_on_capacity is set', async () => {
    const { formId } = await seedForm({
      schema: PUBLIC_FORM,
      audienceMode: 'PUBLIC',
      capacity: 2,
      autoCloseOnCapacity: true,
    });
    await submit({ answers: publicAnswers('alice@example.test', ['Bob Tan']) });

    const [form] = await sql<{ status: string }[]>`
      select status::text from registration_forms where id = ${formId}
    `;
    expect(form.status).toBe('CLOSED');
  });

  /**
   * Validating a payload against a schema the reader never saw would report
   * errors on questions that were not on their screen, and pin a schema whose
   * meaning does not match their answers (§8.2.4).
   */
  it('refuses when the schema changed under the reader', async () => {
    await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    const result = await submit({ schemaVersion: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/reload/i);
  });

  /** Over the cap is an error, never a truncation (`K`'s contract). */
  it('refuses a party over the row cap instead of dropping the last guest', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 99 });
    await setSystemSetting('form.max_tickets_per_response', 2);

    const result = await submit({
      answers: publicAnswers('alice@example.test', ['Bob Tan', 'Cara Tan', 'Dan Tan']),
    });
    expect(result.ok).toBe(false);
    expect(await attendees(segmentId)).toHaveLength(0);
  });
});

describe('submitRegistration — the address check', () => {
  /**
   * Refused once, accepted on the retry. A domain DNS is certain does not exist
   * cannot receive the tickets, and the person is right there able to fix it —
   * but a resolver can be wrong and a scarce seat is too much to lose to one
   * DNS answer.
   */
  it('refuses a non-existent domain the first time and takes it the second', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    resolveMx.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    lookup.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));

    const first = await submit({ answers: publicAnswers('alice@gmail.con', []) });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.addressWarning).toBe(true);
    expect(await attendees(segmentId)).toHaveLength(0);

    const second = await submit({
      answers: publicAnswers('alice@gmail.con', []),
      addressConfirmed: true,
    });
    expect(second.ok).toBe(true);
    expect(await attendees(segmentId)).toHaveLength(1);
  });

  /** Fail open: a resolver that cannot answer must never cost a registration. */
  it('takes the registration when DNS is merely unreachable', async () => {
    const { segmentId } = await seedForm({ schema: PUBLIC_FORM, audienceMode: 'PUBLIC', capacity: 50 });
    resolveMx.mockRejectedValue(Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }));
    lookup.mockRejectedValue(Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }));

    const result = await submit({ answers: publicAnswers('alice@example.test', []) });
    expect(result.ok).toBe(true);
    expect(await attendees(segmentId)).toHaveLength(1);
  });
});
