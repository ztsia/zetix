/**
 * Loads `.env.local`, then `.env`, as an **import-time side effect**.
 *
 * It has to be a module rather than a call at the top of a script, because ES
 * imports are hoisted: a `loadEnv()` statement runs after every import in the
 * file has already been evaluated, and `src/lib/supabase/public-env.ts` reads
 * its variables at module scope. So the environment arrived one step too late
 * and `pnpm bootstrap-admin` failed with "NEXT_PUBLIC_SUPABASE_URL is not set"
 * while dotenv had visibly just injected twelve variables.
 *
 * Import it **first**, before anything under `src/`.
 *
 * These scripts run outside Next, which is what would otherwise load
 * `.env.local` (spec/platform.md §16.2). dotenv never overwrites a variable
 * that is already set, so an explicit DATABASE_URL — CI, or the test that
 * spawns `seed-settings.ts` as a real process — still wins over both files.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });
config();
