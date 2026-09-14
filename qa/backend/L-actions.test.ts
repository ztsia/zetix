/**
 * QA phase 4 — module `L`'s Server Actions against a real Postgres.
 *
 * Nothing about the database is mocked. Only `@/lib/auth/session` is stubbed,
 * because there is no service-role key in a cloud container to mint a real
 * Supabase user with (local.md §7); the guard itself, `requireAdmin()`, is the
 * real one and its redirect is the assertion.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert,
  createSegment,
  createShow,
  withDirectAttendeeWrites,
} from '../../tests/helpers/fixtures';
import {
  blockOfType,
  blockWithId,
  fieldsOf,
  fieldWithKey,
  type LooseSchema,
} from '../support/loose-schema';

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
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

const {
  createFormAction,
  saveFormSchemaAction,
  saveFormSettingsAction,
  setFormStatusAction,
  startNewRoundAction,
} = await import('@/app/(admin)/admin/concerts/[concertId]/forms/actions');
const { buildFormExportAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/forms/[formId]/responses/export-actions'
);
const { blankFormSchema } = await import('@/lib/forms/templates');

const NO_STATE = { error: null, message: null };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function signIn(role: 'ADMIN' | 'OPERATOR' | null) {
  if (role === null) {
    sessionUser.mockResolvedValue(null);
    return null;
  }
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role, is_active)
    values (${id}::uuid, ${`${role}-${id}@example.test`}, ${role}, ${role}::user_role, true)
  `;
  sessionUser.mockResolvedValue({ id, email: `${role}@example.test`, role });
  return id;
}

async function scenario() {
  const concertId = await createConcert(`QA ${randomUUID().slice(0, 8)}`);
  const showId = await createShow(concertId, 400);
  const publicSegment = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 200 });
  const playerSegment = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 200,
    baseQuota: 2,
  });
  return { concertId, showId, publicSegment, playerSegment };
}

async function readForm(id: number) {
  const [row] = await sql<Record<string, unknown>[]>`
    select kind, schema_version, schema, status, segment_id, show_id, slug,
           max_tickets_per_response, opens_at, closes_at, title
    from registration_forms where id = ${id}
  `;
  return row;
}

async function formCount(): Promise<number> {
  const [{ count }] = await sql<{ count: string }[]>`select count(*) from registration_forms`;
  return Number(count);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const result = (await run()) as { error?: string | null };
    if (result && typeof result === 'object' && 'error' in result && result.error) {
      return `refused:${result.error}`;
    }
    return 'allowed';
  } catch (error) {
    if (error instanceof RedirectSignal) return `redirect:${error.to}`;
    return `threw:${(error as Error).message}`;
  }
}

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
});

// ---------------------------------------------------------------------------
// AC-2, AC-3, AC-4, AC-42 — the authorization matrix, every action, every role
// ---------------------------------------------------------------------------
describe('authorization matrix', () => {
  it('refuses every action to anonymous and to OPERATOR, and writes nothing', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment } = await scenario();
    const created = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Seeded' }),
    );
    const formId = Number(created.message);
    const before = await readForm(formId);

    const calls: [string, () => Promise<unknown>][] = [
      ['create', () => createFormAction(concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Sneaky' }))],
      ['saveSchema', () => saveFormSchemaAction(concertId, formId, NO_STATE, form({ schema: JSON.stringify(blankFormSchema('PUBLIC')) }))],
      ['saveSettings', () => saveFormSettingsAction(concertId, formId, NO_STATE, form({ title: 'Hijacked', slug: 'hijacked' }))],
      ['setStatus', () => setFormStatusAction(concertId, formId, NO_STATE, form({ status: 'OPEN' }))],
      ['newRound', () => startNewRoundAction(concertId, formId, NO_STATE, form({ roundLabel: 'Round 2' }))],
      ['export', () => buildFormExportAction(concertId, formId)],
    ];

    const results: Record<string, Record<string, string>> = {};
    for (const role of ['anonymous', 'OPERATOR'] as const) {
      await signIn(role === 'anonymous' ? null : 'OPERATOR');
      results[role] = {};
      for (const [name, call] of calls) {
        results[role][name] = await outcome(call);
      }
    }

     
    console.log('AUTHZ MATRIX', JSON.stringify(results, null, 2));

    for (const [name] of calls) {
      expect(results.anonymous[name], `anonymous ${name}`).toBe('redirect:/login');
      expect(results.OPERATOR[name], `operator ${name}`).toBe('redirect:/scan');
    }

    expect(await formCount()).toBe(1);
    expect(await readForm(formId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// AC-9, AC-44, AC-45 — hostile and malformed input
// ---------------------------------------------------------------------------
describe('input hardening', () => {
  it('refuses a duplicate slug without a stack trace, and inserts nothing', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment } = await scenario();
    await createFormAction(concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register', slug: 'same-slug' }));
    const result = await createFormAction(concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Again', slug: 'same-slug' }));

     
    console.log('DUPLICATE SLUG ->', JSON.stringify(result));
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/duplicate key|violates|at Object|\bstack\b/i);
    expect(await formCount()).toBe(1);
  });

  it('never stores a slug that could break /f/{slug}', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment } = await scenario();
    const hostile = [
      '../../etc/passwd',
      'a b/c',
      "r1'; drop table registration_forms; --",
      'ünïcödé Rôund',
      '%2e%2e%2f',
    ];
    const stored: string[] = [];
    for (const slug of hostile) {
      const result = await createFormAction(
        concertId,
        NO_STATE,
        form({ kind: 'PUBLIC', parentId: String(publicSegment), title: `T ${slug}`, slug }),
      );
      if (result.error === null) stored.push(String((await readForm(Number(result.message))).slug));
      else stored.push(`REFUSED: ${result.error}`);
    }
     
    console.log('SLUGS ->', JSON.stringify(stored, null, 2));
    for (const value of stored) {
      if (value.startsWith('REFUSED')) continue;
      expect(value).toMatch(/^[a-z0-9-]+$/);
    }
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from registration_forms`;
    expect(Number(count)).toBeGreaterThan(0); // table still exists — SQL injection did not land
  });

  it('refuses missing, wrong-typed and oversized input with a structured error', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment } = await scenario();
    const long = 'x'.repeat(120_000);

    const cases: Record<string, FormData> = {
      missingTitle: form({ kind: 'PUBLIC', parentId: String(publicSegment) }),
      missingParent: form({ kind: 'PUBLIC', title: 'No parent' }),
      badKind: form({ kind: 'NOT_A_KIND', parentId: String(publicSegment), title: 'x' }),
      parentNaN: form({ kind: 'PUBLIC', parentId: 'abc', title: 'x' }),
      parentNegative: form({ kind: 'PUBLIC', parentId: '-1', title: 'x' }),
      parentHuge: form({ kind: 'PUBLIC', parentId: '99999999999', title: 'x' }),
      longTitle: form({ kind: 'PUBLIC', parentId: String(publicSegment), title: long }),
    };

    const results: Record<string, string> = {};
    for (const [name, data] of Object.entries(cases)) {
      results[name] = await outcome(() => createFormAction(concertId, NO_STATE, data));
    }
     
    console.log('INPUT CASES ->', JSON.stringify(results, null, 2));

    for (const [name, value] of Object.entries(results)) {
      expect(value, name).toMatch(/^refused:/);
      expect(value, name).not.toMatch(/threw:/);
    }
    expect(await formCount()).toBe(0);
  });

  it('refuses a window that closes before it opens', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment } = await scenario();
    const created = await createFormAction(concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Window' }));
    const formId = Number(created.message);

    const result = await saveFormSettingsAction(
      concertId,
      formId,
      NO_STATE,
      form({
        title: 'Window',
        slug: 'window',
        opensAt: '2026-10-02T09:00',
        closesAt: '2026-10-01T09:00',
      }),
    );
     
    console.log('BAD WINDOW ->', JSON.stringify(result));
    expect(result.error).toBeTruthy();
    const row = await readForm(formId);
    expect(row.opens_at).toBeNull();
    expect(row.closes_at).toBeNull();
  });

  it('refuses an unknown status and leaves the row alone', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment } = await scenario();
    const created = await createFormAction(concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Status' }));
    const formId = Number(created.message);

    const result = await setFormStatusAction(concertId, formId, NO_STATE, form({ status: 'ARCHIVED' }));
    expect(result.error).toBeTruthy();
    expect((await readForm(formId)).status).toBe('DRAFT');
  });
});

// ---------------------------------------------------------------------------
// AC-13, AC-15, AC-19, AC-20, AC-21 — crafted schemas hit the server contract
// ---------------------------------------------------------------------------
describe('crafted schema saves', () => {
  async function aForm(kind: 'PUBLIC' | 'PLAYER' = 'PUBLIC') {
    const { concertId, publicSegment, playerSegment } = await scenario();
    const created = await createFormAction(
      concertId,
      NO_STATE,
      form({
        kind,
        parentId: String(kind === 'PUBLIC' ? publicSegment : playerSegment),
        title: 'Register',
      }),
    );
    return { concertId, formId: Number(created.message) };
  }

  const craft = (mutate: (schema: LooseSchema) => void, kind: 'PUBLIC' | 'PLAYER' = 'PUBLIC') => {
    const schema = blankFormSchema(kind) as unknown as LooseSchema;
    mutate(schema);
    return JSON.stringify(schema);
  };

  it('refuses every attempt to unpick the system blocks', async () => {
    await signIn('ADMIN');
    const { concertId, formId } = await aForm();
    const versionBefore = (await readForm(formId)).schema_version;

    const attacks: Record<string, string> = {
      deleteRegistrantBlock: craft((s) => {
        s.blocks = s.blocks.filter((b) => b.type !== 'REGISTRANT');
      }),
      deletePartyBlock: craft((s) => {
        s.blocks = s.blocks.filter((b) => b.type !== 'GUESTS_PARTY');
      }),
      deleteContactEmail: craft((s) => {
        const r = blockOfType(s, 'REGISTRANT');
        r.fields = r.fields?.filter((f) => f.key !== 'contact_email');
      }),
      retypeContactEmail: craft((s) => {
        const r = blockOfType(s, 'REGISTRANT');
        fieldWithKey(r.fields, 'contact_email').type = 'text';
      }),
      unrequireContactEmail: craft((s) => {
        const r = blockOfType(s, 'REGISTRANT');
        fieldWithKey(r.fields, 'contact_email').required = false;
      }),
      renameContactEmailKey: craft((s) => {
        const r = blockOfType(s, 'REGISTRANT');
        fieldWithKey(r.fields, 'contact_email').key = 'email_addr';
      }),
      deleteSeatName: craft((s) => {
        const p = blockOfType(s, 'GUESTS_PARTY');
        p.guest_fields = p.guest_fields?.filter((f) => f.key !== 'full_name');
      }),
      unsystemContactEmail: craft((s) => {
        const r = blockOfType(s, 'REGISTRANT');
        fieldWithKey(r.fields, 'contact_email').system = false;
      }),
      addSecondRegistrantBlock: craft((s) => {
        s.blocks.push(JSON.parse(JSON.stringify(s.blocks.find((b) => b.type === 'REGISTRANT'))));
      }),
      conditionReadsSystemField: craft((s) => {
        s.blocks.push({
          id: 'extras',
          type: 'CUSTOM',
          title: 'Extras',
          fields: [
            {
              key: 'accessibility',
              label: 'Accessibility',
              type: 'text',
              system: false,
              required: false,
              condition: { field: 'contact_email', op: 'answered' },
            },
          ],
        });
      }),
      conditionTargetsSystemField: craft((s) => {
        const r = blockOfType(s, 'REGISTRANT');
        fieldWithKey(r.fields, 'contact_phone').condition = {
          field: 'contact_name',
          op: 'answered',
        };
      }),
      conditionReadsLaterField: craft((s) => {
        s.blocks.push({
          id: 'extras',
          type: 'CUSTOM',
          title: 'Extras',
          fields: [
            {
              key: 'first_q',
              label: 'First',
              type: 'text',
              system: false,
              required: false,
              condition: { field: 'second_q', op: 'answered' },
            },
            { key: 'second_q', label: 'Second', type: 'text', system: false, required: false },
          ],
        });
      }),
      conditionInRepeaterReadsFlat: craft((s) => {
        s.blocks.push({
          id: 'extras',
          type: 'CUSTOM',
          title: 'Extras',
          fields: [{ key: 'flat_q', label: 'Flat', type: 'text', system: false, required: false }],
        });
        const p = blockOfType(s, 'GUESTS_PARTY');
        fieldsOf(p).push({
          key: 'seat_note',
          label: 'Note',
          type: 'text',
          system: false,
          required: false,
          condition: { field: 'flat_q', op: 'answered' },
        });
      }),
      wrongKind: JSON.stringify(blankFormSchema('PLAYER')),
      notAnObject: '"just a string"',
      nullSchema: 'null',
      arraySchema: '[]',
    };

    const results: Record<string, string> = {};
    for (const [name, schema] of Object.entries(attacks)) {
      results[name] = await outcome(() =>
        saveFormSchemaAction(concertId, formId, NO_STATE, form({ schema })),
      );
    }
     
    console.log('CRAFTED SAVES ->', JSON.stringify(results, null, 2));

    for (const [name, value] of Object.entries(results)) {
      expect(value, name).toMatch(/^refused:/);
    }
    expect((await readForm(formId)).schema_version).toBe(versionBefore);
  });

  it('refuses malformed JSON without throwing', async () => {
    await signIn('ADMIN');
    const { concertId, formId } = await aForm();
    const result = await saveFormSchemaAction(concertId, formId, NO_STATE, form({ schema: '{oops' }));
    expect(result.error).toBeTruthy();
  });

  it('accepts a legal custom field and a custom→custom condition, and bumps the version', async () => {
    await signIn('ADMIN');
    const { concertId, formId } = await aForm();
    const schema = blankFormSchema('PUBLIC') as unknown as LooseSchema;
    schema.blocks.push({
      id: 'extras',
      type: 'CUSTOM',
      title: 'Anything else',
      fields: [
        { key: 'coming_by_car', label: 'Coming by car?', type: 'checkbox', system: false, required: false },
        {
          key: 'plate',
          label: 'Plate number',
          type: 'text',
          system: false,
          required: false,
          condition: { field: 'coming_by_car', op: 'eq', value: true },
        },
      ],
    });
    const result = await saveFormSchemaAction(concertId, formId, NO_STATE, form({ schema: JSON.stringify(schema) }));
     
    console.log('LEGAL CUSTOM SAVE ->', JSON.stringify(result));
    expect(result.error).toBeNull();
    expect((await readForm(formId)).schema_version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-23, AC-24 — pinning: an edit never rewrites an answer already given
// ---------------------------------------------------------------------------
describe('schema pinning', () => {
  it('leaves raw and form_schema byte-identical after the form is edited', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment } = await scenario();
    const created = await createFormAction(concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register' }));
    const formId = Number(created.message);

    const pinned = blankFormSchema('PUBLIC') as unknown as LooseSchema;
    pinned.blocks.push({
      id: 'extras',
      type: 'CUSTOM',
      title: 'Anything else',
      fields: [{ key: 'diet', label: 'Dietary needs', type: 'text', system: false, required: false }],
    });
    const raw = { registrant: { kind: 'flat', values: { contact_name: 'Ada', contact_email: 'ada@example.test' } }, extras: { kind: 'flat', values: { diet: 'none' } } };

    await sql`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${formId}, ${JSON.stringify(raw)}::text::jsonb, ${JSON.stringify(pinned)}::text::jsonb, now())
    `;
    const [before] = await sql<{ raw: string; schema: string }[]>`
      select raw::text as raw, form_schema::text as schema from form_responses where form_id = ${formId}
    `;

    // Rename the question and save.
    const edited = JSON.parse(JSON.stringify(pinned)) as LooseSchema;
    fieldsOf(blockWithId(edited, 'extras'))[0].label = 'Allergies';
    const save = await saveFormSchemaAction(concertId, formId, NO_STATE, form({ schema: JSON.stringify(edited) }));
    expect(save.error).toBeNull();

    const [after] = await sql<{ raw: string; schema: string }[]>`
      select raw::text as raw, form_schema::text as schema from form_responses where form_id = ${formId}
    `;
    expect(after.raw).toBe(before.raw);
    expect(after.schema).toBe(before.schema);
    expect((await readForm(formId)).schema_version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-27 — decision 43: the vestigial column is never written
// ---------------------------------------------------------------------------
describe('party cap (decision 43)', () => {
  it('never writes registration_forms.max_tickets_per_response', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment } = await scenario();
    const created = await createFormAction(concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register' }));
    const formId = Number(created.message);

    await saveFormSettingsAction(
      concertId,
      formId,
      NO_STATE,
      form({
        title: 'Register',
        slug: 'register',
        maxResponses: '50',
        maxTicketsPerResponse: '9',
        oneResponsePerIdentity: 'on',
      }),
    );
    expect((await readForm(formId)).max_tickets_per_response).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-35 — cross-concert tampering
// ---------------------------------------------------------------------------
describe('cross-concert access', () => {
  it('refuses every action for a form belonging to another concert', async () => {
    await signIn('ADMIN');
    const mine = await scenario();
    const theirs = await scenario();
    const created = await createFormAction(theirs.concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(theirs.publicSegment), title: 'Theirs' }));
    const formId = Number(created.message);

    const results = {
      saveSchema: await outcome(() => saveFormSchemaAction(mine.concertId, formId, NO_STATE, form({ schema: JSON.stringify(blankFormSchema('PUBLIC')) }))),
      saveSettings: await outcome(() => saveFormSettingsAction(mine.concertId, formId, NO_STATE, form({ title: 'Stolen', slug: 'stolen' }))),
      setStatus: await outcome(() => setFormStatusAction(mine.concertId, formId, NO_STATE, form({ status: 'OPEN' }))),
      newRound: await outcome(() => startNewRoundAction(mine.concertId, formId, NO_STATE, form({ roundLabel: 'R2' }))),
      export: await outcome(() => buildFormExportAction(mine.concertId, formId)),
    };
     
    console.log('CROSS-CONCERT ->', JSON.stringify(results, null, 2));
    for (const [name, value] of Object.entries(results)) {
      expect(value, name).toMatch(/^refused:/);
    }
    expect((await readForm(formId)).title).toBe('Theirs');
  });
});

// ---------------------------------------------------------------------------
// AC-36, AC-37, AC-41, AC-43 — exports against the real tables
// ---------------------------------------------------------------------------
describe('exports', () => {
  async function seedForm() {
    const { concertId, publicSegment } = await scenario();
    const created = await createFormAction(concertId, NO_STATE, form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register' }));
    return { concertId, formId: Number(created.message) };
  }

  function schemaV(label: string) {
    const schema = blankFormSchema('PUBLIC') as unknown as LooseSchema;
    schema.blocks.push({
      id: 'extras',
      type: 'CUSTOM',
      title: 'Anything else',
      fields: [
        { key: 'diet', label, type: 'text', system: false, required: false },
        { key: 'never_answered', label: 'Nobody answered this', type: 'text', system: false, required: false },
      ],
    });
    return schema;
  }

  it('exports a header-only sheet for a form with no responses', async () => {
    await signIn('ADMIN');
    const { concertId, formId } = await seedForm();
    const result = await buildFormExportAction(concertId, formId);
     
    console.log('EMPTY EXPORT ->', JSON.stringify(result, null, 2));
    expect(result.error).toBeNull();
    expect(result.data?.rows).toEqual([]);
    expect(result.data?.headers.length).toBeGreaterThan(0);
  });

  it('gives an unanswered question a column and expands the party across columns', async () => {
    await signIn('ADMIN');
    const { concertId, formId } = await seedForm();
    const pinned = schemaV('Dietary needs');
    const raw = {
      registrant: { kind: 'flat', values: { contact_name: 'Ada', contact_email: 'ada@example.test' } },
      party: { kind: 'repeater', rows: [{ full_name: 'Bob' }, { full_name: 'Cleo' }] },
      extras: { kind: 'flat', values: { diet: 'vegetarian' } },
    };
    await sql`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${formId}, ${JSON.stringify(raw)}::text::jsonb, ${JSON.stringify(pinned)}::text::jsonb, now())
    `;

    const result = await buildFormExportAction(concertId, formId);
     
    console.log('EXPORT HEADERS ->', JSON.stringify(result.data?.headers));
     
    console.log('EXPORT ROWS ->', JSON.stringify(result.data?.rows));
    expect(result.error).toBeNull();
    const headers = result.data!.headers;
    expect(headers).toContain('Nobody answered this');
    expect(headers.some((h) => /Seat 1/.test(h))).toBe(true);
    expect(headers.some((h) => /Seat 2/.test(h))).toBe(true);
    expect(result.data!.rows).toHaveLength(1);
    expect(result.data!.rows[0].length).toBe(headers.length);
  });

  it('keeps both versions worth of columns when responses pin different schemas', async () => {
    await signIn('ADMIN');
    const { concertId, formId } = await seedForm();
    const v1 = schemaV('Dietary needs');
    const v2 = JSON.parse(JSON.stringify(v1)) as LooseSchema;
    fieldsOf(blockWithId(v2, 'extras'))[0].label = 'Allergies';

    const rawFor = (name: string) => ({
      registrant: { kind: 'flat', values: { contact_name: name, contact_email: `${name}@example.test` } },
      party: { kind: 'repeater', rows: [] },
      extras: { kind: 'flat', values: { diet: `${name}-answer` } },
    });

    await sql`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${formId}, ${JSON.stringify(rawFor('old'))}::text::jsonb, ${JSON.stringify(v1)}::text::jsonb, now() - interval '2 days')
    `;
    await sql`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${formId}, ${JSON.stringify(rawFor('new'))}::text::jsonb, ${JSON.stringify(v2)}::text::jsonb, now())
    `;

    const result = await buildFormExportAction(concertId, formId);
    const headers = result.data!.headers;
    const rows = result.data!.rows;
     
    console.log('MIXED VERSION HEADERS ->', JSON.stringify(headers));
     
    console.log('MIXED VERSION ROWS ->', JSON.stringify(rows));

    // Both answers must be present somewhere in the sheet — neither dropped.
    const flat = rows.flat().map(String);
    expect(flat).toContain('old-answer');
    expect(flat).toContain('new-answer');
    expect(rows.every((row) => row.length === headers.length)).toBe(true);
  });

  it('refuses to export when the concert has no timezone rather than guessing', async () => {
    await signIn('ADMIN');
    const { concertId, formId } = await seedForm();
    await sql`update concerts set timezone = null where id = ${concertId}`;
    const result = await buildFormExportAction(concertId, formId);
     
    console.log('NO TIMEZONE EXPORT ->', JSON.stringify(result));
    expect(result.error).toBeTruthy();
    expect(result.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-38 — a feedback export is one row per attendee (v2.md §8.5 rule 2)
// ---------------------------------------------------------------------------
describe('feedback export', () => {
  it('writes one row per attendee, with the attendee and show named', async () => {
    await signIn('ADMIN');
    const { concertId, showId, publicSegment } = await scenario();
    const created = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'FEEDBACK', parentId: String(showId), title: 'How was it' }),
    );
    const formId = Number(created.message);

    const [{ schema }] = await sql<{ schema: LooseSchema }[]>`
      select schema from registration_forms where id = ${formId}
    `;
    const pinned = JSON.parse(JSON.stringify(schema));
    pinned.blocks.push({
      id: 'extras',
      type: 'CUSTOM',
      title: 'Your evening',
      fields: [
        { key: 'enjoyed', label: 'What did you enjoy?', type: 'text', system: false, required: false },
        { key: 'unasked', label: 'Nobody answered this', type: 'text', system: false, required: false },
      ],
    });

    const [registration] = await sql<{ id: number }[]>`
      insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
      values (${showId}, ${publicSegment}, 'ADMIN', 'Ada', 'ada@example.test', 'CONFIRMED', now())
      returning id
    `;
    const names = ['Ada Lovelace', 'Bob Tan'];
    for (const [i, name] of names.entries()) {
      // The database refuses a direct attendee insert — every grant goes through
      // `claim_seats()` (allocation.md §7.6). A fixture opts out visibly.
      const [attendee] = await withDirectAttendeeWrites((tx) => tx<{ id: number }[]>`
        insert into attendees (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status)
        values (${registration.id}, ${showId}, ${publicSegment}, ${name}, 'PROVIDED', 'EXTRA', 'CONFIRMED')
        returning id
      `);
      await sql`
        insert into feedback_responses (form_id, attendee_id, show_id, answers, form_schema, submitted_at)
        values (${formId}, ${attendee.id}, ${showId},
                ${JSON.stringify({ extras: { kind: 'flat', values: { enjoyed: `answer-${i}` } } })}::text::jsonb,
                ${JSON.stringify(pinned)}::text::jsonb, now())
      `;
    }

    const result = await buildFormExportAction(concertId, formId);
     
    console.log('FEEDBACK HEADERS ->', JSON.stringify(result.data?.headers));
     
    console.log('FEEDBACK ROWS ->', JSON.stringify(result.data?.rows));
    expect(result.error).toBeNull();
    expect(result.data!.rows).toHaveLength(2);
    expect(result.data!.headers).toContain('Attendee');
    expect(result.data!.headers).toContain('Nobody answered this');
    expect(result.data!.rows.flat().map(String)).toContain('Ada Lovelace');
    expect(result.data!.rows.flat().map(String)).toContain('answer-1');
  });
});

// ---------------------------------------------------------------------------
// AC-6 — kind must agree with the segment's audience_mode, proved here too
// ---------------------------------------------------------------------------
describe('kind and audience must agree', () => {
  it('refuses both mismatches and writes nothing', async () => {
    await signIn('ADMIN');
    const { concertId, publicSegment, playerSegment } = await scenario();

    const publicOnPlayer = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(playerSegment), title: 'Wrong 1' }),
    );
    const playerOnPublic = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PLAYER', parentId: String(publicSegment), title: 'Wrong 2' }),
    );
     
    console.log('KIND MISMATCH ->', JSON.stringify({ publicOnPlayer, playerOnPublic }, null, 2));
    expect(publicOnPlayer.error).toBeTruthy();
    expect(playerOnPublic.error).toBeTruthy();
    expect(await formCount()).toBe(0);
  });
});
