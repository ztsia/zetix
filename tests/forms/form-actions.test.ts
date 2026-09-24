import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow } from '../helpers/fixtures';

/**
 * Module `L`'s save path (spec/v2.md §8.2, §8.2.4, decision 35).
 *
 * The database is real. Three properties are worth a real one rather than a
 * mock, because each fails silently and each is load-bearing:
 *
 * **`schema_version` moves on every schema save.** Responses pin the version
 * they were answered against, so a save that forgot to bump it would let an
 * edit reach back and change what an answer already given meant — with nothing
 * anywhere to say it had happened (§8.2.4).
 *
 * **`kind` must agree with the segment's `audience_mode`.** The database's own
 * `registration_forms_one_parent` comment hands this check to this module
 * because it needs the segment row. Nothing else enforces it, so if these tests
 * pass while the check is gone, a player form on a public segment allocates a
 * stranger's party under the players' rules.
 *
 * **The contract runs on the server, not only in the builder.** A schema posted
 * by anything but the builder meets the same refusal.
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

const {
  createFormAction,
  saveFormSchemaAction,
  setFormStatusAction,
  startNewRoundAction,
} = await import('@/app/(admin)/admin/concerts/[concertId]/forms/actions');

const { blankFormSchema } = await import('@/lib/forms/templates');

const NO_STATE = { error: null, message: null };

async function asAdmin() {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, role, is_active)
    values (${id}::uuid, ${`admin-${id}@example.test`}, 'ADMIN', true)
  `;
  sessionUser.mockResolvedValue({ id, email: 'admin@example.test', role: 'ADMIN' });
  return id;
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

async function scenario() {
  const concertId = await createConcert(`Forms ${randomUUID().slice(0, 8)}`);
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
  const [row] = await sql<
    { kind: string; schema_version: number; schema: unknown; status: string; segment_id: number | null; show_id: number | null }[]
  >`
    select kind, schema_version, schema, status, segment_id, show_id
    from registration_forms where id = ${id}
  `;
  return row;
}

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
});

describe('creating a form', () => {
  it('writes kind and its schema together, so the loader cannot refuse the pair', async () => {
    await asAdmin();
    const { concertId, publicSegment } = await scenario();

    const result = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register' }),
    );
    expect(result.error).toBeNull();

    const row = await readForm(Number(result.message));
    expect(row.kind).toBe('PUBLIC');
    // `K`'s loader cross-checks the column against the JSON's own kind and
    // refuses the form if they disagree.
    expect((row.schema as { kind: string }).kind).toBe('PUBLIC');
    expect(row.schema_version).toBe(1);
    expect(row.status).toBe('DRAFT');
    expect(Number(row.segment_id)).toBe(publicSegment);
    expect(row.show_id).toBeNull();
  });

  it('refuses a player form on a public segment', async () => {
    await asAdmin();
    const { concertId, publicSegment } = await scenario();

    const result = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PLAYER', parentId: String(publicSegment), title: 'Players' }),
    );

    expect(result.error).toMatch(/no players/i);
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from registration_forms`;
    expect(Number(count)).toBe(0);
  });

  it('refuses a public form on a player-invited segment', async () => {
    await asAdmin();
    const { concertId, playerSegment } = await scenario();

    const result = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(playerSegment), title: 'Public' }),
    );
    expect(result.error).toMatch(/reserved for players/i);
  });

  it('attaches a feedback form to the show, with no segment', async () => {
    await asAdmin();
    const { concertId, showId } = await scenario();

    const result = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'FEEDBACK', parentId: String(showId), title: 'How was it' }),
    );
    expect(result.error).toBeNull();

    const row = await readForm(Number(result.message));
    expect(row.segment_id).toBeNull();
    expect(Number(row.show_id)).toBe(showId);
  });

  it('refuses a segment belonging to another concert', async () => {
    await asAdmin();
    const mine = await scenario();
    const theirs = await scenario();

    const result = await createFormAction(
      mine.concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(theirs.publicSegment), title: 'Sneaky' }),
    );
    expect(result.error).toMatch(/not part of this concert/i);
  });
});

describe('saving the schema', () => {
  async function aForm() {
    const { concertId, publicSegment } = await scenario();
    const created = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register' }),
    );
    return { concertId, formId: Number(created.message) };
  }

  it('bumps schema_version on every save', async () => {
    await asAdmin();
    const { concertId, formId } = await aForm();
    const schema = blankFormSchema('PUBLIC');

    for (const expected of [2, 3, 4]) {
      const result = await saveFormSchemaAction(
        concertId,
        formId,
        NO_STATE,
        form({ schema: JSON.stringify(schema) }),
      );
      expect(result.error).toBeNull();
      expect((await readForm(formId)).schema_version).toBe(expected);
    }
  });

  it('refuses a schema that deletes contact_email, and does not bump the version', async () => {
    await asAdmin();
    const { concertId, formId } = await aForm();
    const before = (await readForm(formId)).schema_version;

    const schema = blankFormSchema('PUBLIC');
    const registrant = schema.blocks.find((block) => block.type === 'REGISTRANT')!;
    if ('fields' in registrant) {
      registrant.fields = registrant.fields.filter((field) => field.key !== 'contact_email');
    }

    const result = await saveFormSchemaAction(
      concertId,
      formId,
      NO_STATE,
      form({ schema: JSON.stringify(schema) }),
    );

    expect(result.error).toMatch(/contact_email/);
    expect((await readForm(formId)).schema_version).toBe(before);
  });

  it('refuses a condition that reads a system field (decision 37)', async () => {
    await asAdmin();
    const { concertId, formId } = await aForm();

    const schema = blankFormSchema('PUBLIC');
    schema.blocks.push({
      id: 'extras',
      type: 'CUSTOM',
      title: 'Extras',
      fields: [
        {
          key: 'accessibility',
          label: 'Accessibility needs',
          type: 'text',
          system: false,
          required: false,
          // Reading the email question would put the allocation path under a
          // rule assembled in a UI.
          condition: { field: 'contact_email', op: 'answered' },
        },
      ],
    });

    const result = await saveFormSchemaAction(
      concertId,
      formId,
      NO_STATE,
      form({ schema: JSON.stringify(schema) }),
    );
    expect(result.error).toMatch(/contact_email/);
  });

  it('refuses a schema whose kind disagrees with the form', async () => {
    await asAdmin();
    const { concertId, formId } = await aForm();

    // A save that took `kind` from the payload would turn a public form into a
    // player one while leaving it on a public segment.
    const result = await saveFormSchemaAction(
      concertId,
      formId,
      NO_STATE,
      form({ schema: JSON.stringify(blankFormSchema('PLAYER')) }),
    );

    expect(result.error).toMatch(/PLAYER|PUBLIC/);
    expect((await readForm(formId)).kind).toBe('PUBLIC');
  });

  it('refuses a form belonging to another concert', async () => {
    await asAdmin();
    const { formId } = await aForm();
    const other = await createConcert(`Other ${randomUUID().slice(0, 8)}`);

    const result = await saveFormSchemaAction(
      other,
      formId,
      NO_STATE,
      form({ schema: JSON.stringify(blankFormSchema('PUBLIC')) }),
    );
    expect(result.error).toMatch(/no longer exists/i);
  });
});

describe('status', () => {
  async function aForm() {
    const { concertId, publicSegment } = await scenario();
    const created = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register' }),
    );
    return { concertId, formId: Number(created.message) };
  }

  it('opens and closes a form', async () => {
    await asAdmin();
    const { concertId, formId } = await aForm();

    expect((await setFormStatusAction(concertId, formId, NO_STATE, form({ status: 'OPEN' }))).error).toBeNull();
    expect((await readForm(formId)).status).toBe('OPEN');

    expect((await setFormStatusAction(concertId, formId, NO_STATE, form({ status: 'CLOSED' }))).error).toBeNull();
    expect((await readForm(formId)).status).toBe('CLOSED');
  });

  it('refuses to return a form with responses to draft', async () => {
    await asAdmin();
    const { concertId, formId } = await aForm();

    await sql`
      insert into form_responses (form_id, raw, form_schema, submitted_at)
      values (${formId}, '{}'::jsonb, '{}'::jsonb, now())
    `;

    const result = await setFormStatusAction(concertId, formId, NO_STATE, form({ status: 'DRAFT' }));
    // Draft is where the builder is free; going back there with answers pinned
    // to a version invites an edit whose meaning diverges from them.
    expect(result.error).toMatch(/cannot return to draft/i);
    expect((await readForm(formId)).status).toBe('DRAFT');
  });
});

describe('a second round is a new form', () => {
  it('copies the questions onto the same segment and leaves the first alone', async () => {
    await asAdmin();
    const { concertId, publicSegment } = await scenario();

    const first = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register', roundLabel: 'Round 1' }),
    );
    const firstId = Number(first.message);
    await setFormStatusAction(concertId, firstId, NO_STATE, form({ status: 'OPEN' }));

    const second = await startNewRoundAction(
      concertId,
      firstId,
      NO_STATE,
      form({ roundLabel: 'Round 2', closeCurrent: 'on' }),
    );
    expect(second.error).toBeNull();

    const secondId = Number(second.message);
    const [before, after] = [await readForm(firstId), await readForm(secondId)];

    expect(secondId).not.toBe(firstId);
    // Same segment, same questions, its own version counter and its own status.
    expect(Number(after.segment_id)).toBe(publicSegment);
    expect(after.schema).toEqual(before.schema);
    expect(after.schema_version).toBe(1);
    expect(after.status).toBe('DRAFT');
    expect(before.status).toBe('CLOSED');
  });

  it('gives the new round its own link', async () => {
    await asAdmin();
    const { concertId, publicSegment } = await scenario();

    const first = await createFormAction(
      concertId,
      NO_STATE,
      form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register' }),
    );
    const second = await startNewRoundAction(
      concertId,
      Number(first.message),
      NO_STATE,
      form({ roundLabel: 'Round 2' }),
    );

    const slugs = await sql<{ slug: string }[]>`
      select slug from registration_forms order by id
    `;
    expect(second.error).toBeNull();
    expect(new Set(slugs.map((row) => row.slug)).size).toBe(2);
  });
});
