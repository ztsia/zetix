import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Does `/api/outbox/dispatch` still **call** its guard?
 *
 * A separate claim from "the guard works", and the one an independent QA pass
 * caught modules `D` and `F2` missing: deleting a `requireAdmin()` call left
 * their suites entirely green. This route sends real email to real people, and
 * `/api` is excluded from the proxy matcher, so an unguarded POST here drains
 * the outbox at a time nobody chose.
 */
const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const dispatchBatch = vi.fn();
vi.mock('@/lib/email/dispatch', () => ({ dispatchBatch: () => dispatchBatch() }));

const { POST } = await import('@/app/api/outbox/dispatch/route');

const post = (headers: Record<string, string> = {}) =>
  POST(new Request('https://zetix.vercel.app/api/outbox/dispatch', { method: 'POST', headers }));

const admin = { id: randomUUID(), role: 'ADMIN' as const, email: 'a@example.test', displayName: 'Admin' };
const operator = { ...admin, id: randomUUID(), role: 'OPERATOR' as const };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  dispatchBatch.mockResolvedValue({
    sent: 1, failed: 0, remaining: 0, dailyCapReached: false, warnings: [],
  });
});

describe('who may dispatch', () => {
  it('refuses an anonymous caller and sends nothing', async () => {
    sessionUser.mockResolvedValue(null);
    const response = await post();

    expect(response.status).toBe(401);
    expect(dispatchBatch).not.toHaveBeenCalled();
  });

  /**
   * An operator is signed in, so this is the case a bare "is there a session"
   * check would wave through. Ushers may not send mail to the audience.
   */
  it('refuses a signed-in operator', async () => {
    sessionUser.mockResolvedValue(operator);
    const response = await post();

    expect(response.status).toBe(401);
    expect(dispatchBatch).not.toHaveBeenCalled();
  });

  it('lets the admin through', async () => {
    sessionUser.mockResolvedValue(admin);
    const response = await post();

    expect(response.status).toBe(200);
    expect(dispatchBatch).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ sent: 1, remaining: 0 });
  });
});

describe('the cron caller', () => {
  it('lets the daily safety net in with the shared secret', async () => {
    process.env.CRON_SECRET = 'top-secret';
    sessionUser.mockResolvedValue(null);

    const response = await post({ authorization: 'Bearer top-secret' });

    expect(response.status).toBe(200);
    expect(dispatchBatch).toHaveBeenCalledTimes(1);
  });

  it('refuses a wrong secret rather than falling back to the session check', async () => {
    process.env.CRON_SECRET = 'top-secret';
    sessionUser.mockResolvedValue(null);

    expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect(dispatchBatch).not.toHaveBeenCalled();
  });
});

describe('configuration failures are reported as configuration failures', () => {
  /**
   * A missing `email.*` setting and an absent Gmail password otherwise present
   * identically — nothing sends and nothing says why — so they answer 503 with
   * the reason rather than a 500 that reads like the platform broke.
   */
  it('answers 503 with the reason when mail is not configured', async () => {
    const { MailNotConfiguredError } = await import('@/lib/email/config');
    sessionUser.mockResolvedValue(admin);
    dispatchBatch.mockRejectedValue(new MailNotConfiguredError('GMAIL_APP_PASSWORD'));

    const response = await post();

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('GMAIL_APP_PASSWORD');
  });

  it('answers 503 when an email setting is missing from the cascade', async () => {
    const { MissingSettingError } = await import('@/db/settings');
    sessionUser.mockResolvedValue(admin);
    dispatchBatch.mockRejectedValue(new MissingSettingError('email.max_per_dispatch'));

    const response = await post();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('email.max_per_dispatch');
  });
});
