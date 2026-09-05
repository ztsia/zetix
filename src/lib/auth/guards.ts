import 'server-only';
import { redirect } from 'next/navigation';
import { getSessionUser, type Role, type SessionUser } from './session';

/**
 * Where each surface sends someone who is not signed in.
 *
 * Two login screens, because the two populations authenticate differently and
 * must never see each other's form: the admin form asks for a code alone, the
 * operator form asks for a display name and an access code (spec/admin.md §14.3,
 * spec/checkin.md §12.1).
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

/** The shared committee account. Everything under `/admin` sits behind this. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser(ADMIN_LOGIN_PATH);
  if (user.role !== 'ADMIN') {
    // An operator who reached an admin URL is not offered a login form — they
    // are already signed in, and re-authenticating would not change the answer.
    redirect('/scan');
  }
  return user;
}

/**
 * The scanner. `ADMIN` passes too: an admin is allowed at the door, and is the
 * fallback when an usher's account will not work on the night (spec/checkin.md §12.1).
 */
export async function requireScannerUser(): Promise<SessionUser> {
  return requireUser(SCANNER_LOGIN_PATH);
}

/** Non-redirecting role assertion, for handlers that owe a caller a status code. */
export function hasRole(user: SessionUser | null, ...roles: Role[]): boolean {
  return user !== null && roles.includes(user.role);
}
