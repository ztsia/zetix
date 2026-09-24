import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Submitting feedback (spec/v2.md §13.5).
 *
 * **The property under test is that the action trusts nothing but the token.**
 * The client sends a token and a payload; every gate the section draws itself
 * behind is re-asked here, because a URL is not a button and a Server Action is
 * reachable without ever loading the page.
 *
 * The database is real. `revalidatePath` is the only stub — it needs a request
 * scope these tests do not have, and it is not what any of this is testing.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { parseFormSchema } = await import('@/lib/forms/schema');

const { submitFeedbackAction } = await import('@/app/(portal)/t/[token]/feedback-actions');
const { issueTickets } = await import('@/lib/tickets/issue');

let concertId: number;
let showId: number;
let segmentId: number;
let attendeeId: number;
let token: string;
let formId: number;

const SCHEMA = {
  kind: 'FEEDBACK',
  blocks: [
    {
      id: 'feedback',
      type: 'CUSTOM',
      title: 'How was your evening?',
      fields: [
        { key: 'highlight', type: 'textarea', label: 'What stayed with you?', required: true },
        { key: 'again', type: 'checkbox', label: 'Would you come again?' },
      ],
    },
  ],
};

const ANSWER = { feedback: { highlight: 'The encore.', again: true } };

/**
 * How `validateAnswers` normalises a flat block before it is stored: coerced to
 * the declared types, hidden and unknown keys dropped, and tagged with the block
 * kind. Asserting the raw payload instead would be asserting what the client
 * sent rather than what was kept.
 */
const asStored = (values: Record<string, unknown>) => ({
  feedback: { kind: 'flat', values },
});

