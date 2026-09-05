import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './public-env';

/**
 * Refreshes the Supabase session on the edge and reports whether the request
 * carries one.
 *
 * The shape of this function is dictated by `@supabase/ssr` and is easy to get
 * subtly wrong. Two rules:
 *
 * - Cookies written by the refresh must land on the response that is actually
 *   returned. Building a fresh `NextResponse` later and forgetting to copy them
 *   is the documented cause of "random logouts every hour".
 * - `getUser()` must be called, not `getSession()`, or the refresh never
 *   happens — the SDK only rotates the token when something asks it to.
 *
 * The `headers` argument to `setAll` carries the no-store directives that stop a
 * CDN caching one visitor's auth cookies and serving them to the next.
 */
export async function refreshSession(request: NextRequest): Promise<{
  response: NextResponse;
  isAuthenticated: boolean;
}> {
  let response = NextResponse.next({ request });

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Nothing to refresh and nothing to protect optimistically. The server-side
    // guards still refuse every protected page, so this fails closed.
    return { response, isAuthenticated: false };
  }

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, isAuthenticated: user !== null };
}
