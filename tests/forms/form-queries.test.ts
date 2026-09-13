import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createSegment,
  createShow,
  json,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * The read layer and the exporter's database half (spec/v2.md §8.5).
 *
 * `tests/forms/export.test.ts` proves the *shaping* rules against pure input.
 * This file covers the wiring underneath them, which is where the defects
 * actually were:
 *
 * - the joins, which must reach a `FEEDBACK` form through `show_id` where
 *   every other form is reached through its segment — an inner join on
 *   `show_segments` returns "no such form" for every feedback form, which is
 *   the bug `K` found in its own loader the day `J` made `segment_id` nullable
 * - reading a payload **through its pinned schema**, since a block id belongs
 *   to the form that was built and no fixed path is safe
 * - the row formatter, which returned a 500 for a form with any responses
 *   because it lived in a `'use client'` module. With zero rows the `.map`
 *   never ran, so the whole suite, `tsc`, `lint` and `build` stayed green while
 *   the screen was broken. Hence {@link formatting a page of rows} below.
 */

vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect');
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const { getForm, getFormParents, getFormsForConcert, getResponses } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/forms/queries'
);
const { responseRow } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/forms/[formId]/responses/rows'
);
const { buildFormExportAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/forms/[formId]/responses/export-actions'
);
const { blankFormSchema } = await import('@/lib/forms/templates');

async function asAdmin() {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, role, is_active)
    values (${id}::uuid, ${`admin-${id}@example.test`}, 'ADMIN', true)
  `;
  sessionUser.mockResolvedValue({ id, email: 'admin@example.test', role: 'ADMIN' });
  return id;
}

async function insertForm(opts: {
  kind: 'PLAYER' | 'PUBLIC' | 'FEEDBACK';
  segmentId?: number;
  showId?: number;
  title?: string;
  slug?: string;
  schema?: unknown;
}): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into registration_forms (kind, segment_id, show_id, title, slug, schema, schema_version, status)
    values (
      ${opts.kind},
      ${opts.segmentId ?? null},
      ${opts.showId ?? null},
      ${opts.title ?? 'A form'},
      ${opts.slug ?? `slug-${randomUUID().slice(0, 8)}`},
      ${json(opts.schema ?? blankFormSchema(opts.kind))}::text::jsonb,
      1,
      'DRAFT'
    )
    returning id
  `;
  return Number(row.id);
}

