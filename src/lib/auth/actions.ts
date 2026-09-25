'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { appUsers } from '@/db/schema/people';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { MissingSettingError } from '@/db/settings';
import { recordLogin } from './session';
import { operatorEmail } from './operator-slug';
import { safeRedirect } from './redirect-target';
import type { LoginState } from './login-state';
import {
  accountBucket,
  adminBucket,
  checkRateLimit,
  clearFailures,
  clientIp,
  registerFailure,
  type RateLimitVerdict,
} from './rate-limit';

/**
 * Sign-in for both populations (spec/v3.md §28, spec/checkin.md §12.1).
 *
 * Both are **real Supabase Auth password sign-ins**. No custom session
 * mechanism, no anonymous sign-in, no hand-rolled credential check: Supabase
 * decides authentication, we decide only authorisation (decision 20a). The only
 * thing our code adds on top is the throttle and the role lookup.
 */

/**
 * One message for a wrong password, an address with no account, and a
 * deactivated account. Distinguishing them tells someone probing the form which
 * half of a guess was right.
 */
const BAD_CREDENTIALS = 'That email and password were not recognised.';

/** The operator form's refusal. Its fields are a name and a code, not an address. */
const BAD_OPERATOR_CREDENTIALS = 'That code was not recognised.';

const consoleSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').email('Enter your email address.'),
  password: z.string().min(1, 'Enter your password.'),
  next: z.string().nullable().optional(),
});

const operatorSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter your display name.'),
  code: z.string().min(1, 'Enter your access code.'),
  next: z.string().nullable().optional(),
});

/** The roles the console sign-in admits (spec/v3.md §28). Operators use `/scan/login`. */
const CONSOLE_ROLES = new Set(['ADMIN', 'VIEWER']);

/**
 * The console sign-in: a named `ADMIN` or `VIEWER` account, by email and
 * password (spec/v3.md §28, replacing V1's code-only shared account).
 *
 * **Throttled per IP and per account** — two buckets, both checked before
 * Supabase is touched, both charged with every wrong password, both cleared by
 * a success; an attempt refused for a lockout charges only the locked one. Either one being locked refuses the attempt: the IP bucket stops one
 * caller guessing many accounts, the account bucket stops many callers guessing
 * one (`rate-limit.ts`, `accountBucket`).
 */
export async function signInConsole(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = consoleSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? BAD_CREDENTIALS };
  }
  const { email, password } = parsed.data;

  const buckets = [adminBucket(clientIp(await headers())), accountBucket(email)];

  // Checked before Supabase is touched: a locked-out caller must not be able to
  // use this route to test passwords at all. The attempt is still *recorded*,
  // so hammering a locked door extends the lockout rather than resetting it.
  //
  // If the policy is not configured, this **refuses the sign-in** rather than
  // proceeding unthrottled. `auth.*` are seeded system values, so an absent one
  // means the install step was skipped (spec/local.md §4) — and the alternative,
  // a fallback number in code, is precisely what `CLAUDE.md` forbids.
  let verdicts: RateLimitVerdict[];
  try {
    verdicts = await Promise.all(buckets.map(checkRateLimit));
  } catch (error) {
    if (error instanceof MissingSettingError) {
      return {
        error:
          'Sign-in is unavailable: the login throttle is not configured. ' +
          'Run `pnpm db:seed` to write the system settings (spec/local.md §4).',
      };
    }
    throw error;
  }

  if (verdicts.some((v) => !v.allowed)) {
    // Only the locked bucket is charged. The attempt never reaches Supabase,
    // so it guesses nothing — and charging the IP too would let one locked
    // account spread: its owner retrying from the office would lock every
    // colleague on that IP out as well.
    const locked = buckets.filter((_, i) => !verdicts[i]!.allowed);
    const extended = await Promise.all(locked.map(registerFailure));
    return { error: lockoutMessage(longestLockout([...verdicts, ...extended])) };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) return refuse(buckets);

  const user = await activeUser(data.user.id);
  if (!user || !CONSOLE_ROLES.has(user.role)) {
    // Authenticated by Supabase but not authorised by us — an operator's
    // synthetic address typed here, or a deactivated account. End the session
    // rather than leaving a valid cookie for an account that may not use this
    // console, and count it like any other failure.
    await supabase.auth.signOut();
    return refuse(buckets);
  }

  await Promise.all(buckets.map(clearFailures));
  await recordLogin(user.id);
  redirect(safeRedirect(parsed.data.next ?? null, '/admin'));
}

/** Charges both buckets and says "locked out" on the attempt that causes it. */
async function refuse(buckets: string[]): Promise<LoginState> {
  const after = await Promise.all(buckets.map(registerFailure));
  const locked = longestLockout(after);
  return { error: locked > 0 ? lockoutMessage(locked) : BAD_CREDENTIALS };
}

/** The longest wait any of these verdicts imposes, in seconds; 0 when none does. */
function longestLockout(verdicts: RateLimitVerdict[]): number {
  return Math.max(0, ...verdicts.map((v) => (v.allowed ? 0 : v.retryAfterSeconds)));
}

/**
 * The operator form asks for a display name and an access code. The synthetic
 * address is derived, never typed (spec/checkin.md §12.1).
 *
 * Not throttled — see the note in `rate-limit.ts` on why locking an usher out at
 * the door is the worse failure.
 */
export async function signInOperator(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = operatorSchema.safeParse({
    displayName: formData.get('displayName'),
    code: formData.get('code'),
    next: formData.get('next'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? BAD_OPERATOR_CREDENTIALS };
  }

  const email = operatorEmail(parsed.data.displayName);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: parsed.data.code,
  });

  if (error || !data.user) return { error: BAD_OPERATOR_CREDENTIALS };

  const user = await activeUser(data.user.id);
  if (!user) {
    await supabase.auth.signOut();
    return { error: BAD_OPERATOR_CREDENTIALS };
  }

  await recordLogin(user.id);
  redirect(safeRedirect(parsed.data.next ?? null, '/scan'));
}

export async function signOut(): Promise<never> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}

export async function signOutOperator(): Promise<never> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/scan/login');
}

async function activeUser(id: string) {
  const rows = await getDb()
    .select({
      id: appUsers.id,
      role: appUsers.role,
      isActive: appUsers.isActive,
      deletedAt: appUsers.deletedAt,
    })
    .from(appUsers)
    .where(eq(appUsers.id, id))
    .limit(1);
  const row = rows[0];
  if (!row || !row.isActive || row.deletedAt) return null;
  return row;
}

/**
 * A lockout that has doubled several times is measured in days, and "Try again
 * in 3840 minutes" is not a sentence anyone can act on.
 */
function lockoutMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  if (minutes <= 1) return 'Too many attempts. Try again in a minute.';
  if (minutes < 60) return `Too many attempts. Try again in ${minutes} minutes.`;

  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `Too many attempts. Try again in ${hours} hour${hours === 1 ? '' : 's'}.`;
  }
  const days = Math.ceil(hours / 24);
  return `Too many attempts. Try again in ${days} day${days === 1 ? '' : 's'}.`;
}
