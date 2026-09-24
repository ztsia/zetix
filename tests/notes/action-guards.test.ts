import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Do module `O`'s admin surfaces **call** their guards?
 *
 * The same claim `N` and `M` each found their branch missing: a guard that is
 * absent leaves every other test green, which is the worst shape a gap can
 * take. `O`'s surfaces are a strong reason to ask it again — between them they
 * publish an attendee's words to everyone holding a ticket, and hand over a
 * spreadsheet of every note, attributed, including writers who asked the wall
 * not to name them.
 *
 * Two entry points, guarded differently and both covered:
 *
 * - **Server Actions** are their own entry point. The page's `requireAdmin()`
 *   does not cover them and the proxy never reads a role (modules.md §5.2.1).
 * - **`/api` is excluded from the proxy matcher entirely**, so the export route
 *   is unprotected until it checks for itself.
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

/** Stubbed: this file is about reaching the mutation, not what it does. */
const stub = {
  queueNotesDigest: vi.fn(),
  writeAuditLog: vi.fn(),
  loadNotesScreen: vi.fn(),
};

vi.mock('@/lib/email/notes-digest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/notes-digest')>()),
  queueNotesDigest: () => stub.queueNotesDigest(),
}));
vi.mock('@/lib/audit', () => ({ writeAuditLog: () => stub.writeAuditLog() }));
vi.mock('@/app/(admin)/admin/concerts/[concertId]/notes/queries', () => ({
  loadNotesScreen: () => stub.loadNotesScreen(),
}));

const actions = await import('@/app/(admin)/admin/concerts/[concertId]/notes/actions');
const exportRoute = await import('@/app/api/notes/export/route');
const { NextRequest } = await import('next/server');

const admin = { id: randomUUID(), role: 'ADMIN' as const, email: 'a@test', displayName: 'Admin' };
const operator = { ...admin, id: randomUUID(), role: 'OPERATOR' as const };

beforeEach(() => {
  vi.resetAllMocks();
  stub.queueNotesDigest.mockResolvedValue({
    queued: 1, alreadyPending: 0, skipped: [], unknownTokens: [],
  });
  stub.writeAuditLog.mockResolvedValue(undefined);
  stub.loadNotesScreen.mockResolvedValue({
    concertName: 'Concert', notes: [], groups: [], shows: [], players: [],
  });
});

const ACTIONS: { name: string; run: () => Promise<unknown> }[] = [
  { name: 'moderateNotesAction', run: () => actions.moderateNotesAction(1, [1], 'APPROVED') },
  { name: 'setNotesOnWallAction (publish)', run: () => actions.setNotesOnWallAction(1, [1], true) },
  { name: 'setNotesOnWallAction (unpublish)', run: () => actions.setNotesOnWallAction(1, [1], false) },
  { name: 'queueDigestAction', run: () => actions.queueDigestAction(1, [1]) },
];

describe.each(ACTIONS)('$name', ({ run }) => {
  it('redirects an anonymous caller to the login form', async () => {
    sessionUser.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(RedirectSignal);
  });

  /** An operator is signed in — the case a bare session check waves through. */
  it('turns a signed-in operator away', async () => {
    sessionUser.mockResolvedValue(operator);
    await expect(run()).rejects.toThrow(RedirectSignal);
  });
});

describe('queueDigestAction reaches the outbox only for an admin', () => {
  it('never queues for an operator', async () => {
    sessionUser.mockResolvedValue(operator);
    await expect(actions.queueDigestAction(1, [1])).rejects.toThrow(RedirectSignal);
    expect(stub.queueNotesDigest).not.toHaveBeenCalled();
  });

  it('queues for an admin', async () => {
    sessionUser.mockResolvedValue(admin);
    await actions.queueDigestAction(1, [1]);
    expect(stub.queueNotesDigest).toHaveBeenCalled();
  });
});

/**
 * The export is a Route Handler because an Action cannot stream a file, which
 * puts it outside the proxy matcher and makes its own check the only one.
 *
 * §14.2 makes the grouped view admin-only *always*, whatever
 * `portal.public_wall_visibility` says (decision 6) — and this file is that
 * view in a spreadsheet, carrying the real name of every writer who asked the
 * wall not to show it.
 */
describe('GET /api/notes/export', () => {
  const get = () =>
    exportRoute.GET(
      new NextRequest('https://zetix.vercel.app/api/notes/export?concertId=1'),
    );

  it('refuses an anonymous caller and reads nothing', async () => {
    sessionUser.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(stub.loadNotesScreen).not.toHaveBeenCalled();
  });

  it('refuses a signed-in operator and reads nothing', async () => {
    sessionUser.mockResolvedValue(operator);
    expect((await get()).status).toBe(403);
    expect(stub.loadNotesScreen).not.toHaveBeenCalled();
  });

  it('serves an admin a CSV attachment', async () => {
    sessionUser.mockResolvedValue(admin);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    /** A roster of what the audience said, by name — never cached. */
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
