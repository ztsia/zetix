import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL } from './public-env';

/**
 * The service-role client. **Bypasses RLS entirely.**
 *
 * It exists for exactly two jobs, both of which create Supabase Auth users and
 * therefore cannot be done with the anon key:
 *
 * - `scripts/bootstrap-admin.ts`, run once by a human (spec/local.md §5)
 * - operator provisioning from `/admin/operators`, which is module `H`'s screen
 *   (spec/checkin.md §12.1)
 *
 * No cloud session holds `SUPABASE_SERVICE_ROLE_KEY` and none needs to
 * (spec/local.md §7), so this throws rather than falling back to the anon key —
 * a silent downgrade would turn "cannot create users here" into a confusing
 * permission error much further downstream.
 *
 * Never import this from a Client Component, and never from a Route Handler that
 * an unauthenticated caller can reach.
 *
 * **Why this file alone omits `import 'server-only'`**, when every other server
 * module here has it: `scripts/bootstrap-admin.ts` imports this and runs under
 * `tsx`, which resolves the package's `default` export — a module whose entire
 * body is a `throw`. Adding the guard here would not harden anything; it would
 * break the one script that legitimately needs a service-role client. The
 * protection that does apply is that nothing under `src/app` imports this, and
 * `SUPABASE_SERVICE_ROLE_KEY` is read inside the function rather than at module
 * scope, so no bundle can inline it.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. Creating Supabase Auth users needs ' +
        'the service role; run this from a machine that holds it (spec/local.md §7).',
    );
  }
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set.');

  return createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
