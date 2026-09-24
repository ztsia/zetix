import { NextResponse, type NextRequest } from 'next/server';
import { refreshSession } from '@/lib/supabase/proxy-session';
import { ADMIN_LOGIN_PATH, SCANNER_LOGIN_PATH } from '@/lib/auth/guards';

/**
 * Route protection across the four surfaces (spec/surfaces.md §15).
 *
 * In Next.js 16 this file is `proxy.ts`; `middleware.ts` is the deprecated name
 * for the same thing.
 *
 * **This is an optimistic check, not the authorization boundary.** It runs on
 * every request including prefetches, so it only reads the session cookie and
 * never touches the database — meaning it knows *whether* someone is signed in
 * but not *who they are* or *what role they hold*. The real check is
 * `requireAdmin()` / `requireScannerUser()` in the layout of each protected
 * group, which reads `app_users` and is what actually keeps an operator out of
 * the admin console.
 *
 * What this buys is the session refresh (without it, cookies written during a
 * Server Component render are dropped and sessions die within the hour) and
 * keeping signed-out visitors off admin URLs before a page renders.
 *
 * | Surface | Auth |
 * |---|---|
 * | `/admin/**` | signed in, then `ADMIN` |
 * | `/scan/**` | signed in, then `ADMIN` or `OPERATOR` |
 * | `/t/**` | the token in the URL — deliberately open |
 * | `/f/**`, `/api/forms/**` | open, or the token in the URL. **Throttled per IP in the handler**, never here: `src/lib/forms/throttle.ts` reads its policy through the cascade, and this file must not read the database (`modules.md` §5.2.1) |
 *
 * The two login paths stay reachable while signed in. Proxy cannot tell an
 * admin from an operator, so bouncing off a login page here would either loop or
 * send the wrong population to the wrong console; the login pages resolve that
 * themselves, where the role is known.
 */
const PROTECTED = [
  { prefix: '/admin', login: ADMIN_LOGIN_PATH },
  { prefix: '/scan', login: SCANNER_LOGIN_PATH },
] as const;

const PUBLIC_PATHS = new Set<string>([ADMIN_LOGIN_PATH, SCANNER_LOGIN_PATH]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { response, isAuthenticated } = await refreshSession(request);

  if (isAuthenticated || PUBLIC_PATHS.has(pathname)) return response;

  const match = PROTECTED.find(
    ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!match) return response;

  const target = request.nextUrl.clone();
  target.pathname = match.login;
  target.search = '';
  /**
   * Where to return to after signing in. Held as a path-only value and
   * revalidated on use, so a crafted `?next=https://elsewhere` cannot turn the
   * login form into an open redirect.
   */
  target.searchParams.set('next', pathname);

  const redirectResponse = NextResponse.redirect(target);
  // Carry the refreshed auth cookies across the redirect, or the very next
  // request arrives with a stale token and bounces here again.
  for (const cookie of response.cookies.getAll()) {
    redirectResponse.cookies.set(cookie);
  }
  return redirectResponse;
}

export const config = {
  /**
   * Everything except static assets and `/api`.
   *
   * `/api` is excluded deliberately. `/api/health` is the keep-alive that proves
   * the database has not paused and it authenticates with `CRON_SECRET` alone;
   * routing it through Supabase session refresh would make an unrelated auth
   * outage able to take the monitor down. Route Handlers that need a session
   * call `getSessionUser()` themselves.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
