import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, assertSupabaseEnv } from './public-env';

/**
 * A request-scoped Supabase client for Server Components, Server Actions and
 * Route Handlers.
 *
 * **Never cache or share this across requests.** It carries one visitor's
 * cookies; a module-level singleton would hand one committee member's session to
 * the next caller. A new client per render is the documented contract of
 * `@supabase/ssr`, not a precaution.
 *
 * `setAll` throws when called from a Server Component, because React has already
 * begun streaming and headers are closed. That is expected and swallowed: the
 * proxy (`src/proxy.ts`) refreshes the session on every request, so a token that
 * could not be written here is written there instead.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  // `cookies()` first, and the order is load-bearing. Reading it is what marks
  // the render dynamic, so a page that reaches this during `next build`'s
  // prerender pass bails out to dynamic here. Asserting the environment first
  // instead turns a missing variable into a *build* failure on every deployment
  // that does not carry Supabase credentials — CI among them — for pages that
  // were never going to be prerendered anyway.
  const cookieStore = await cookies();
  assertSupabaseEnv();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component render — the proxy owns the refresh. See above.
        }
      },
    },
  });
}
