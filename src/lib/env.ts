import { z } from 'zod';

/**
 * The validated view of the environment for application code.
 *
 * Note what is NOT here: no capacity, quota, deadline, cap, batch size or rate
 * limit. Those are stored, admin-editable, and resolved through the cascade in
 * `spec/README.md` §2.2 — never through the environment and never as a literal.
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

  // Transaction pooler, port 6543. See spec/platform.md §16.2.
  DATABASE_URL: z.string().min(1),
  // Session pooler, port 5432. Migrations only.
  DIRECT_URL: z.string().min(1).optional(),

  /**
   * Baked into every QR at issue time and unrecallable (spec/tickets.md §10.1).
   * MUST be the Vercel production alias, never VERCEL_URL — that is the
   * per-deployment hostname and it dies within days.
   */
  APP_URL: z.string().url(),

  CRON_SECRET: z.string().min(1).optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  GMAIL_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),

  /**
   * SMTP coordinates, which exist so the transport can be pointed at a local
   * sink without touching code (spec/email.md §11.1, `local.md` §7).
   *
   * Unset in production, where the Gmail defaults in `src/lib/email/config.ts`
   * apply. Set to `127.0.0.1` and a sink's port in development, because
   * `smtp.gmail.com` is blocked on both 465 and 587 from any container and the
   * app password is deliberately not in a cloud environment — an unsupervised
   * session that could send is one that could blast the real players by
   * accident.
   *
   * These are infrastructure coordinates, not operational values: nothing here
   * is a capacity, quota, deadline or cap, and none of it comes from
   * `context.md`. Batch sizes and delays resolve through the cascade instead.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),

  /**
   * IMAP coordinates for the inbox sync (spec/v3.md §26.3), overriding Gmail's
   * the same way `SMTP_*` do: unset in production, set in development to point
   * the same adapter at a local test server. The credential is the same
   * `GMAIL_USER` / `GMAIL_APP_PASSWORD`; app passwords cover IMAP.
   */
  IMAP_HOST: z.string().optional(),
  IMAP_PORT: z.coerce.number().int().positive().optional(),
  IMAP_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
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
