import 'server-only';
import { redirect } from 'next/navigation';
import { READ_ONLY_DIGEST, READ_ONLY_MESSAGE } from './read-only';
import { getSessionUser, type Role, type SessionUser } from './session';

/**
 * Where each surface sends someone who is not signed in.
 *
 * Two login screens, because the two populations authenticate differently and
 * must never see each other's form: the console form asks for an email and a
 * password (spec/v3.md §28), the operator form asks for a display name and an
 * access code (spec/checkin.md §12.1).
 */
export const ADMIN_LOGIN_PATH = '/login';
export const SCANNER_LOGIN_PATH = '/scan/login';

/**
 * Guards for Server Components, Server Actions and Route Handlers.
 *
 * **These are the real boundary, not `src/proxy.ts`.** The proxy does an
 * optimistic cookie check to keep signed-out visitors off admin URLs, but it
 * never reads the database, so it cannot know a role — and Next's own guidance
 * is not to treat proxy as an authorization layer. Every protected page and
 * every mutation calls one of these.
 *
 * They redirect rather than throw, so a signed-out visitor lands on a login form
 * instead of an error page. Handlers that must answer an API caller should use
 * {@link getSessionUser} directly and return 401/403 themselves — the check-in
 * manifest is the case that matters (spec/checkin.md §12.3).
 */
export async function requireUser(loginPath: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(loginPath);
  return user;
}

/**
 * The console's guard (spec/v3.md §28): the caller must hold one of `roles`.
 *
 * Replaces V1's `requireAdmin()`. The call site names the roles it admits, so a
 * reader of any action sees at a glance whether a viewer can reach it:
 *
 * - `requireRole('ADMIN')` — every mutation, command, export and provisioning
 *   step. `tests/auth/admin-action-guards.test.ts` holds every Server Action
 *   under `/admin` to this unless it is on that test's short list of reads.
 * - `requireRole('ADMIN', 'VIEWER')` — pages and reads. A viewer reads every
 *   admin screen; the page masks contact details for them (`./mask.ts`).
 *
 * A refusal depends on who is refused:
 *
 * - **Signed out** → the admin login.
 * - **An operator** → `/scan`. They are signed in, and signing in again would
 *   not change the answer.
 * - **A viewer** asking for an admin-only step → {@link ReadOnlyAccountError}.
 *   It is thrown rather than redirected: the viewer is on a screen they may
 *   read, and bouncing them off it for pressing a button would hide what
 *   happened. The console hides those buttons from a viewer, so reaching this
 *   is a hand-made request or a stale page.
 */
export async function requireRole(...roles: [Role, ...Role[]]): Promise<SessionUser> {
  const user = await requireUser(ADMIN_LOGIN_PATH);
  if (roles.includes(user.role)) return user;
  if (user.role === 'VIEWER') throw new ReadOnlyAccountError();
  redirect(user.role === 'OPERATOR' ? '/scan' : ADMIN_LOGIN_PATH);
}

/** A viewer asked for something only an admin may do (spec/v3.md §28). */
export class ReadOnlyAccountError extends Error {
  /** Survives a production build's message redaction; see `./read-only.ts`. */
  readonly digest = READ_ONLY_DIGEST;

  constructor() {
    super(READ_ONLY_MESSAGE);
    this.name = 'ReadOnlyAccountError';
  }
}

/**
 * The scanner. `ADMIN` passes too: an admin is allowed at the door, and is the
 * fallback when an usher's account will not work on the night (spec/checkin.md §12.1).
 * A `VIEWER` does not — reading the console is not admitting people — and is
 * sent back to the console they do have.
 */
export async function requireScannerUser(): Promise<SessionUser> {
  const user = await requireUser(SCANNER_LOGIN_PATH);
  if (user.role === 'VIEWER') redirect('/admin');
  return user;
}

/** Non-redirecting role assertion, for handlers that owe a caller a status code. */
export function hasRole(user: SessionUser | null, ...roles: Role[]): boolean {
  return user !== null && roles.includes(user.role);
}
