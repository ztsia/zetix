import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthAdmin } from '@/lib/operators/auth-admin';
import { closeDb, newConnection, resetDb, sql } from '../helpers/db';

/**
 * Settings › People (spec/v3.md §28): named console accounts.
 *
 * Real Postgres, fake Supabase Auth — the split `tests/operators/provision.test.ts`
 * explains. The rules that matter most are the ones that keep the console from
 * losing its last admin, so those are tested hardest, including two demotions
 * racing each other.
 */
const ADMIN_A = '00000000-0000-4000-8000-0000000000aa';
const ADMIN_B = '00000000-0000-4000-8000-0000000000ab';
const VIEWER = '00000000-0000-4000-8000-0000000000bb';
const OPERATOR = '00000000-0000-4000-8000-000000000101';

const {
  createConsoleAccount,
  resetConsolePassword,
  setConsoleRole,
  setConsoleActive,
  renameConsoleAccount,
  listConsoleAccounts,
  PeopleProvisionError,
  CONSOLE_PASSWORD_LENGTH,
} = await import('@/lib/people/provision');

afterAll(closeDb);

function fakeAuth(overrides: Partial<AuthAdmin> = {}) {
  const created: Array<{ id: string; email: string; password: string }> = [];
  const deleted: string[] = [];
  const passwords = new Map<string, string>();
  let next = 1;
  const auth: AuthAdmin = {
    async createUser(email, password) {
      const id = `00000000-0000-4000-8000-0000000002${String(next++).padStart(2, '0')}`;
      created.push({ id, email, password });
      return { id };
    },
    async updatePassword(userId, password) {
      passwords.set(userId, password);
    },
    async deleteUser(userId) {
      deleted.push(userId);
    },
    ...overrides,
  };
  return { auth, created, deleted, passwords };
}

async function user(id: string) {
  const [row] = await sql`select role, is_active, display_name from app_users where id = ${id}`;
  return row!;
}

async function audit(action: string) {
  return sql`select entity_id, actor_id, before, after from audit_log where action = ${action}`;
}

beforeEach(async () => {
  await resetDb();
  await sql`
    insert into app_users (id, email, display_name, role, is_active) values
      (${ADMIN_A}, 'a@example.test', 'Ana', 'ADMIN', true),
      (${VIEWER}, 'v@example.test', 'Mei', 'VIEWER', true),
      (${OPERATOR}, 'wei@operators.invalid', 'Wei', 'OPERATOR', true)
  `;
});

describe('createConsoleAccount', () => {
  it('creates the Auth user and the row that gives it a role, and hands back the password once', async () => {
    const { auth, created } = fakeAuth();
    const account = await createConsoleAccount(
      { email: '  New.Person@Example.test ', displayName: ' Nia ', role: 'VIEWER', actorId: ADMIN_A },
      auth,
    );

    expect(account.email).toBe('new.person@example.test');
    expect(created).toEqual([{ id: account.userId, email: account.email, password: account.password }]);
    // Twenty characters of entropy, grouped in fours.
    expect(account.password.replaceAll('-', '')).toHaveLength(CONSOLE_PASSWORD_LENGTH);
    expect(await user(account.userId)).toMatchObject({ role: 'VIEWER', is_active: true, display_name: 'Nia' });

    const [row] = await audit('account.created');
    expect(row).toMatchObject({ entity_id: account.userId, actor_id: ADMIN_A });
    expect(JSON.stringify(row)).not.toContain(account.password);
  });

  it('refuses an address that already has an account, before Supabase is touched', async () => {
    const { auth, created } = fakeAuth();
    await expect(
      createConsoleAccount({ email: 'V@example.test', displayName: 'Dup', role: 'ADMIN', actorId: ADMIN_A }, auth),
    ).rejects.toBeInstanceOf(PeopleProvisionError);
    expect(created).toHaveLength(0);
  });

  it('refuses an operator sign-in address — ushers are provisioned per concert', async () => {
    const { auth, created } = fakeAuth();
    await expect(
      createConsoleAccount(
        { email: 'someone@operators.invalid', displayName: 'X', role: 'VIEWER', actorId: ADMIN_A },
        auth,
      ),
    ).rejects.toThrow(/operator sign-in address/);
    expect(created).toHaveLength(0);
  });

  it('removes the Auth user again when the row cannot be written', async () => {
    // The id collides with an existing row, so the insert fails after Auth
    // already holds the user — the orphan this cleanup exists for.
    const { auth, deleted } = fakeAuth({ createUser: async () => ({ id: VIEWER }) });
    await expect(
      createConsoleAccount({ email: 'fresh@example.test', displayName: 'F', role: 'ADMIN', actorId: ADMIN_A }, auth),
    ).rejects.toThrow();
    expect(deleted).toEqual([VIEWER]);
  });
});

