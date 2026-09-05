/**
 * The two Supabase coordinates that are safe in a browser bundle.
 *
 * These are read as literal `process.env.NEXT_PUBLIC_*` member expressions
 * rather than through `env()` because Next inlines them at build time only when
 * it can see the property access statically. Routing them through a helper that
 * takes the name as a variable would leave `undefined` in the client bundle.
 *
 * The publishable (anon) key is public by design — it ships to every browser and
 * is protected by RLS. It is not a secret, and the service-role key, which is,
 * never appears on this side of the boundary (spec/local.md §7).
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Both are required for any surface that authenticates. Call this at the top of
 * a client factory so a missing variable fails loudly at the first use rather
 * than as an opaque `fetch` error inside the Supabase SDK.
 */
export function assertSupabaseEnv(): void {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set.',
    );
  }
}
