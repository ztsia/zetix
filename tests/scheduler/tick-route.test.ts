import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tick route's door (spec/v3.md §27.1–§27.2): a bearer secret and nothing
 * else, both verbs, and the cron pointed at it. The work behind it is
 * `tick.test.ts`'s.
 */

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => sessionUser(), recordLogin: async () => {} }));

const runTick = vi.fn();
vi.mock('@/lib/scheduler/tick', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scheduler/tick')>()),
  runTick: (options: unknown) => runTick(options),
}));

const route = await import('@/app/api/scheduler/tick/route');
const url = 'https://zetix.vercel.app/api/scheduler/tick';

beforeEach(() => {
  runTick.mockReset();
  runTick.mockResolvedValue({ ok: true });
  sessionUser.mockReset();
  process.env.CRON_SECRET = 'tick-secret';
});

describe('who may call it', () => {
  it('refuses a missing or wrong bearer, on both verbs, before doing anything', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'tick-secret' }] as Record<string, string>[]) {
      expect((await route.GET(new Request(url, { headers }))).status).toBe(401);
      expect((await route.POST(new Request(url, { method: 'POST', headers }))).status).toBe(401);
    }
    expect(runTick).not.toHaveBeenCalled();
  });

  it('does not let a signed-in admin in: the route is the scheduler’s alone', async () => {
    sessionUser.mockResolvedValue({ id: 'x', email: 'a@x', role: 'ADMIN' });
    expect((await route.POST(new Request(url, { method: 'POST' }))).status).toBe(401);
    expect(runTick).not.toHaveBeenCalled();
  });

  it('refuses everyone when CRON_SECRET is unset, rather than admitting everyone', async () => {
    delete process.env.CRON_SECRET;
    expect((await route.GET(new Request(url, { headers: { authorization: 'Bearer ' } }))).status).toBe(401);
    expect((await route.GET(new Request(url, { headers: { authorization: 'Bearer undefined' } }))).status).toBe(401);
    expect(runTick).not.toHaveBeenCalled();
  });
});

describe('what it records as the caller', () => {
  it('takes pg_cron from the body pg_net posts', async () => {
    const response = await route.POST(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer tick-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'pg_cron' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(runTick).toHaveBeenCalledWith({ source: 'pg_cron' });
  });

  it('records a GET as the Vercel cron, and an unknown body source as unknown', async () => {
    await route.GET(new Request(url, { headers: { authorization: 'Bearer tick-secret' } }));
    await route.POST(
      new Request(url, { method: 'POST', headers: { authorization: 'Bearer tick-secret' }, body: '{"source":"<script>"}' }),
    );
    await route.POST(new Request(url, { method: 'POST', headers: { authorization: 'Bearer tick-secret' }, body: 'not json' }));
    expect(runTick.mock.calls.map(([o]) => o)).toEqual([
      { source: 'vercel_cron' },
      { source: 'unknown' },
      { source: 'unknown' },
    ]);
  });
});

describe('where it runs', () => {
  it('is a Node route with the 60s ceiling the tick budget is sized against', async () => {
    const { MAX_DISPATCH_SECONDS } = await import('@/lib/email/dispatch');
    const { TICK_BUDGET_MS } = await import('@/lib/scheduler/tick');
    expect(route.runtime).toBe('nodejs');
    expect(route.maxDuration).toBe(MAX_DISPATCH_SECONDS);
    expect(TICK_BUDGET_MS).toBeLessThan(route.maxDuration * 1000);
  });

  it('is what the daily Vercel cron calls (§27.2 repoints it here)', async () => {
    const vercel = JSON.parse(await readFile('vercel.json', 'utf8')) as { crons: { path: string }[] };
    expect(vercel.crons.map((c) => c.path)).toContain('/api/scheduler/tick');
  });
});
