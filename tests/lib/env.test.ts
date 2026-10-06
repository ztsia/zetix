import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `env()` treats an empty variable as unset.
 *
 * `pnpm demo` blanks every key `.env.local` defines, so no production value
 * can reach it. A blank `ADMIN_EMAIL` then failed `.email()` and every `env()`
 * caller — dispatch, the inbox, the tick — died with "Invalid environment",
 * leaving a message claimed in SENDING (QA, module X, finding 4).
 */

const REQUIRED = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub',
  DATABASE_URL: 'postgresql://postgres@localhost:55432/zetix',
  APP_URL: 'http://localhost:3100',
};

async function freshEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...vars })) vi.stubEnv(key, value);
  const { env } = await import('@/lib/env');
  return env();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('env()', () => {
  it('reads blank optional variables as unset rather than invalid', async () => {
    const e = await freshEnv({ ADMIN_EMAIL: '', SMTP_PORT: '', IMAP_SECURE: '', GMAIL_USER: '', IMAP_HOST: '' });

    expect(e.ADMIN_EMAIL).toBeUndefined();
    expect(e.SMTP_PORT).toBeUndefined();
    expect(e.IMAP_SECURE).toBeUndefined();
    expect(e.GMAIL_USER).toBeUndefined();
    // Not an override: blank must not point the inbox at host ''.
    expect(e.IMAP_HOST).toBeUndefined();
  });

  it('still refuses a value that is set and wrong', async () => {
    await expect(freshEnv({ ADMIN_EMAIL: 'not-an-address' })).rejects.toThrow(/ADMIN_EMAIL/);
  });

  it('still refuses a blank required variable', async () => {
    await expect(freshEnv({ APP_URL: '' })).rejects.toThrow(/APP_URL/);
  });
});
