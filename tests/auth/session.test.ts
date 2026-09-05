import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDb, sql } from '../helpers/db';

/**
 * `getSessionUser()` — who this is, and whether they may be here
 * (spec/admin.md §14.3, spec/domain.md §5.1).
 *
 * An independent QA pass found this module had **no coverage at all**: every
 * guard test mocks it wholesale, so the code that actually resolves identity and
 * role never ran. Deleting its `is_active` check left the suite green — and that
 * check is the entire mechanism behind "deactivating an operator invalidates
 * their session at the next request".
 *
 * Supabase Auth is stubbed here because there is no service-role key in a cloud
 * container to create real users with (spec/local.md §7). Everything below the
 * Auth call — the `app_users` lookup and every rule applied to it — is the real
 * module against a real Postgres, which is where the rules live.
 */
const authUser = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => authUser() },
  }),
}));

// React's `cache()` dedupes within a request; under Vitest there is no request,
// and a memoised first answer would make every later case read the first one.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T,>(fn: T) => fn };
});

const { getSessionUser, recordLogin } = await import('@/lib/auth/session');

const signedInAs = (id: string) => authUser.mockResolvedValue({ data: { user: { id } }, error: null });
const signedOut = () => authUser.mockResolvedValue({ data: { user: null }, error: null });

async function insertUser(
  role: 'ADMIN' | 'OPERATOR',
  opts: { isActive?: boolean; deletedAt?: string | null; displayName?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role, is_active, deleted_at)
    values (
      ${id}::uuid,
      ${`${role.toLowerCase()}-${id}@example.test`},
      ${opts.displayName ?? role},
      ${role}::user_role,
      ${opts.isActive ?? true},
      ${opts.deletedAt ?? null}
    )
  `;
  return id;
}

beforeEach(async () => {
  await resetDb();
  authUser.mockReset();
});

describe('getSessionUser', () => {
  it('resolves an active user to their app_users role', async () => {
    const id = await insertUser('ADMIN', { displayName: 'Committee' });
    signedInAs(id);

    const user = await getSessionUser();
    expect(user).toMatchObject({ id, role: 'ADMIN', displayName: 'Committee' });
  });

  it('returns null when nobody is signed in', async () => {
    signedOut();
    expect(await getSessionUser()).toBeNull();
  });

  it('returns null when Supabase reports an error', async () => {
    authUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    expect(await getSessionUser()).toBeNull();
  });

  it('refuses a deactivated account, though its Auth session is still valid', async () => {
    // This is what makes "deactivating an operator invalidates their session at
    // the next request" true without reaching into Auth to revoke anything.
    const id = await insertUser('OPERATOR', { isActive: false });
    signedInAs(id);
    expect(await getSessionUser()).toBeNull();
  });

  it('refuses a soft-deleted account', async () => {
    const id = await insertUser('OPERATOR', { deletedAt: new Date().toISOString() });
    signedInAs(id);
    expect(await getSessionUser()).toBeNull();
  });

  it('refuses an authenticated user with no app_users row at all', async () => {
    // Authentication without authorisation: Supabase knows them, we do not.
    signedInAs(randomUUID());
    expect(await getSessionUser()).toBeNull();
  });

  it('takes the role from the database, never from the caller', async () => {
    const id = await insertUser('OPERATOR');
    signedInAs(id);
    expect((await getSessionUser())?.role).toBe('OPERATOR');

    // Revoking in the database takes effect immediately — no token refresh.
    await sql`update app_users set role = 'ADMIN' where id = ${id}::uuid`;
    expect((await getSessionUser())?.role).toBe('ADMIN');
  });

  it('validates the token with getUser(), not getSession()', async () => {
    // `getSession()` decodes whatever the cookie says without asking anyone, so
    // a forged cookie would read as a valid session.
    const id = await insertUser('ADMIN');
    signedInAs(id);
    await getSessionUser();
    expect(authUser).toHaveBeenCalled();
  });
});

describe('recordLogin', () => {
  it('stamps last_login_at', async () => {
    const id = await insertUser('OPERATOR');
    await recordLogin(id);
    const [row] = await sql<{ last_login_at: Date | null }[]>`
      select last_login_at from app_users where id = ${id}::uuid
    `;
    expect(row.last_login_at).not.toBeNull();
  });

  it('never throws a sign-in away over a failed stamp', async () => {
    await expect(recordLogin(randomUUID())).resolves.toBeUndefined();
  });
});
