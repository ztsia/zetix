/**
 * Creates the single shared `ADMIN` account (spec/admin.md §14.3, spec/local.md §5).
 *
 * There is no sign-up flow anywhere in this system — public sign-ups are off in
 * the Supabase project on purpose — so the first admin cannot be created through
 * the UI. This script is the one-time step that creates it.
 *
 *   pnpm tsx scripts/bootstrap-admin.ts
 *
 * Needs `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `ADMIN_EMAIL`,
 * `BOOTSTRAP_ADMIN_PASSWORD` and `DATABASE_URL`. **No cloud session holds the
 * service-role key**, so this runs from a human's machine (spec/local.md §7).
 *
 * Idempotent in both halves: re-running it updates the code on the existing Auth
 * user and leaves the `app_users` row alone. That makes it the rotation tool as
 * well as the install tool — and the code should be rotated after each concert
 * and whenever someone leaves the committee.
 *
 * Generate the passphrase, do not invent one. The code is the entire security
 * boundary for every attendee's name and email:
 *
 *   openssl rand -base64 32
 */
import './load-env';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getSql } from '../src/db/client';
import { appUsers } from '../src/db/schema/people';
import { createSupabaseAdminClient } from '../src/lib/supabase/admin';

/** Long enough that a leaked code cannot be brute-forced before it is rotated. */
const MIN_CODE_LENGTH = 16;

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!email) throw new Error('ADMIN_EMAIL is not set.');
  if (!password) throw new Error('BOOTSTRAP_ADMIN_PASSWORD is not set.');
  if (password.length < MIN_CODE_LENGTH) {
    throw new Error(
      `BOOTSTRAP_ADMIN_PASSWORD is ${password.length} characters. Use at least ` +
        `${MIN_CODE_LENGTH} — generate one with: openssl rand -base64 32`,
    );
  }

  const supabase = createSupabaseAdminClient();
  const sql = getSql();
  const db = drizzle(sql);

  /**
   * `domain.md` §5.1: **exactly one** ADMIN row. Checked *before* Supabase is
   * touched — refusing after `createUser()` succeeds leaves an orphan Auth user
   * behind that nothing in this system will ever reference or clean up, and the
   * operator has to go into the dashboard to remove it by hand.
   */
  const existingAdmins = await db
    .select({ id: appUsers.id, email: appUsers.email })
    .from(appUsers)
    .where(and(eq(appUsers.role, 'ADMIN'), isNull(appUsers.deletedAt)));

  const clash = existingAdmins.filter(
    (a) => a.email.toLowerCase() !== email.toLowerCase(),
  );
  if (clash.length > 0) {
    throw new Error(
      `An ADMIN account already exists (${clash.map((a) => a.email).join(', ')}), ` +
        'and there is exactly one by design (spec/domain.md §5.1). To rotate its code, ' +
        'run this with ADMIN_EMAIL set to that address. To replace the account, ' +
        'deactivate the old row first.',
    );
  }

  // `listUsers` rather than a lookup by address: the admin API has no
  // get-by-email, and this project holds a handful of accounts.
  const { data: existing, error: listError } = await supabase.auth.admin.listUsers({
    perPage: 1000,
  });
  if (listError) throw listError;

  const found = existing.users.find(
    (user) => user.email?.toLowerCase() === email.toLowerCase(),
  );

  let userId: string;
  if (found) {
    const { error } = await supabase.auth.admin.updateUserById(found.id, { password });
    if (error) throw error;
    userId = found.id;
    console.log(`Updated the admin code for ${email}`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      // The address is real but nobody reads it, and no confirmation mail should
      // gate the one account that unlocks the console.
      email_confirm: true,
    });
    if (error) throw error;
    if (!data.user) throw new Error('Supabase created no user and reported no error.');
    userId = data.user.id;
    console.log(`Created the Supabase Auth user for ${email}`);
  }

  // `app_users.id` **is** the Auth id (spec/domain.md §5.1). The role lives here,
  // never in the JWT, which is what lets it be revoked without touching Auth.
  const rows = await db
    .select({ id: appUsers.id, role: appUsers.role })
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1);

  if (rows.length === 0) {
    await db.insert(appUsers).values({
      id: userId,
      email,
      displayName: 'Committee',
      role: 'ADMIN',
      isActive: true,
    });
    console.log('Created the app_users row with role ADMIN');
  } else {
    // Reactivate rather than rewrite: an admin who was deactivated and is being
    // bootstrapped again clearly wants the account back.
    await db
      .update(appUsers)
      .set({ role: 'ADMIN', isActive: true, deletedAt: null })
      .where(eq(appUsers.id, userId));
    console.log('app_users row already present — confirmed ADMIN and active');
  }

  await sql.end();
  console.log('\nDone. Sign in at /login with the code alone; there is no address to type.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
