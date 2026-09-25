import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';

/**
 * Settings › People's actions refuse bad input with a sentence, and write
 * nothing (spec/v3.md §28). The Auth port is faked: no cloud session holds the
 * service-role key.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
const ADMIN = { id: '00000000-0000-4000-8000-0000000000aa', email: 'a@x.test', displayName: 'Ana', role: 'ADMIN' };
vi.mock('@/lib/auth/session', () => ({ getSessionUser: async () => ADMIN, recordLogin: async () => {} }));
const createUser = vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000299' }));
vi.mock('@/lib/operators/auth-admin', () => ({
  createAuthAdmin: () => ({ createUser, updatePassword: async () => {}, deleteUser: async () => {} }),
}));

const { createAccountAction, setRoleAction } = await import('@/app/(admin)/admin/settings/people/actions');

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(async () => {
  await resetDb();
  createUser.mockClear();
  await sql`insert into app_users (id, email, role) values (${ADMIN.id}, ${ADMIN.email}, 'ADMIN')`;
});

describe('createAccountAction', () => {
  it('refuses an address longer than any mail system accepts', async () => {
    const email = `${'a'.repeat(250)}@x.test`;
    const result = await createAccountAction({ error: null }, form({ email, displayName: 'Long', role: 'VIEWER' }));
    expect(result.error).toMatch(/too long/);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('refuses a role outside Admin and Viewer in words, not a validator dump', async () => {
    const result = await createAccountAction(
      { error: null },
      form({ email: 'n@x.test', displayName: 'N', role: 'OPERATOR' }),
    );
    expect(result.error).toBe('Choose Admin or Viewer.');
    expect(createUser).not.toHaveBeenCalled();
  });

  it('creates an account and returns its password once', async () => {
    const result = await createAccountAction(
      { error: null },
      form({ email: 'New@X.test', displayName: 'Nia', role: 'VIEWER' }),
    );
    expect(result.error).toBeNull();
    expect(result.issued).toMatchObject({ email: 'new@x.test', displayName: 'Nia' });
    expect(result.issued!.password.length).toBeGreaterThan(20);
  });
});

describe('setRoleAction', () => {
  it('refuses a made-up role', async () => {
    expect((await setRoleAction(ADMIN.id, 'SUPERUSER')).error).toBe('Malformed request.');
  });
});
