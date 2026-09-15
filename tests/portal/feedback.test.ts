import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';
import { loadPortalFeedback } from '@/lib/portal/feedback';

/**
 * The post-show feedback form, as the portal loads it (spec/v2.md §13.5).
 *
 * The submit path is covered in `feedback-submit.test.ts`; this is the loader,
 * whose job is to decide between "no form", "a closed form" and "the form" —
 * three outcomes that a null return would collapse into one silence.
 */

const { issueTickets } = await import('@/lib/tickets/issue');

let concertId: number;
let showId: number;
let attendeeId: number;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Feedback');
  showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId, showId, segmentId, count: 1, allocationType: 'BASE',
  });
  await issueTickets({ concertId, showId });

  const rows = await sql<{ id: string }[]>`select id from attendees`;
  attendeeId = Number(rows[0].id);
});

const SCHEMA = {
  kind: 'FEEDBACK',
  blocks: [
    {
      id: 'feedback',
      type: 'CUSTOM',
      title: 'How was your evening?',
      fields: [
        { key: 'highlight', type: 'textarea', label: 'What stayed with you?', required: true },
      ],
    },
  ],
};

async function createFeedbackForm(overrides: {
  status?: string;
  showId?: number | null;
  schema?: unknown;
} = {}): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    insert into registration_forms
      (show_id, segment_id, kind, slug, title, status, schema, schema_version)
    values (
      ${overrides.showId === undefined ? showId : overrides.showId},
      null,
      'FEEDBACK',
      ${`feedback-${Math.random().toString(36).slice(2, 10)}`},
      'How was your evening?',
      ${overrides.status ?? 'OPEN'},
      ${JSON.stringify(overrides.schema ?? SCHEMA)}::jsonb,
      1
    )
    returning id
  `;
  return Number(rows[0].id);
}

const load = (closeAt: Date | null = null, now?: Date) =>
  loadPortalFeedback({ showId, concertId, attendeeId, closeAt, now });

describe('finding the form', () => {
  it('reports NONE when the show runs no feedback form', async () => {
    expect(await load()).toEqual({ state: 'NONE' });
  });

  it('returns the form when one is OPEN on this show', async () => {
    const formId = await createFeedbackForm();
    const result = await load();
    expect('id' in result && result.id).toBe(formId);
  });

  it('does not show a DRAFT form', async () => {
    /**
     * An admin building next month's questions must not have them appear on
     * tonight's portal — the same refusal `loadFormBySlug` makes.
     */
    await createFeedbackForm({ status: 'DRAFT' });
    expect(await load()).toEqual({ state: 'NONE' });
  });

  it('does not show a CLOSED form', async () => {
    await createFeedbackForm({ status: 'CLOSED' });
    expect(await load()).toEqual({ state: 'NONE' });
  });

  it('does not show another show s form', async () => {
    const otherShowId = await createShow(concertId, 100);
    await createFeedbackForm({ showId: otherShowId });
    expect(await load()).toEqual({ state: 'NONE' });
  });

  it('treats an unparseable schema as no form rather than half a form', async () => {
    /**
     * A FEEDBACK form may carry no seat blocks — the zod contract refuses them.
     * Rendering half of an invalid schema is how a form asks a question it
     * cannot store the answer to.
     */
    await createFeedbackForm({
      schema: { kind: 'FEEDBACK', blocks: [{ id: 'party', type: 'GUESTS_PARTY', guest_fields: [] }] },
    });
    expect(await load()).toEqual({ state: 'NONE' });
  });
});

describe('portal.feedback_close_at', () => {
  it('serves the form before the closing time', async () => {
    await createFeedbackForm();
    const result = await load(new Date('2030-01-01T00:00:00Z'));
    expect('id' in result).toBe(true);
  });

  it('reports CLOSED after it, rather than going silent', async () => {
    /**
     * The guest followed a link from an email we sent them. "We have stopped
     * collecting answers" is an answer; an empty page where the form was is not.
     */
    await createFeedbackForm();
    expect(await load(new Date('2020-01-01T00:00:00Z'))).toEqual({ state: 'CLOSED' });
  });

  it('has no closing time when the setting resolves to nothing', async () => {
    await createFeedbackForm();
    const result = await load(null);
    expect('id' in result).toBe(true);
  });
});

describe('an answer this attendee has already left', () => {
  it('comes back with the form, so the section can prefill it', async () => {
    const formId = await createFeedbackForm();
    await sql`
      insert into feedback_responses (form_id, attendee_id, show_id, answers, form_schema)
      values (${formId}, ${attendeeId}, ${showId},
              ${JSON.stringify({ feedback: { highlight: 'The encore.' } })}::jsonb,
              ${JSON.stringify(SCHEMA)}::jsonb)
    `;
    const result = await load();
    expect('existing' in result && result.existing?.answers).toEqual({
      feedback: { highlight: 'The encore.' },
    });
  });

  it('does not hand this attendee somebody else s answer', async () => {
    const formId = await createFeedbackForm();
    const segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PLAYER_INVITED' });
    const otherReg = await createRegistration({ showId, segmentId });
    await seedAttendees({
      registrationId: otherReg, showId, segmentId, count: 1, allocationType: 'BASE',
    });
    const [other] = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${otherReg}
    `;

    await sql`
      insert into feedback_responses (form_id, attendee_id, show_id, answers, form_schema)
      values (${formId}, ${Number(other.id)}, ${showId},
              ${JSON.stringify({ feedback: { highlight: 'Not yours.' } })}::jsonb,
              ${JSON.stringify(SCHEMA)}::jsonb)
    `;

    const result = await load();
    expect('existing' in result && result.existing).toBeNull();
  });
});