describe('setConsoleRole', () => {
  it('promotes a viewer and records it', async () => {
    await setConsoleRole({ userId: VIEWER, role: 'ADMIN', actorId: ADMIN_A });
    expect((await user(VIEWER)).role).toBe('ADMIN');
    const [row] = await audit('account.role_changed');
    expect(row).toMatchObject({ before: { role: 'VIEWER' }, after: { role: 'ADMIN' }, actor_id: ADMIN_A });
  });

  it('refuses to change your own role', async () => {
    await expect(setConsoleRole({ userId: ADMIN_A, role: 'VIEWER', actorId: ADMIN_A })).rejects.toThrow(
      /your own role/,
    );
    expect((await user(ADMIN_A)).role).toBe('ADMIN');
  });

  it('refuses to demote the only active admin', async () => {
    // Deactivated admins do not count: they cannot sign in to undo anything.
    await sql`insert into app_users (id, email, role, is_active) values (${ADMIN_B}, 'b@example.test', 'ADMIN', false)`;
    await expect(setConsoleRole({ userId: ADMIN_A, role: 'VIEWER', actorId: VIEWER })).rejects.toThrow(
      /only active admin/,
    );
    expect((await user(ADMIN_A)).role).toBe('ADMIN');
  });

  it('lets one of two admins be demoted', async () => {
    await sql`insert into app_users (id, email, role, is_active) values (${ADMIN_B}, 'b@example.test', 'ADMIN', true)`;
    await setConsoleRole({ userId: ADMIN_B, role: 'VIEWER', actorId: ADMIN_A });
    expect((await user(ADMIN_B)).role).toBe('VIEWER');
  });

  it('never leaves zero admins when two admins demote each other at once', async () => {
    // The app's pool is one connection, so two calls from here would simply
    // queue. The race is staged with a second session instead: it takes the
    // admin locks exactly as the app does and demotes B, and holds them while
    // the app tries to demote A. The app must wait, then see B already gone.
    await sql`insert into app_users (id, email, role, is_active) values (${ADMIN_B}, 'b@example.test', 'ADMIN', true)`;
    const other = newConnection();
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const hasLocks = new Promise<void>((resolve) => (locked = resolve));

      const rival = other.begin(async (tx) => {
        await tx`select id from app_users where role = 'ADMIN' and is_active and deleted_at is null order by id for update`;
        await tx`update app_users set role = 'VIEWER' where id = ${ADMIN_B}`;
        locked();
        await held;
      });

      await hasLocks;
      const ours = setConsoleRole({ userId: ADMIN_A, role: 'VIEWER', actorId: ADMIN_B });
      // Give ours time to reach the lock and block on it.
      await new Promise((r) => setTimeout(r, 200));
      release();
      await rival;

      await expect(ours).rejects.toThrow(/only active admin/);
      const [{ n }] = await sql`select count(*)::int as n from app_users where role = 'ADMIN' and is_active`;
      expect(n).toBe(1);
    } finally {
      await other.end();
    }
  });

  it('will not touch an operator', async () => {
    await expect(setConsoleRole({ userId: OPERATOR, role: 'ADMIN', actorId: ADMIN_A })).rejects.toThrow(
      /not a console account/,
    );
    expect((await user(OPERATOR)).role).toBe('OPERATOR');
  });
});

describe('setConsoleActive', () => {
  it('deactivates a viewer and restores them', async () => {
    await setConsoleActive({ userId: VIEWER, isActive: false, actorId: ADMIN_A });
    expect((await user(VIEWER)).is_active).toBe(false);
    await setConsoleActive({ userId: VIEWER, isActive: true, actorId: ADMIN_A });
    expect((await user(VIEWER)).is_active).toBe(true);
    expect(await audit('account.deactivated')).toHaveLength(1);
    expect(await audit('account.reactivated')).toHaveLength(1);
  });

  it('refuses to deactivate yourself', async () => {
    await expect(setConsoleActive({ userId: ADMIN_A, isActive: false, actorId: ADMIN_A })).rejects.toThrow(
      /your own account/,
    );
  });

  it('refuses to deactivate the only active admin', async () => {
    await expect(setConsoleActive({ userId: ADMIN_A, isActive: false, actorId: VIEWER })).rejects.toThrow(
      /only active admin/,
    );
    expect((await user(ADMIN_A)).is_active).toBe(true);
  });
});

describe('resetConsolePassword and renameConsoleAccount', () => {
  it('sets a fresh password in Auth and keeps it out of the log', async () => {
    const { auth, passwords } = fakeAuth();
    const { password } = await resetConsolePassword({ userId: VIEWER, actorId: ADMIN_A }, auth);
    expect(passwords.get(VIEWER)).toBe(password);
    const rows = await audit('account.password_reset');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(password);
  });

  it('will not reset an operator’s code from here', async () => {
    const { auth, passwords } = fakeAuth();
    await expect(resetConsolePassword({ userId: OPERATOR, actorId: ADMIN_A }, auth)).rejects.toBeInstanceOf(
      PeopleProvisionError,
    );
    expect(passwords.size).toBe(0);
  });

  it('renames an account', async () => {
    await renameConsoleAccount({ userId: VIEWER, displayName: ' Mei Lin ', actorId: ADMIN_A });
    expect((await user(VIEWER)).display_name).toBe('Mei Lin');
  });
});

describe('listConsoleAccounts', () => {
  it('lists admins and viewers, never operators', async () => {
    const ids = (await listConsoleAccounts()).map((a) => a.id);
    expect(ids.sort()).toEqual([ADMIN_A, VIEWER].sort());
  });
});