/** Everything configured so that a submit should succeed. Each test breaks one thing. */
async function configureForSuccess(): Promise<void> {
  await setSetting('portal.enabled', true);
  await setSetting('portal.unlock_mode', 'OPEN_TO_ALL');
  await setSetting('portal.feedback_enabled', true);
  await setSetting('show.auto_complete_after_hours', 2);
  await sql`update shows set ends_at = now() - interval '3 hours' where id = ${showId}`;
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await sql`
    insert into system_settings (key, value)
    values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Submit');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId, showId, segmentId, count: 1, allocationType: 'BASE',
  });
  await issueTickets({ concertId, showId });

  const rows = await sql<{ id: string; qr_token: string }[]>`
    select id, qr_token from attendees
  `;
  attendeeId = Number(rows[0].id);
  token = rows[0].qr_token;

  const formRows = await sql<{ id: string }[]>`
    insert into registration_forms (show_id, kind, slug, title, status, schema, schema_version)
    values (${showId}, 'FEEDBACK', 'feedback', 'How was your evening?', 'OPEN',
            ${JSON.stringify(SCHEMA)}::jsonb, 1)
    returning id
  `;
  formId = Number(formRows[0].id);

  await configureForSuccess();
});

const stored = () => sql<{ answers: unknown; form_schema: unknown; attendee_id: string }[]>`
  select answers, form_schema, attendee_id from feedback_responses
`;

describe('the happy path', () => {
  it('stores the answer against this attendee', async () => {
    const result = await submitFeedbackAction(token, ANSWER);
    expect(result).toEqual({ ok: true, errors: {} });

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].attendee_id)).toBe(attendeeId);
    expect(rows[0].answers).toEqual(asStored({ highlight: 'The encore.', again: true }));
  });

  it('pins the schema the answer was given against', async () => {
    /**
     * §8.2.4. An admin editing the questions afterwards must not reshape what an
     * answer already given meant — the export builds its columns from this copy.
     */
    await submitFeedbackAction(token, ANSWER);
    const rows = await stored();
    /**
     * The *parsed* schema, not the literal above — `parseFormSchema` fills in
     * declared defaults, and pinning the normalised form is what makes the
     * export's columns stable.
     */
    const parsed = parseFormSchema(SCHEMA);
    expect(parsed.ok && rows[0].form_schema).toEqual(parsed.ok ? parsed.schema : null);
  });

  it('reports field errors rather than storing a partial answer', async () => {
    const result = await submitFeedbackAction(token, { feedback: { again: true } });
    expect(result.ok).toBe(false);
    expect(result.errors['feedback.highlight']).toBeTruthy();
    expect(await stored()).toHaveLength(0);
  });
});

describe('one response per attendee', () => {
  it('a second submit edits the same row rather than adding one', async () => {
    await submitFeedbackAction(token, ANSWER);
    const second = await submitFeedbackAction(token, {
      feedback: { highlight: 'Actually, the slow movement.', again: false },
    });
    expect(second.ok).toBe(true);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].answers).toEqual(
      asStored({ highlight: 'Actually, the slow movement.', again: false }),
    );
  });

  it('two simultaneous submits still leave one row', async () => {
    /**
     * The unique index is what makes this true, not the read above it. A
     * check-then-insert would race; the upsert lands on the conflict target.
     */
    const [a, b] = await Promise.all([
      submitFeedbackAction(token, ANSWER),
      submitFeedbackAction(token, ANSWER),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await stored()).toHaveLength(1);
  });
});

describe('every gate the section draws itself behind is re-asked', () => {
  const refused = async (payload: unknown = ANSWER) => {
    const result = await submitFeedbackAction(token, payload);
    expect(result.ok).toBe(false);
    expect(await stored()).toHaveLength(0);
  };

  it('refuses a token that names nothing', async () => {
    const result = await submitFeedbackAction('ZzZzZzZzZzZzZzZzZzZzZz', ANSWER);
    expect(result.ok).toBe(false);
    expect(await stored()).toHaveLength(0);
  });

  it('refuses while the show is not yet over', async () => {
    /**
     * §13.2's second row: an admitted guest whose show is still running gets no
     * feedback form, because the question has no answer yet. The phase comes off
     * the clock, so this needs no flag (decision 40).
     */
    await sql`update shows set ends_at = now() + interval '3 hours' where id = ${showId}`;
    await refused();
  });

  it('refuses when the show has no end time at all', async () => {
    /** Decision 41: no `ends_at`, no post-show phase, ever. */
    await sql`update shows set ends_at = null where id = ${showId}`;
    await refused();
  });

  it('refuses when the portal is switched off for the concert', async () => {
    await setSetting('portal.enabled', false);
    await refused();
  });

  it('refuses when the show does not run feedback', async () => {
    await setSetting('portal.feedback_enabled', false);
    await refused();
  });

  it('refuses when unlock_mode is CLOSED', async () => {
    await setSetting('portal.unlock_mode', 'CLOSED');
    await refused();
  });

  it('refuses an unadmitted guest under ON_ADMISSION', async () => {
    await setSetting('portal.unlock_mode', 'ON_ADMISSION');
    await refused();
  });

  it('accepts an admitted guest under ON_ADMISSION', async () => {
    await setSetting('portal.unlock_mode', 'ON_ADMISSION');
    await sql`
      insert into check_ins (attendee_id, show_id, scanned_at, source)
      values (${attendeeId}, ${showId}, now(), 'ONLINE')
    `;
    expect((await submitFeedbackAction(token, ANSWER)).ok).toBe(true);
  });

  it('refuses a cancelled ticket', async () => {
    await sql`update attendees set status = 'CANCELLED' where id = ${attendeeId}`;
    await refused();
  });

  it('refuses once portal.feedback_close_at has passed', async () => {
    await setSetting('portal.feedback_close_at', '2020-01-01T00:00:00Z');
    await refused();
  });

  it('refuses while the form is still a DRAFT', async () => {
    await sql`update registration_forms set status = 'DRAFT' where id = ${formId}`;
    await refused();
  });
});

describe('the payload cannot choose its own form or identity', () => {
  it('ignores an attendee_id in the payload', async () => {
    /**
     * §13.5: the identity is resolved from the attendee's own `qr_token`. A
     * payload claiming to be someone else has nothing to claim it with — the
     * key is derived, never read.
     */
    const otherSegment = await createSegment(showId, {
      capacity: 50, audienceMode: 'PLAYER_INVITED',
    });
    const otherReg = await createRegistration({ showId, segmentId: otherSegment });
    await seedAttendees({
      registrationId: otherReg, showId, segmentId: otherSegment, count: 1,
      allocationType: 'BASE',
    });
    const [other] = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${otherReg}
    `;

    await submitFeedbackAction(token, { ...ANSWER, attendee_id: Number(other.id) });

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].attendee_id)).toBe(attendeeId);
  });

  it('writes against the show s own form, not one named in the payload', async () => {
    const otherShow = await createShow(concertId, 100);
    const otherForm = await sql<{ id: string }[]>`
      insert into registration_forms (show_id, kind, slug, title, status, schema, schema_version)
      values (${otherShow}, 'FEEDBACK', 'other', 'Elsewhere', 'OPEN',
              ${JSON.stringify(SCHEMA)}::jsonb, 1)
      returning id
    `;

    await submitFeedbackAction(token, { ...ANSWER, form_id: Number(otherForm[0].id) });

    const rows = await sql<{ form_id: string }[]>`select form_id from feedback_responses`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].form_id)).toBe(formId);
  });
});
