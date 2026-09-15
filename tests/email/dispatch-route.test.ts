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
/**
 * Only `dispatchBatch` is replaced. `MAX_DISPATCH_SECONDS` comes through from
 * the real module, because the test below compares it against the route's
 * `maxDuration` — a mocked constant would compare the file with itself.
 */
vi.mock('@/lib/email/dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/dispatch')>()),
  dispatchBatch: () => dispatchBatch(),
}));

const autoCompleteShows = vi.fn();
vi.mock('@/lib/shows/complete', () => ({ autoCompleteShows: () => autoCompleteShows() }));

const { GET, POST } = await import('@/app/api/outbox/dispatch/route');

const post = (headers: Record<string, string> = {}) =>
  POST(new Request('https://zetix.vercel.app/api/outbox/dispatch', { method: 'POST', headers }));

const get = (headers: Record<string, string> = {}) =>
  GET(new Request('https://zetix.vercel.app/api/outbox/dispatch', { method: 'GET', headers }));

const admin = { id: randomUUID(), role: 'ADMIN' as const, email: 'a@example.test', displayName: 'Admin' };
const operator = { ...admin, id: randomUUID(), role: 'OPERATOR' as const };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  dispatchBatch.mockResolvedValue({
    sent: 1, failed: 0, remaining: 0, dailyCapReached: false, warnings: [],
  });
  autoCompleteShows.mockResolvedValue([]);
});

/**
 * **Vercel Cron issues a `GET`.** Until module `N` hung show auto-completion off
 * this route, it exported only `POST` — so the daily safety net in `vercel.json`
 * answered `405` every day, silently, because nothing reads a cron's response.
 *
 * These are the tests that keep the hook real. Without the first one, the sweep
 * and the outbox safety net are both dead and nothing says so until somebody
 * asks where the tickets went.
 */
describe('the verb the daily cron actually sends', () => {
  it('answers a GET, because that is what Vercel Cron issues', async () => {
    process.env.CRON_SECRET = 'top-secret';
    sessionUser.mockResolvedValue(null);

    const response = await get({ authorization: 'Bearer top-secret' });

    expect(response.status).toBe(200);
    expect(dispatchBatch).toHaveBeenCalledTimes(1);
  });

  it('guards the GET exactly as it guards the POST', async () => {
    sessionUser.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(dispatchBatch).not.toHaveBeenCalled();
    expect(autoCompleteShows).not.toHaveBeenCalled();
  });

  it('points vercel.json at this path, so the cron and the handler agree', async () => {
    const { readFile } = await import('node:fs/promises');
    const vercel = JSON.parse(await readFile('vercel.json', 'utf8')) as {
      crons: { path: string }[];
    };
    expect(vercel.crons.map((c) => c.path)).toContain('/api/outbox/dispatch');
  });
});

describe('the show sweep rides the cron, not the Send button', () => {
  it('sweeps on the cron GET', async () => {
    process.env.CRON_SECRET = 'top-secret';
    sessionUser.mockResolvedValue(null);
    autoCompleteShows.mockResolvedValue([
      { showId: 1, showName: 'Evening', queued: 3 },
    ]);

    const response = await get({ authorization: 'Bearer top-secret' });

    expect(autoCompleteShows).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      completions: [{ showId: 1, queued: 3 }],
    });
  });

  it('does not sweep when an admin presses Send', async () => {
    /**
     * Send drains a queue. Completing a show is a status change, and §13.5.3's
     * manual twin for it is the show's status dialog — which is where an admin
     * would look for it, and where they can see what they are doing.
     */
    sessionUser.mockResolvedValue(admin);
    await post();
    expect(autoCompleteShows).not.toHaveBeenCalled();
  });

  it('still drains the queue when the sweep throws', async () => {
    /**
     * The outbox safety net is what this cron exists for (spec/email.md §11.2
     * step 4). Tickets nobody received matter more than a flag nobody looks at.
     */
    process.env.CRON_SECRET = 'top-secret';
    sessionUser.mockResolvedValue(null);
    autoCompleteShows.mockRejectedValue(new Error('shows table is on fire'));

    const response = await get({ authorization: 'Bearer top-secret' });

    expect(response.status).toBe(200);
    expect(dispatchBatch).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ sweepError: 'shows table is on fire' });
  });
});

describe('the function limits', () => {
  /**
   * The reclaim window in `dispatch.ts` is a multiple of how long a dispatch can
   * possibly run, and takes that from `MAX_DISPATCH_SECONDS`. Next requires
   * `maxDuration` to be a literal, so the two cannot share one constant — a
   * window shorter than the function's own runtime would take rows back from a
   * dispatch still using them, and send them twice.
   */
  it('keeps maxDuration and the reclaim window’s assumption in step', async () => {
    const route = await import('@/app/api/outbox/dispatch/route');
    const { MAX_DISPATCH_SECONDS } = await import('@/lib/email/dispatch');

    expect(route.maxDuration).toBe(MAX_DISPATCH_SECONDS);
    // Vercel Hobby's ceiling (§11.1), against a 10s default.
    expect(route.maxDuration).toBe(60);
  });

  it('runs on the Node runtime, because the Edge runtime has no TCP sockets', async () => {
    const route = await import('@/app/api/outbox/dispatch/route');
    expect(route.runtime).toBe('nodejs');
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
