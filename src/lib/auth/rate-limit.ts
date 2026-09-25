import 'server-only';
import { and, asc, count, desc, eq, gt, lt } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { authFailures } from '@/db/schema/auth';
import { requireSetting } from '@/db/settings';

/**
 * The console login throttle (spec/admin.md §14.3, spec/v3.md §28).
 *
 * `auth.admin_max_attempts` failures per bucket — per IP, and per account since
 * V3's named accounts ({@link accountBucket}) — inside `auth.admin_lockout_window_min`,
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
 * - An operator's blast radius is one show's roster; a console password is
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

export { accountBucket } from './account-bucket';

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

// ---------------------------------------------------------------------------
// Per-IP throttling for the tokenised surfaces (spec/v2.md §8.3, ref.md §7)
// ---------------------------------------------------------------------------

/**
 * The second throttle in this module, and it is deliberately in **this** module
 * rather than a new one (`docs/modules-v2.md` §3, `K`): a second implementation
 * of "rate limiting" is two behaviours under one name, and the next person to
 * change the policy would change one of them.
 *
 * **It is a different shape from the login throttle above, and the difference is
 * the point.** That one counts *failures* and grows a lockout, because the thing
 * being protected is a credential someone is guessing. This one counts *every
 * request* in a fixed window, because the thing being protected is an
 * unguessable token — possession of it is the credential (`ref.md` §7), and the
 * attack is enumeration, which produces no failures a `auth_failures`-shaped
 * counter would notice. Hi.Events throttles its own tokenised self-service
 * routes as tightly as 5/min for exactly this reason.
 *
 * **Storage is Postgres, following the `auth_failures` pattern** as §8.3
 * requires. That table is reused rather than a new one added: its own comment
 * says `bucket` is *"deliberately opaque so the limiter, not the schema, decides
 * what is being throttled"*, and it is otherwise `(bucket, created_at)` — a
 * generic timestamped hit log wearing the name of its first use. An in-memory
 * counter is not an option for the same reason it was not one for the login: on
 * Vercel each request may land on a different lambda, so the count resets under
 * exactly the load an attacker generates.
 *
 * **It goes in the handler, never in `src/proxy.ts`** (`modules.md` §5.2.1).
 * The proxy runs on every request including prefetches and never touches the
 * database, which is what keeps it fast and what keeps a database outage from
 * taking every route down at once.
 */

/** `form:<ip>` — the registration surface: the public form, the player form, the edit screen. */
export function formBucket(ip: string): string {
  return `form:${ip}`;
}

/**
 * `portal:<ip>` — the concert portal's tokenised pages.
 *
 * Provided here, mounted by `N`: this branch may not touch the portal
 * (`docs/modules-v2.md` §3, `K`). It shares the form's policy key rather than
 * taking one of its own, because the two surfaces face the same threat with the
 * same kind of token, and a second key is a second thing to get wrong.
 */
export function portalBucket(ip: string): string {
  return `portal:${ip}`;
}

const ONE_MINUTE_MS = 60_000;

/** Where in the cascade to read the policy, for a caller that already knows. */
export type ThrottleContext = {
  segmentId?: number | null;
  showId?: number | null;
  concertId?: number | null;
};

/**
 * Consume one request against `bucket` and say whether it may proceed.
 *
 * **A refused request is not recorded**, and that is what makes `Retry-After`
 * true. Recording refusals too would push the window's oldest hit forward every
 * time someone knocked, so a client that obeyed the header would be refused
 * again on waking, and again — told to wait one second, five times running. The
 * login throttle above deliberately does the opposite, because there the growing
 * lockout *is* the policy; here the policy is a flat window, and the header is a
 * promise the limiter has to keep.
 *
 * It still refuses at the right request. The count is taken **before** the
 * insert and compared with `>=`, so with a limit of five the sixth request
 * inside a minute is the one refused — the off-by-one a naive check-then-record
 * limiter has comes from comparing with `>`, not from the ordering.
 *
 * Two callers racing can both read four and both insert, serving one request
 * over the limit. Left as it is: the cost is one extra form load, and the
 * alternative is a lock on the hot path of every public page load, taken to
 * defend a threshold whose whole purpose is to be approximately right.
 *
 * `form.rate_limit_per_ip_per_min` resolves through the cascade
 * (spec/README.md §2.2). It is a **system** value with a seed, so most callers
 * pass no context at all: at the moment a tokenised route is throttled we have
 * not looked anything up yet, and looking a form up in order to decide whether
 * to allow the lookup is the wrong way round. A caller that already holds the
 * concert — the portal, which resolves its token first — may pass it and get a
 * per-concert override.
 *
 * Missing setting throws, exactly as the login policy does. This is a seeded
 * system value; its absence means the install is broken, and a limiter that
 * quietly stops limiting is the outcome this whole module exists to avoid.
 */
export async function consumeRateLimit(
  bucket: string,
  ctx: ThrottleContext = {},
): Promise<RateLimitVerdict> {
  const perMinute = await requireSetting<number>('form.rate_limit_per_ip_per_min', {
    segmentId: ctx.segmentId ?? null,
    showId: ctx.showId ?? null,
    concertId: ctx.concertId ?? null,
  });

  const db = getDb();
  const windowStart = new Date(Date.now() - ONE_MINUTE_MS);

  /**
   * Expired rows for this bucket, dropped on the way in.
   *
   * The login throttle stays small without a cron because a correct code
   * deletes the bucket, and only a credential someone is currently getting
   * wrong has rows at all. Counting *every* request has no such property — a
   * successful form load is still a row — so the sweep is what keeps this from
   * growing without bound. It costs one indexed delete on a bucket that holds
   * single-digit rows, and it only ever touches the caller's own bucket.
   */
  await db
    .delete(authFailures)
    .where(and(eq(authFailures.bucket, bucket), lt(authFailures.createdAt, windowStart)));

  const [tally] = await db
    .select({ hits: count() })
    .from(authFailures)
    .where(and(eq(authFailures.bucket, bucket), gt(authFailures.createdAt, windowStart)));

  if ((tally?.hits ?? 0) < perMinute) {
    await db.insert(authFailures).values({ bucket });
    return { allowed: true };
  }

  /**
   * How long until the window has room again — the oldest hit still counting,
   * plus the window.
   *
   * Exact, because refusals are not recorded: when that hit expires the count
   * drops below the limit and the next request is served. A fixed `60` would be
   * a lie to a caller who has already waited 55 seconds, and a client honouring
   * the header would sleep a minute it did not need to. Floored at one second —
   * `Retry-After: 0` reads as "go ahead".
   */
  const [oldest] = await db
    .select({ createdAt: authFailures.createdAt })
    .from(authFailures)
    .where(and(eq(authFailures.bucket, bucket), gt(authFailures.createdAt, windowStart)))
    .orderBy(asc(authFailures.createdAt))
    .limit(1);

  const expiresAt = (oldest?.createdAt.getTime() ?? Date.now()) + ONE_MINUTE_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));

  return { allowed: false, retryAfterSeconds };
}
