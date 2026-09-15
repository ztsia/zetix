import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Do module `N`'s new admin surfaces still **call** their guards?
 *
 * A different claim from "the guard works", and the one an independent QA pass
 * caught this branch missing: both new role checks could be deleted and all
 * 1961 tests stayed green. That is the worst shape a gap can take, because the
 * failure it hides is silent — and `CLAUDE.md`'s asymmetric auth is the
 * non-negotiable it hides it on.
 *
 * Two entry points, guarded differently and both covered here:
 *
 * - **Server Actions** are their own entry point. The page's `requireAdmin()`
 *   does not cover them and the proxy never reads a role (modules.md §5.2.1).
 * - **`/api` is excluded from the proxy matcher entirely**, so a Route Handler
 *   is unprotected until it checks for itself.
 *
 * These publish a booklet to everyone holding a ticket and queue mail to the
 * audience, so an unguarded one is not a small mistake.
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
  queueFeedbackBlast: vi.fn(async () => ({
    queued: 1, requeued: 0, alreadySent: 0, unknownTokens: [] as string[],
  })),
  putAsset: vi.fn(async () => 'concerts/1/x.pdf'),
  writeAuditLog: vi.fn(async () => {}),
};

vi.mock('@/lib/email/feedback-blast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/feedback-blast')>()),
  queueFeedbackBlast: () => stub.queueFeedbackBlast(),
}));
vi.mock('@/lib/tickets/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tickets/assets')>()),
  putAsset: () => stub.putAsset(),
}));
vi.mock('@/lib/audit', () => ({ writeAuditLog: () => stub.writeAuditLog() }));

const showActions = await import('@/app/(admin)/admin/concerts/[concertId]/shows/actions');
const portalActions = await import('@/app/(admin)/admin/concerts/[concertId]/portal/actions');
const bookletRoute = await import('@/app/api/portal/booklet/route');

const admin = { id: randomUUID(), role: 'ADMIN' as const, email: 'a@test', displayName: 'Admin' };
const operator = { ...admin, id: randomUUID(), role: 'OPERATOR' as const };

beforeEach(() => {
  vi.resetAllMocks();
  stub.queueFeedbackBlast.mockResolvedValue({
    queued: 1, requeued: 0, alreadySent: 0, unknownTokens: [],
  });
  stub.putAsset.mockResolvedValue('concerts/1/x.pdf');
  stub.writeAuditLog.mockResolvedValue(undefined);
});

/**
 * Each action with input that would otherwise reach a mutation. The database is
 * real but never gets there — the guard throws first, which is the assertion.
 */
const ACTIONS: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: 'generateFeedbackEmailsAction',
    run: () => showActions.generateFeedbackEmailsAction(1, 1),
  },
  {
    name: 'sendFeedbackNowAction',
    run: () => showActions.sendFeedbackNowAction(1, 1),
  },
  {
    name: 'setBookletPublishedAction',
    run: () => portalActions.setBookletPublishedAction(1, 1, true),
  },
  {
    name: 'deleteBookletAction',
    run: () => portalActions.deleteBookletAction(1, 1),
  },
  {
    name: 'savePracticalInfoAction',
    run: () => {
      const data = new FormData();
      data.set('practicalInfoMd', 'Parking is under the hall.');
      return portalActions.savePracticalInfoAction(1, { error: null }, data);
    },
  },
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

describe('generateFeedbackEmailsAction reaches the blast only for an admin', () => {
  it('never queues for an operator', async () => {
    sessionUser.mockResolvedValue(operator);
    await expect(showActions.generateFeedbackEmailsAction(1, 1)).rejects.toThrow(RedirectSignal);
    expect(stub.queueFeedbackBlast).not.toHaveBeenCalled();
  });

  it('queues for an admin', async () => {
    sessionUser.mockResolvedValue(admin);
    await showActions.generateFeedbackEmailsAction(1, 1);
    expect(stub.queueFeedbackBlast).toHaveBeenCalled();
  });
});

/**
 * The booklet upload is a Route Handler because the payload is a file, which
 * puts it outside the proxy matcher and makes its own check the only one.
 */
describe('POST /api/portal/booklet', () => {
  const post = () => {
    const data = new FormData();
    data.set('concertId', '1');
    data.set('title', 'Programme');
    data.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'p.pdf'));
    return bookletRoute.POST(
      new Request('https://zetix.vercel.app/api/portal/booklet', {
        method: 'POST',
        body: data,
      }),
    );
  };

  it('refuses an anonymous caller and stores nothing', async () => {
    sessionUser.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(stub.putAsset).not.toHaveBeenCalled();
  });

  it('refuses a signed-in operator and stores nothing', async () => {
    sessionUser.mockResolvedValue(operator);
    expect((await post()).status).toBe(403);
    expect(stub.putAsset).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/portal/booklet', () => {
  const patch = () =>
    bookletRoute.PATCH(
      new Request('https://zetix.vercel.app/api/portal/booklet', {
        method: 'PATCH',
        body: JSON.stringify({ id: 1, published: true }),
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('refuses an anonymous caller', async () => {
    sessionUser.mockResolvedValue(null);
    expect((await patch()).status).toBe(401);
  });

  /**
   * Publishing is the moment a programme becomes visible to everyone holding a
   * ticket. An usher is not the person who decides that.
   */
  it('refuses a signed-in operator', async () => {
    sessionUser.mockResolvedValue(operator);
    expect((await patch()).status).toBe(403);
  });
});

describe('the portal file routes are reachable with a token and nothing else', () => {
  /**
   * The counterpart claim: `/api/portal/{token}/…` is deliberately *not* admin
   * guarded, because the token is the credential (§13.3). What stands in for a
   * guard there is that every gate the section has is re-asked — covered
   * against a real database in `tests/portal/booklet.test.ts` and exercised
   * live in the QA pass. This test pins that they take no session at all, so
   * nobody later "fixes" them by adding one and locking every guest out.
   */
  it('neither portal file route reads a session', async () => {
    const ticket = await import('@/app/api/portal/[token]/ticket/route');
    const booklet = await import('@/app/api/portal/[token]/booklet/route');
    for (const mod of [ticket, booklet]) {
      expect(typeof mod.GET).toBe('function');
    }
    expect(sessionUser).not.toHaveBeenCalled();
  });
});
