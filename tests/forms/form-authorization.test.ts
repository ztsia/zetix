import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow } from '../helpers/fixtures';

/**
 * Every mutation on module `L` is `ADMIN`-only (spec/admin.md §14.3).
 *
 * **This file exists because a guard that is present is not the same claim as a
 * guard that fires.** A Server Action is unprotected until it calls a guard
 * itself, and the failure mode is silent in exactly the wrong direction: an
 * action that forgot `requireAdmin()` works perfectly for the admin who wrote
 * it and works just as well for an operator who guesses the form id.
 *
 * So each action is called **twice** — signed out and as an `OPERATOR` — and
 * each time the assertion is in two halves: the call was refused **and the row
 * is unchanged**. The second half is the one worth writing. A guard that
 * redirects after the write has already happened would satisfy the first.
 *
 * `L` also carries a second boundary that is not about roles: every action
 * takes `concertId` from the URL and the form id from the form, and joins them
 * back together. An admin of one concert reaching a form in another is the
 * same class of bug, so it is tested the same way.
 */

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
  saveFormHeaderAction,
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

async function signIn(role: 'ADMIN' | 'OPERATOR') {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, role, is_active)
    values (${id}::uuid, ${`${role.toLowerCase()}-${id}@example.test`}, ${role}, true)
  `;
  sessionUser.mockResolvedValue({ id, email: `${role}@example.test`, role });
  return id;
}

function signOut() {
  sessionUser.mockResolvedValue(null);
}

/** A concert with both segment kinds and one draft form on the public one. */
async function scenario() {
  const concertId = await createConcert(`Auth ${randomUUID().slice(0, 8)}`);
  const showId = await createShow(concertId, 400);
  const publicSegment = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 200 });

  await signIn('ADMIN');
  const created = await createFormAction(
    concertId,
    NO_STATE,
    form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Register' }),
  );
  const formId = Number(created.message);

  return { concertId, showId, publicSegment, formId };
}

type FormRow = {
  title: string;
  slug: string;
  status: string;
  schema_version: number;
};

async function readForm(id: number): Promise<FormRow> {
  const [row] = await sql<FormRow[]>`
    select title, slug, status, schema_version from registration_forms where id = ${id}
  `;
  return row;
}

async function countForms(): Promise<number> {
  const [{ count }] = await sql<{ count: string }[]>`select count(*) from registration_forms`;
  return Number(count);
}

/** Every mutation, as a thunk, so each can be run under several identities. */
function mutations(concertId: number, formId: number, publicSegment: number) {
  return {
    create: () =>
      createFormAction(
        concertId,
        NO_STATE,
        form({ kind: 'PUBLIC', parentId: String(publicSegment), title: 'Sneaked in' }),
      ),
    saveSchema: () =>
      saveFormSchemaAction(
        concertId,
        formId,
        NO_STATE,
        form({ schema: JSON.stringify(blankFormSchema('PUBLIC')) }),
      ),
    saveSettings: () =>
      saveFormSettingsAction(
        concertId,
        formId,
        NO_STATE,
        form({ title: 'Renamed by someone else', slug: 'renamed-by-someone-else' }),
      ),
    saveHeader: () =>
      saveFormHeaderAction(concertId, formId, NO_STATE, form({ title: 'Renamed in the header' })),
    setStatus: () => setFormStatusAction(concertId, formId, NO_STATE, form({ status: 'OPEN' })),
    newRound: () =>
      startNewRoundAction(concertId, formId, NO_STATE, form({ roundLabel: 'Round 2' })),
    export: () => buildFormExportAction(concertId, formId),
  };
}

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
});

describe('signed out', () => {
  it('refuses every mutation and changes nothing', async () => {
    const { concertId, formId, publicSegment } = await scenario();
    const before = await readForm(formId);
    const formsBefore = await countForms();

    signOut();

    for (const [name, call] of Object.entries(mutations(concertId, formId, publicSegment))) {
      // `requireAdmin()` redirects rather than returning, so a refusal is a
      // thrown redirect — and anything that *returns* here got past the guard.
      await expect(call(), `${name} was not refused`).rejects.toThrow(RedirectSignal);
    }

    expect(await readForm(formId)).toEqual(before);
    expect(await countForms()).toBe(formsBefore);
  });
});

describe('signed in as an OPERATOR', () => {
  it('refuses every mutation and changes nothing', async () => {
    const { concertId, formId, publicSegment } = await scenario();
    const before = await readForm(formId);
    const formsBefore = await countForms();

    await signIn('OPERATOR');

    for (const [name, call] of Object.entries(mutations(concertId, formId, publicSegment))) {
      await expect(call(), `${name} was not refused`).rejects.toThrow(RedirectSignal);
    }

    // An operator is scoped to assigned shows and has no business on a form at
    // all (decision 20). The row proves the refusal happened before the write.
    expect(await readForm(formId)).toEqual(before);
    expect(await countForms()).toBe(formsBefore);
  });
});

describe('an admin of another concert', () => {
  it('cannot reach this concert’s form, and the row is unchanged', async () => {
    const mine = await scenario();
    const theirs = await createConcert(`Other ${randomUUID().slice(0, 8)}`);
    const before = await readForm(mine.formId);

    await signIn('ADMIN');

    // The shared ADMIN account can see every concert, so this is not a role
    // check — it is the join back to the concert that each action does, which
    // is what stops a form id from one concert being edited through another's
    // URL.
    for (const [name, call] of Object.entries(
      mutations(theirs, mine.formId, mine.publicSegment),
    )) {
      const result = await call();
      const error = 'error' in result ? result.error : null;
      expect(error, `${name} did not refuse a form from another concert`).toMatch(
        /no longer exists|not part of this concert/i,
      );
    }

    expect(await readForm(mine.formId)).toEqual(before);
  });
});

describe('the admin who owns the concert', () => {
  it('is allowed through all of it', async () => {
    const { concertId, formId, publicSegment } = await scenario();
    await signIn('ADMIN');

    // The counterweight to every refusal above: if the guards were refusing
    // everyone, the tests above would pass for the wrong reason.
    const calls = mutations(concertId, formId, publicSegment);

    expect((await calls.saveSchema()).error).toBeNull();
    expect((await calls.saveSettings()).error).toBeNull();
    expect((await calls.setStatus()).error).toBeNull();
    expect((await calls.export()).error).toBeNull();

    const after = await readForm(formId);
    expect(after.status).toBe('OPEN');
    expect(after.title).toBe('Renamed by someone else');
    expect(after.schema_version).toBe(2);
  });
});
