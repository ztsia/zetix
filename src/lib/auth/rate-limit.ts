import 'server-only';
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { authFailures } from '@/db/schema/auth';
import { requireSetting } from '@/db/settings';

/**
 * The admin login throttle (spec/admin.md §14.3, spec/README.md §4.2).
 *
 * `auth.admin_max_attempts` failures per IP inside `auth.admin_lockout_window_min`,
 * then a lockout that grows with each further failure. **Both numbers come from
 * the cascade** — they are seeded system values, not literals, and changing the
 * policy is an admin edit rather than a deploy (`CLAUDE.md`).
 *
 * The curve: once the threshold is passed, each additional failure doubles the
 * lockout, starting at one window.
 *
 *   failures | lockout
 *   ---------|---------
 *   max      | 1 window
 *   max + 1  | 2 windows
 *   max + 2  | 4 windows
 *
 * Doubling is the *shape* of "a growing lockout", not a tunable quantity, so it
 * is not a hardcoded operational value. {@link MAX_DOUBLINGS} caps it, and is an
 * overflow guard rather than a policy: without a ceiling the lockout reaches
 * dates JavaScript cannot represent, and a `Date` of `Infinity` compares false
 * against everything — a limiter that silently stops limiting.
 *
 * **Only the admin login is throttled**, deliberately, and the reason is a
 * trade-off rather than a belief that operator codes are safe:
 *
 * - `spec/README.md` §4.2 scopes V1 throttling to the admin credential.
 * - An usher locked out of the door app mid-queue is a worse failure on the
 *   night than the one throttling would prevent.
 * - An operator's blast radius is one show's roster; the admin code is
 *   everything.
 *
 * **Do not assume the platform covers the gap.** An independent QA pass fired 60
 * consecutive wrong operator passwords at the real Supabase project and got 60
 * plain 400s and not one 429 — an earlier version of this comment claimed
 * otherwise and was simply wrong. The mitigation that actually applies is code
 * entropy, which module `H` controls when it generates them.
 */
const MAX_DOUBLINGS = 8;

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/** `<surface>:<ip>` — see `auth_failures.bucket`. */
export function adminBucket(ip: string): string {
  return `admin:${ip}`;
}

/**
 * Headers the **platform** sets and strips from inbound requests, so a caller
 * cannot supply them.
 *
 * `x-forwarded-for` is deliberately **not** on this list. Any client can send
 * it, and a throttle keyed on a value the attacker chooses is not a throttle: a
 * rotating header turns one attacker into an unlimited supply of fresh buckets
 * and the lockout never fires. An independent QA pass demonstrated exactly that
 * — 20 attempts against a 5-attempt policy, never locked out.
 *
 * Vercel sets both of these and removes any inbound copy, so on the real
 * deployment the value is the true peer.
 */
const PLATFORM_IP_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip'] as const;

/**
 * The bucket used when no trusted header is present — a local `next start`, a
 * test, or a host that puts nothing in front of the app.
 *
 * Everyone shares it, so the throttle becomes global rather than per-IP. That is
 * the **safe** direction for a login route (it fails closed), but it does mean
 * one attacker can lock the committee out on such a host. On Vercel the headers
 * above are always present and this is never reached; anywhere else, put a proxy
 * in front that sets `x-real-ip`.
 */
const SHARED_BUCKET = 'unknown';

/** The client IP, taken only from headers the caller cannot forge. */
export function clientIp(headers: Headers): string {
  for (const name of PLATFORM_IP_HEADERS) {
    // A comma-joined list means the platform appended to an inbound value; the
    // first entry is the one it vouches for.
    const value = headers.get(name)?.split(',')[0]?.trim();
    if (value) return value;
  }
  return SHARED_BUCKET;
}

async function policy(): Promise<{ maxAttempts: number; windowMs: number }> {
  const [maxAttempts, windowMin] = await Promise.all([
    requireSetting<number>('auth.admin_max_attempts'),
    requireSetting<number>('auth.admin_lockout_window_min'),
  ]);
  return { maxAttempts, windowMs: windowMin * 60_000 };
}

/**
 * Whether this bucket may attempt a sign-in right now.
 *
 * Call **before** touching Supabase, so a locked-out caller cannot use the login
 * route to test codes at all.
 */
export async function checkRateLimit(bucket: string): Promise<RateLimitVerdict> {
  const { maxAttempts, windowMs } = await policy();
  const retentionMs = windowMs * 2 ** MAX_DOUBLINGS;
  const since = new Date(Date.now() - retentionMs);

  const db = getDb();
  const [tally] = await db
    .select({ failures: count() })
    .from(authFailures)
    .where(and(eq(authFailures.bucket, bucket), gt(authFailures.createdAt, since)));

  const failures = tally?.failures ?? 0;
  if (failures < maxAttempts) return { allowed: true };

  const [latest] = await db
    .select({ createdAt: authFailures.createdAt })
    .from(authFailures)
    .where(and(eq(authFailures.bucket, bucket), gt(authFailures.createdAt, since)))
    .orderBy(desc(authFailures.createdAt))
    .limit(1);
  if (!latest) return { allowed: true };

  const doublings = Math.min(failures - maxAttempts, MAX_DOUBLINGS);
  const lockedUntil = latest.createdAt.getTime() + windowMs * 2 ** doublings;
  const remainingMs = lockedUntil - Date.now();
  if (remainingMs <= 0) return { allowed: true };

  return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
}

/** Records a failure. Prefer {@link registerFailure}, which also reports the result. */
export async function recordFailure(bucket: string): Promise<void> {
  await getDb().insert(authFailures).values({ bucket });
}

/**
 * Registers one failed attempt and returns the verdict that now applies.
 *
 * **Call this for every wrong code, including one entered while already locked
 * out.** That is what makes the lockout grow: if a blocked attempt returned
 * early without recording, the failure count would freeze at the threshold and
 * the doubling above could never be reached by any real caller — the policy
 * would be a flat one-window lockout wearing a growing lockout's clothes.
 *
 * Returning the fresh verdict also lets the caller say "locked out" on the
 * attempt that causes it, rather than on the next one.
 */
export async function registerFailure(bucket: string): Promise<RateLimitVerdict> {
  await recordFailure(bucket);
  return checkRateLimit(bucket);
}

/** Clears the bucket. A correct code ends the lockout for that IP immediately. */
export async function clearFailures(bucket: string): Promise<void> {
  await getDb().delete(authFailures).where(eq(authFailures.bucket, bucket));
}
