import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The authorization boundary (decision 20, spec/admin.md §14.3, spec/checkin.md §12.3).
 *
 * These exist because an independent QA pass broke the admin guard — letting an
 * operator into the admin console — and broke the scanner's assignment check —
 * letting any operator reach any show's roster — and **the entire suite stayed
 * green**. Both behaviours were correct; nothing would have said when they
 * stopped being.
 *
 * `redirect()` and `notFound()` work by throwing, so they are mocked into
 * recognisable errors here. That is the whole control flow of a Next guard: the
 * assertion worth making is "it threw the right redirect", not a return value.
 */
class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
}));

const getSessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => getSessionUser() }));

const {
  requireRole,
  requireScannerUser,
  requireUser,
  hasRole,
  ReadOnlyAccountError,
  ADMIN_LOGIN_PATH,
  SCANNER_LOGIN_PATH,
} = await import('@/lib/auth/guards');
const { READ_ONLY_DIGEST } = await import('@/lib/auth/read-only');

const admin = { id: 'a1', email: 'admin@x', displayName: 'Committee', role: 'ADMIN' as const };
const operator = { id: 'o1', email: 'o@operators.invalid', displayName: 'Wei Ling', role: 'OPERATOR' as const };
const viewer = { id: 'v1', email: 'viewer@x', displayName: 'Mei', role: 'VIEWER' as const };

/** Runs `fn` and reports where it redirected, or `null` if it returned. */
async function redirectedTo(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
}

beforeEach(() => getSessionUser.mockReset());

describe("requireRole('ADMIN') — every mutation", () => {
  const requireAdmin = () => requireRole('ADMIN');

  it('lets an admin through', async () => {
    getSessionUser.mockResolvedValue(admin);
    await expect(requireAdmin()).resolves.toEqual(admin);
  });

  it('refuses an OPERATOR — the console is not theirs', async () => {
    // The probe that survived the old suite: `if (user.role !== 'ADMIN')` made
    // unreachable let an usher into every attendee's name and email.
    getSessionUser.mockResolvedValue(operator);
    expect(await redirectedTo(requireAdmin)).toBe('/scan');
  });

  it('refuses a VIEWER with the read-only error, not a redirect (spec/v3.md §28)', async () => {
    // A viewer is on a screen they may read; bouncing them off it would hide
    // what happened. The error carries a digest that survives a production
    // build, which is how the console's error boundary recognises it.
    getSessionUser.mockResolvedValue(viewer);
    const refusal = requireAdmin();
    await expect(refusal).rejects.toBeInstanceOf(ReadOnlyAccountError);
    await expect(refusal).rejects.toMatchObject({ digest: READ_ONLY_DIGEST });
  });

  it('sends a signed-out visitor to the admin login', async () => {
    getSessionUser.mockResolvedValue(null);
    expect(await redirectedTo(requireAdmin)).toBe(ADMIN_LOGIN_PATH);
  });

  it('refuses a deactivated account, which resolves to no session at all', async () => {
    // `getSessionUser` returns null for is_active = false, which is what makes
    // deactivation take effect on the next request without touching Auth.
    getSessionUser.mockResolvedValue(null);
    expect(await redirectedTo(requireAdmin)).toBe(ADMIN_LOGIN_PATH);
  });
});

describe("requireRole('ADMIN', 'VIEWER') — every read", () => {
  const requireReader = () => requireRole('ADMIN', 'VIEWER');

  it('lets an admin and a viewer through', async () => {
    getSessionUser.mockResolvedValue(admin);
    await expect(requireReader()).resolves.toEqual(admin);
    getSessionUser.mockResolvedValue(viewer);
    await expect(requireReader()).resolves.toEqual(viewer);
  });

  it('still refuses an OPERATOR', async () => {
    getSessionUser.mockResolvedValue(operator);
    expect(await redirectedTo(requireReader)).toBe('/scan');
  });

  it('sends a signed-out visitor to the admin login', async () => {
    getSessionUser.mockResolvedValue(null);
    expect(await redirectedTo(requireReader)).toBe(ADMIN_LOGIN_PATH);
  });
});

describe('requireScannerUser', () => {
  it('admits an OPERATOR', async () => {
    getSessionUser.mockResolvedValue(operator);
    await expect(requireScannerUser()).resolves.toEqual(operator);
  });

  it('admits an ADMIN too — an admin is allowed at the door', async () => {
    getSessionUser.mockResolvedValue(admin);
    await expect(requireScannerUser()).resolves.toEqual(admin);
  });

  it('refuses a VIEWER — reading the console is not admitting people', async () => {
    getSessionUser.mockResolvedValue(viewer);
    expect(await redirectedTo(requireScannerUser)).toBe('/admin');
  });

  it('sends a signed-out visitor to the scanner login, not the admin one', async () => {
    getSessionUser.mockResolvedValue(null);
    expect(await redirectedTo(requireScannerUser)).toBe(SCANNER_LOGIN_PATH);
  });
});

describe('requireUser', () => {
  it('redirects to whichever surface asked', async () => {
    getSessionUser.mockResolvedValue(null);
    expect(await redirectedTo(() => requireUser('/somewhere'))).toBe('/somewhere');
  });
});

describe('hasRole', () => {
  it('is false for no session, whatever roles are asked for', () => {
    expect(hasRole(null, 'ADMIN', 'OPERATOR')).toBe(false);
  });

  it('matches only the roles listed', () => {
    expect(hasRole(operator, 'ADMIN')).toBe(false);
    expect(hasRole(operator, 'OPERATOR')).toBe(true);
    expect(hasRole(admin, 'ADMIN', 'OPERATOR')).toBe(true);
    expect(hasRole(viewer, 'ADMIN')).toBe(false);
    expect(hasRole(viewer, 'ADMIN', 'VIEWER')).toBe(true);
  });
});