async function insertResponse(opts: {
  formId: number;
  schema: unknown;
  raw: unknown;
  identityKey?: string | null;
  supersedesId?: number | null;
  submittedAt?: string;
}): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into form_responses (form_id, raw, form_schema, identity_key, supersedes_id, submitted_at)
    values (
      ${opts.formId},
      ${json(opts.raw)}::text::jsonb,
      ${json(opts.schema)}::text::jsonb,
      ${opts.identityKey ?? null},
      ${opts.supersedesId ?? null},
      ${opts.submittedAt ?? '2026-09-01T02:00:00Z'}
    )
    returning id
  `;
  return Number(row.id);
}

async function scenario() {
  const concertId = await createConcert(`Q ${randomUUID().slice(0, 8)}`);
  const showId = await createShow(concertId, 400);
  const publicSegment = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 200 });
  const playerSegment = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 100,
    baseQuota: 2,
  });
  return { concertId, showId, publicSegment, playerSegment };
}

/** A payload as `answers.ts` writes it, for a public form built from the template. */
function publicPayload(name: string, email: string, guests: string[]) {
  return {
    registrant: { kind: 'flat', values: { contact_name: name, contact_email: email } },
    party: { kind: 'repeater', rows: guests.map((full_name) => ({ full_name })) },
  };
}

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
});

describe('a feedback form is reached through its show, not a segment', () => {
  it('appears in the concert list beside the registration forms', async () => {
    const { concertId, showId, publicSegment } = await scenario();
    await insertForm({ kind: 'PUBLIC', segmentId: publicSegment, title: 'Register' });
    await insertForm({ kind: 'FEEDBACK', showId, title: 'How was it' });

    const forms = await getFormsForConcert(concertId);

    // An inner join on `show_segments` would silently drop the feedback form.
    expect(forms.map((form) => form.kind).sort()).toEqual(['FEEDBACK', 'PUBLIC']);
    const feedback = forms.find((form) => form.kind === 'FEEDBACK')!;
    expect(feedback.segmentId).toBeNull();
    expect(feedback.showId).toBe(showId);
    expect(feedback.showName).toBeTruthy();
  });

  it('loads on its own, with no segment', async () => {
    const { concertId, showId } = await scenario();
    const formId = await insertForm({ kind: 'FEEDBACK', showId });

    const form = await getForm(concertId, formId);
    expect(form).not.toBeNull();
    expect(form!.segmentId).toBeNull();
    expect(form!.kind).toBe('FEEDBACK');
  });

  it('is not visible from another concert', async () => {
    const { showId } = await scenario();
    const other = await createConcert(`Other ${randomUUID().slice(0, 8)}`);
    const formId = await insertForm({ kind: 'FEEDBACK', showId });

    expect(await getForm(other, formId)).toBeNull();
  });
});

describe('the response count on the list', () => {
  it('counts this form’s responses and no others', async () => {
    const { concertId, publicSegment } = await scenario();
    const mine = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment, title: 'Mine' });
    const other = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment, title: 'Other' });
    const schema = blankFormSchema('PUBLIC');

    for (let i = 0; i < 3; i += 1) {
      await insertResponse({ formId: mine, schema, raw: publicPayload(`P${i}`, `p${i}@x.test`, []) });
    }
    await insertResponse({ formId: other, schema, raw: publicPayload('Q', 'q@x.test', []) });

    const forms = await getFormsForConcert(concertId);
    const byTitle = Object.fromEntries(forms.map((form) => [form.title, form.responses]));

    // The count is a correlated subquery, and an unqualified outer reference
    // made it compare `form_id` against the response's own `id` — which is
    // silently wrong rather than an error.
    expect(byTitle).toEqual({ Mine: 3, Other: 1 });
    expect((await getForm(concertId, mine))!.responses).toBe(3);
  });

  it('is zero for a form nobody has answered', async () => {
    const { concertId, publicSegment } = await scenario();
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });
    expect((await getForm(concertId, formId))!.responses).toBe(0);
  });
});

describe('the create dialog’s parent list', () => {
  it('carries each segment’s audience, so a kind can be paired with it', async () => {
    const { concertId } = await scenario();
    const parents = await getFormParents(concertId);

    expect(parents).toHaveLength(1);
    expect(parents[0].segments.map((segment) => segment.audienceMode).sort()).toEqual([
      'PLAYER_INVITED',
      'PUBLIC',
    ]);
  });
});

describe('reading a response through its pinned schema', () => {
  it('finds the registrant’s details whatever the block is called', async () => {
    const { publicSegment } = await scenario();
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });

    // A block id belongs to the form that was built, so a fixed
    // `raw.registrant.…` path would read nothing here.
    const schema = blankFormSchema('PUBLIC');
    schema.blocks[0].id = 'about_you';
    const raw = {
      about_you: { kind: 'flat', values: { contact_name: 'Ada Tan', contact_email: 'ada@x.test' } },
      party: { kind: 'repeater', rows: [{ full_name: 'Bo' }] },
    };

    await insertResponse({ formId, schema, raw });
    const { rows } = await getResponses(formId, {
      pageIndex: 0,
      pageSize: 25,
      sort: 'submittedAt',
      desc: true,
      search: '',
    });

    expect(rows[0].contactName).toBe('Ada Tan');
    expect(rows[0].contactEmail).toBe('ada@x.test');
  });

  it('counts the registrant as seat #1 on a public form (decision 36)', async () => {
    const { publicSegment } = await scenario();
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });
    const schema = blankFormSchema('PUBLIC');

    await insertResponse({ formId, schema, raw: publicPayload('Ada', 'ada@x.test', ['Bo', 'Cy']) });
    const { rows } = await getResponses(formId, {
      pageIndex: 0,
      pageSize: 25,
      sort: 'submittedAt',
      desc: true,
      search: '',
    });

    // Two guests plus the registrant's own seat. Leaving the registrant out
    // under-reports every public party by exactly one.
    expect(rows[0].seats).toBe(3);
  });

  it('does not count a registrant seat on a player form (decision 3)', async () => {
    const { playerSegment } = await scenario();
    const formId = await insertForm({ kind: 'PLAYER', segmentId: playerSegment });
    const schema = blankFormSchema('PLAYER');

    await insertResponse({
      formId,
      schema,
      raw: {
        registrant: { kind: 'flat', values: { contact_name: 'Player', contact_email: 'p@x.test' } },
        base_seats: { kind: 'repeater', rows: [{ full_name: 'Guest one' }, { full_name: 'Guest two' }] },
      },
    });

    const { rows } = await getResponses(formId, {
      pageIndex: 0,
      pageSize: 25,
      sort: 'submittedAt',
      desc: true,
      search: '',
    });
    expect(rows[0].seats).toBe(2);
  });
});

describe('paging, sorting and searching happen in Postgres', () => {
  async function seedResponses(count: number) {
    const { publicSegment } = await scenario();
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });
    const schema = blankFormSchema('PUBLIC');

    for (let i = 0; i < count; i += 1) {
      await insertResponse({
        formId,
        schema,
        raw: publicPayload(`Person ${i}`, `person${i}@x.test`, []),
        identityKey: `person${i}@x.test`,
        submittedAt: `2026-09-0${(i % 9) + 1}T02:00:00Z`,
      });
    }
    return formId;
  }

  it('returns one page and the full count', async () => {
    const formId = await seedResponses(12);
    const page = await getResponses(formId, {
      pageIndex: 0,
      pageSize: 5,
      sort: 'submittedAt',
      desc: true,
      search: '',
    });

    expect(page.rows).toHaveLength(5);
    // The count is the whole set, not the page — the pager depends on it.
    expect(page.rowCount).toBe(12);
  });

  it('searches the payload, not only the rows on screen', async () => {
    const formId = await seedResponses(12);
    const page = await getResponses(formId, {
      pageIndex: 0,
      pageSize: 5,
      sort: 'submittedAt',
      desc: true,
      search: 'person11',
    });

    // Person 11 is not on the first page by date, so a browser-side filter
    // would never have found them.
    expect(page.rowCount).toBe(1);
    expect(page.rows[0].contactName).toBe('Person 11');
  });

  it('treats a search with % and _ as text, not as wildcards', async () => {
    const formId = await seedResponses(3);
    const page = await getResponses(formId, {
      pageIndex: 0,
      pageSize: 25,
      sort: 'submittedAt',
      desc: true,
      search: '%',
    });
    expect(page.rowCount).toBe(0);
  });
});

describe('formatting a page of rows', () => {
  it('runs on the server for a form that has responses', async () => {
    const { publicSegment } = await scenario();
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });
    const schema = blankFormSchema('PUBLIC');
    await insertResponse({ formId, schema, raw: publicPayload('Ada', 'ada@x.test', ['Bo']) });

    const { rows } = await getResponses(formId, {
      pageIndex: 0,
      pageSize: 25,
      sort: 'submittedAt',
      desc: true,
      search: '',
    });

    // The regression: this is what the page does, and it threw
    // "Attempted to call responseRow() from the server" while the helper lived
    // in a `'use client'` module. With zero responses the map never ran, which
    // is why nothing caught it.
    const formatted = rows.map((row) => responseRow(row, 'Asia/Singapore'));

    expect(formatted).toHaveLength(1);
    // Rendered in the concert's zone: 02:00Z is 10:00 in Singapore.
    expect(formatted[0].submittedAt).toBe('2026-09-01 10:00');
    expect(formatted[0].contactName).toBe('Ada');
    expect(formatted[0].superseded).toBe(false);
  });

  it('marks a superseded row and the edit that replaced it', async () => {
    const { publicSegment } = await scenario();
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });
    const schema = blankFormSchema('PUBLIC');

    const first = await insertResponse({
      formId,
      schema,
      raw: publicPayload('Ada', 'ada@x.test', ['Bo']),
      submittedAt: '2026-09-01T02:00:00Z',
    });
    await insertResponse({
      formId,
      schema,
      raw: publicPayload('Ada', 'ada@x.test', []),
      supersedesId: first,
      submittedAt: '2026-09-02T02:00:00Z',
    });

    const { rows } = await getResponses(formId, {
      pageIndex: 0,
      pageSize: 25,
      sort: 'submittedAt',
      desc: false,
      search: '',
    });
    const formatted = rows.map((row) => responseRow(row, 'Asia/Singapore'));

    expect(formatted[0].superseded).toBe(true);
    expect(formatted[0].isEdit).toBe(false);
    expect(formatted[1].superseded).toBe(false);
    expect(formatted[1].isEdit).toBe(true);
  });
});

describe('the export action', () => {
  it('builds a registration export with one row per response', async () => {
    await asAdmin();
    const { concertId, publicSegment } = await scenario();
    const formId = await insertForm({
      kind: 'PUBLIC',
      segmentId: publicSegment,
      title: 'Register',
    });
    const schema = blankFormSchema('PUBLIC');

    await insertResponse({ formId, schema, raw: publicPayload('Ada', 'ada@x.test', ['Bo', 'Cy']) });
    await insertResponse({ formId, schema, raw: publicPayload('Di', 'di@x.test', []) });

    const result = await buildFormExportAction(concertId, formId);
    expect(result.error).toBeNull();

    const table = result.data!;
    expect(table.rows).toHaveLength(2);
    expect(table.headers).toContain('Seat 1 — Guest name');
    expect(table.headers).toContain('Seat 2 — Guest name');
    for (const row of table.rows) expect(row).toHaveLength(table.headers.length);
  });

  it('still describes the questions when nobody has answered', async () => {
    await asAdmin();
    const { concertId, publicSegment } = await scenario();
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });

    const result = await buildFormExportAction(concertId, formId);
    expect(result.error).toBeNull();

    // No response has pinned a schema yet, so the form's current one supplies
    // the columns — an export of an open form should still say what it asks.
    expect(result.data!.headers).toContain('Full name');
    expect(result.data!.headers).toContain('Email');
    expect(result.data!.rows).toHaveLength(0);
  });

  it('reads feedback from its own table, one row per attendee', async () => {
    await asAdmin();
    const { concertId, showId, publicSegment } = await scenario();

    // A feedback form is CUSTOM blocks and nothing else (spec/v2.md §13.5).
    const feedbackSchema = blankFormSchema('FEEDBACK');
    const questions = feedbackSchema.blocks[0];
    if (questions.type !== 'CUSTOM') throw new Error('the feedback template should start CUSTOM');
    questions.fields = [
      { key: 'rating', label: 'How was it', type: 'text', system: false, required: false },
    ];
    const formId = await insertForm({ kind: 'FEEDBACK', showId, schema: feedbackSchema });

    // Two attendees on one registration: feedback is per person, not per party.
    const [registration] = await sql<{ id: number }[]>`
      insert into registrations (show_id, segment_id, contact_name, contact_email, status, source, requested_at)
      values (${showId}, ${publicSegment}, 'Ada', 'ada@x.test', 'CONFIRMED', 'FORM', now())
      returning id
    `;
    // `attendees` refuses a direct insert — the rows are `claim_seats()`'s.
    // The fixture helper opens the same door the allocation engine uses.
    const attendeeIds = await withDirectAttendeeWrites(async (tx) => {
      const ids: number[] = [];
      for (const name of ['Ada', 'Bo']) {
        const [row] = await tx<{ id: number }[]>`
          insert into attendees (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status, qr_token)
          values (${registration.id}, ${showId}, ${publicSegment}, ${name}, 'PROVIDED', 'EXTRA', 'CONFIRMED', ${randomUUID()})
          returning id
        `;
        ids.push(Number(row.id));
      }
      return ids;
    });

    for (const [index, attendeeId] of attendeeIds.entries()) {
      await sql`
        insert into feedback_responses (form_id, attendee_id, show_id, answers, form_schema, submitted_at)
        values (
          ${formId}, ${attendeeId}, ${showId},
          ${json({ feedback: { kind: 'flat', values: { rating: index === 0 ? 'Wonderful' : 'Loud' } } })}::text::jsonb,
          ${json(feedbackSchema)}::text::jsonb,
          now()
        )
      `;
    }

    const result = await buildFormExportAction(concertId, formId);
    expect(result.error).toBeNull();

    const table = result.data!;
    expect(table.rows).toHaveLength(2);
    expect(table.headers).toContain('Attendee');
    expect(table.headers).toContain('How was it');

    const answers = table.rows.map((row) => row[table.headers.indexOf('How was it')]);
    expect(answers.sort()).toEqual(['Loud', 'Wonderful']);
  });

  it('refuses a form from another concert', async () => {
    await asAdmin();
    const { publicSegment } = await scenario();
    const other = await createConcert(`Other ${randomUUID().slice(0, 8)}`);
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });

    const result = await buildFormExportAction(other, formId);
    expect(result.error).toMatch(/no longer exists/i);
    expect(result.data).toBeNull();
  });

  it('refuses rather than writing times against a guessed zone', async () => {
    await asAdmin();
    const { concertId, publicSegment } = await scenario();
    const formId = await insertForm({ kind: 'PUBLIC', segmentId: publicSegment });
    await sql`update concerts set timezone = null where id = ${concertId}`;

    const result = await buildFormExportAction(concertId, formId);
    expect(result.error).toMatch(/timezone/i);
  });
});
