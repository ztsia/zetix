import { z } from 'zod';

/**
 * The validated view of the environment for application code.
 *
 * Note what is NOT here: no capacity, quota, deadline, cap, batch size or rate
 * limit. Those are stored, admin-editable, and resolved through the cascade in
 * `spec.md` §2.2 — never through the environment and never as a literal.
 * This file holds infrastructure coordinates only.
 *
 * Three places read `process.env` directly instead, each deliberately:
 *
 * - `src/db/client.ts` takes `DATABASE_URL` alone, so it stays importable from
 *   scripts and tests that set only that one variable — the local development
 *   database needs nothing else (§16.4).
 * - `src/app/api/health/route.ts` takes `CRON_SECRET` alone. It is the
 *   keep-alive that proves the database has not paused, so an unrelated
 *   variable being absent or malformed must not be able to take it down.
 * - `drizzle.config.ts` and the tests run outside Next entirely.
 *
 * Everything else goes through `env()`.
 */
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // Transaction pooler, port 6543. See spec.md §16.2.
  DATABASE_URL: z.string().min(1),
  // Session pooler, port 5432. Migrations only.
  DIRECT_URL: z.string().min(1).optional(),

  /**
   * Baked into every QR at issue time and unrecallable (spec.md §10.1).
   * MUST be the Vercel production alias, never VERCEL_URL — that is the
   * per-deployment hostname and it dies within days.
   */
  APP_URL: z.string().url(),

  CRON_SECRET: z.string().min(1).optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  GMAIL_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment:\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  cached = parsed.data;
  return cached;
}
