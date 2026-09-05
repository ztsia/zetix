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
  adminBucket,
  checkRateLimit,
  clearFailures,
  clientIp,
  registerFailure,
} from './rate-limit';

/**
 * Sign-in for both populations (spec/admin.md §14.3, spec/checkin.md §12.1).
 *
 * Both are **real Supabase Auth password sign-ins**. No custom session
 * mechanism, no anonymous sign-in, no hand-rolled credential check: Supabase
 * decides authentication, we decide only authorisation (decision 20a). The only
 * thing our code adds on top is the throttle and the role lookup.
 */

/**
 * One message for a wrong code, a code for a user that does not exist, and a
 * code for a deactivated account. Distinguishing them tells someone probing the
 * form which half of a guess was right.
 */
const BAD_CREDENTIALS = 'That code was not recognised.';

const adminSchema = z.object({
  code: z.string().min(1, 'Enter the admin code.'),
  next: z.string().nullable().optional(),
});

const operatorSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter your display name.'),
  code: z.string().min(1, 'Enter your access code.'),
  next: z.string().nullable().optional(),
});

/**
 * The admin form asks for a code and nothing else. The address is a server-side
 * constant so nobody on the committee has to remember one (spec/admin.md §14.3).
 */
export async function signInAdmin(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = adminSchema.safeParse({
    code: formData.get('code'),
    next: formData.get('next'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? BAD_CREDENTIALS };
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    return {
      error:
        'ADMIN_EMAIL is not configured on this deployment, so the admin account ' +
        'cannot be identified. See spec/local.md §5.',
    };
  }

  const bucket = adminBucket(clientIp(await headers()));

  // Checked before Supabase is touched: a locked-out caller must not be able to
  // use this route to test codes at all. The attempt is still *recorded*, so
  // hammering a locked door extends the lockout rather than resetting it.
  //
  // If the policy is not configured, this **refuses the sign-in** rather than
  // proceeding unthrottled. `auth.*` are seeded system values, so an absent one
  // means the install step was skipped (spec/local.md §4) — and the alternative,
  // a fallback number in code, is precisely what `CLAUDE.md` forbids.
  let verdict: Awaited<ReturnType<typeof checkRateLimit>>;
  try {
    verdict = await checkRateLimit(bucket);
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

  if (!verdict.allowed) {
    const extended = await registerFailure(bucket);
    return {
      error: lockoutMessage(
        extended.allowed ? verdict.retryAfterSeconds : extended.retryAfterSeconds,
      ),
    };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: adminEmail,
    password: parsed.data.code,
  });

  if (error || !data.user) {
    const after = await registerFailure(bucket);
    // Say "locked out" on the attempt that causes it, not on the next one.
    return {
      error: after.allowed ? BAD_CREDENTIALS : lockoutMessage(after.retryAfterSeconds),
    };
  }

  const user = await activeUser(data.user.id);
  if (!user || user.role !== 'ADMIN') {
    // Authenticated by Supabase but not authorised by us. End the session rather
    // than leaving a valid cookie for an account that may not use this console.
    await supabase.auth.signOut();
    const after = await registerFailure(bucket);
    return {
      error: after.allowed ? BAD_CREDENTIALS : lockoutMessage(after.retryAfterSeconds),
    };
  }

  await clearFailures(bucket);
  await recordLogin(user.id);
  redirect(safeRedirect(parsed.data.next ?? null, '/admin'));
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
    return { error: parsed.error.issues[0]?.message ?? BAD_CREDENTIALS };
  }

  const email = operatorEmail(parsed.data.displayName);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: parsed.data.code,
  });

  if (error || !data.user) return { error: BAD_CREDENTIALS };

  const user = await activeUser(data.user.id);
  if (!user) {
    await supabase.auth.signOut();
    return { error: BAD_CREDENTIALS };
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
