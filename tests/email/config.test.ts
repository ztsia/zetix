import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the transport points, and the two ways it silently fails to.
 *
 * `src/lib/env.ts` caches, so every test here re-imports the module graph after
 * setting the environment. Without the reset the second test in the file would
 * assert against the first one's config.
 */
const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  DATABASE_URL: 'postgresql://postgres@localhost:55432/zetix',
  APP_URL: 'https://zetix.vercel.app',
  GMAIL_USER: 'tickets@example.org',
};

async function loadConfig(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'GMAIL_APP_PASSWORD']) {
    delete process.env[key];
  }
  Object.assign(process.env, BASE_ENV);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('@/lib/email/config');
}

const saved = { ...process.env };
beforeEach(() => vi.resetModules());
afterEach(() => {
  process.env = { ...saved };
});

describe('production points at Gmail', () => {
  it('uses 465 with implicit TLS when nothing overrides it', async () => {
    const { resolveSmtpConfig } = await loadConfig({ GMAIL_APP_PASSWORD: 'abcdefghijklmnop' });
    const config = resolveSmtpConfig();

    expect(config.host).toBe('smtp.gmail.com');
    expect(config.port).toBe(465);
    expect(config.secure).toBe(true);
  });

  /**
   * Google's UI shows an app password as four groups of four. Pasted verbatim
   * it is 19 characters, and Gmail answers a bare `535` that names nothing.
   */
  it('strips the spaces Google puts in a displayed app password', async () => {
    const { resolveSmtpConfig } = await loadConfig({ GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
    expect(resolveSmtpConfig().pass).toBe('abcdefghijklmnop');
  });

  it('refuses to run with no app password rather than failing at send time', async () => {
    const { resolveSmtpConfig, MailNotConfiguredError } = await loadConfig({});
    expect(() => resolveSmtpConfig()).toThrow(MailNotConfiguredError);
  });
});

describe('development points at a sink', () => {
  /**
   * The swap this design exists for: host, port and `secure` are the only
   * things that differ, so moving between a sink and Gmail is configuration.
   */
  it('follows the override, with no credential required', async () => {
    const { resolveSmtpConfig } = await loadConfig({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525' });
    const config = resolveSmtpConfig();

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(2525);
    // A plaintext sink, and inferred rather than stated: only 465 is implicit TLS.
    expect(config.secure).toBe(false);
    expect(config.pass).toBe('');
  });

  it('still lets secure be forced on for a TLS sink', async () => {
    const { resolveSmtpConfig } = await loadConfig({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '2525',
      SMTP_SECURE: 'true',
    });
    expect(resolveSmtpConfig().secure).toBe(true);
  });
});
