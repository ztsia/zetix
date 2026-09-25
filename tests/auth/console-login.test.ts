import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';

/**
 * The console sign-in (spec/v3.md §28): named accounts, email and password,
 * throttled per IP **and** per account.
 *
 * Supabase Auth is the one leaf faked — no cloud session can create a real user
 * (spec/local.md §7). The throttle, the role lookup and the database are real,
 * so the rules asserted here are the shipping ones.
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
}));

let ip = '198.51.100.7';
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': ip }),
}));

/** email → { id, password } — what the fake Auth server knows. */
const accounts = new Map<string, { id: string; password: string }>();
const signOut = vi.fn(async () => ({ error: null }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const account = accounts.get(email.toLowerCase());
        if (!account || account.password !== password) {
          return { data: { user: null }, error: { message: 'Invalid login credentials' } };
        }
        return { data: { user: { id: account.id } }, error: null };
      },
      signOut,
    },
  }),
}));

const { signInConsole } = await import('@/lib/auth/actions');

const ADMIN = '00000000-0000-4000-8000-0000000000aa';
const VIEWER = '00000000-0000-4000-8000-0000000000bb';
const OPERATOR = '00000000-0000-4000-8000-000000000101';
const MAX_ATTEMPTS = 3;

function form(email: string, password: string, next?: string) {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  if (next) data.set('next', next);
  return data;
}

/** `redirect:<to>` on success, else the error the form would show. */
async function attempt(email: string, password: string, next?: string): Promise<string> {
  try {
    const state = await signInConsole({ error: null }, form(email, password, next));
    return state.error ?? 'no error, no redirect';
  } catch (error) {
    if (error instanceof RedirectSignal) return `redirect:${error.to}`;
    throw error;
  }
}

beforeEach(async () => {
  await resetDb();
  ip = '198.51.100.7';
  signOut.mockClear();
  accounts.clear();
  accounts.set('ana@example.test', { id: ADMIN, password: 'admin-pass' });
  accounts.set('mei@example.test', { id: VIEWER, password: 'viewer-pass' });
  accounts.set('wei@operators.invalid', { id: OPERATOR, password: 'op-code' });
  await sql`
    insert into app_users (id, email, display_name, role, is_active) values
      (${ADMIN}, 'ana@example.test', 'Ana', 'ADMIN', true),
      (${VIEWER}, 'mei@example.test', 'Mei', 'VIEWER', true),
      (${OPERATOR}, 'wei@operators.invalid', 'Wei', 'OPERATOR', true)
  `;
  await sql`
    insert into system_settings (key, value) values
      ('auth.admin_max_attempts', ${String(MAX_ATTEMPTS)}::text::jsonb),
      ('auth.admin_lockout_window_min', '10'::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
});

describe('signInConsole', () => {
  it('signs an admin in and lands on the console', async () => {
    expect(await attempt('ana@example.test', 'admin-pass')).toBe('redirect:/admin');
    const [row] = await sql`select last_login_at from app_users where id = ${ADMIN}`;
    expect(row!.last_login_at).not.toBeNull();
  });

  it('signs a viewer in too', async () => {
    expect(await attempt('Mei@Example.test', 'viewer-pass')).toBe('redirect:/admin');
  });

  it('honours a same-site next, and ignores an off-site one', async () => {
    expect(await attempt('ana@example.test', 'admin-pass', '/admin/settings')).toBe(
      'redirect:/admin/settings',
    );
    expect(await attempt('ana@example.test', 'admin-pass', 'https://evil.example')).toBe(
      'redirect:/admin',
    );
  });

  it('refuses a wrong password with the same sentence as an unknown address', async () => {
    const wrong = await attempt('ana@example.test', 'nope');
    const unknown = await attempt('nobody@example.test', 'nope');
    expect(wrong).toBe(unknown);
    expect(wrong).toMatch(/not recognised/);
  });

  it('refuses an operator here, and ends the session Supabase just made', async () => {
    expect(await attempt('wei@operators.invalid', 'op-code')).toMatch(/not recognised/);
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('refuses a deactivated account', async () => {
    await sql`update app_users set is_active = false where id = ${VIEWER}`;
    expect(await attempt('mei@example.test', 'viewer-pass')).toMatch(/not recognised/);
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('locks an account out even when every guess comes from a different IP', async () => {
    // The per-account bucket (spec/v3.md §28). Rotating addresses defeats the
    // IP bucket alone; it must not defeat this one.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      ip = `203.0.113.${i + 1}`;
      await attempt('ana@example.test', `guess-${i}`);
    }
    ip = '203.0.113.200';
    // Even the right password is refused while the account is locked.
    expect(await attempt('ana@example.test', 'admin-pass')).toMatch(/Too many attempts/);
  });

  it('locks an IP out even when every guess is at a different account', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) await attempt(`nobody-${i}@example.test`, 'x');
    expect(await attempt('mei@example.test', 'viewer-pass')).toMatch(/Too many attempts/);
  });

  it('does not spread one locked account to everyone on its IP', async () => {
    // Lock ana's account from elsewhere, then let her retry from the office
    // until well past the threshold. Those retries are refused without
    // reaching Supabase, so they must not also charge the office IP.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      ip = `203.0.113.${i + 1}`;
      await attempt('ana@example.test', `guess-${i}`);
    }
    ip = '192.0.2.50';
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      expect(await attempt('ana@example.test', 'admin-pass')).toMatch(/Too many attempts/);
    }
    expect(await attempt('mei@example.test', 'viewer-pass')).toBe('redirect:/admin');
  });

  it('says "locked out" on the attempt that causes it', async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      expect(await attempt('ana@example.test', 'nope')).toMatch(/not recognised/);
    }
    expect(await attempt('ana@example.test', 'nope')).toMatch(/Too many attempts/);
  });

  it('clears both buckets on success', async () => {
    await attempt('ana@example.test', 'nope');
    await attempt('ana@example.test', 'admin-pass');
    const rows = await sql`select bucket from auth_failures`;
    expect(rows).toHaveLength(0);
  });

  it('refuses to sign anyone in when the throttle is not configured', async () => {
    await sql`delete from system_settings where key like 'auth.%'`;
    expect(await attempt('ana@example.test', 'admin-pass')).toMatch(/throttle is not configured/);
  });
});
