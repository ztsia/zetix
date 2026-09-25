/**
 * Creates the first named `ADMIN` account (spec/v3.md §28, spec/local.md §5).
 *
 * There is no sign-up flow anywhere in this system — public sign-ups are off in
 * the Supabase project on purpose — so the first admin cannot be created through
 * the UI. This script creates them; every account after that is made by an
 * admin in Settings › People.
 *
 *   ADMIN_EMAIL=ana@example.org BOOTSTRAP_ADMIN_NAME="Ana" \
 *   BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 32)" \
 *   pnpm tsx scripts/bootstrap-admin.ts
 *
 * Needs `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `ADMIN_EMAIL`,
 * `BOOTSTRAP_ADMIN_PASSWORD` and `DATABASE_URL`; `BOOTSTRAP_ADMIN_NAME` is
 * optional. **No cloud session holds the service-role key**, so this runs from
 * a human's machine (spec/local.md §7).
 *
 * Idempotent in both halves: re-running it for an address that already has an
 * account sets its password and makes it an active admin again. That makes it
 * the **recovery tool** too — the one way back in if every admin is locked out,
 * deactivated or has lost their password, since Settings › People needs an
 * admin to reach it.
 *
 * V1 allowed exactly one admin and refused a second. V3's accounts are named, so
 * there may be several (decision 50); this now creates or restores the one it
 * is given and leaves the others alone.
 */
import './load-env';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getSql } from '../src/db/client';
import { appUsers } from '../src/db/schema/people';
import { accountBucket } from '../src/lib/auth/account-bucket';
import { createSupabaseAdminClient } from '../src/lib/supabase/admin';

/** Long enough that a leaked password cannot be brute-forced before it is rotated. */
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

  const displayName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || null;

  /**
   * An operator's address cannot be made an admin: the door app's credential
   * would become the console's. Checked before Supabase is touched, so a refusal
   * leaves nothing behind.
   */
  const existingRow = await db
    .select({ id: appUsers.id, role: appUsers.role })
    .from(appUsers)
    .where(eq(appUsers.email, email))
    .limit(1);
  if (existingRow[0]?.role === 'OPERATOR') {
    throw new Error(`${email} is an operator account. Use a real address for an admin.`);
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
    console.log(`Set a new password for ${email}`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      // Nothing is mailed to it, and no confirmation mail should gate the
      // account that unlocks the console.
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
      displayName,
      role: 'ADMIN',
      isActive: true,
    });
    console.log('Created the app_users row with role ADMIN');
  } else {
    // Reactivate rather than rewrite: an admin who was deactivated or demoted and
    // is being bootstrapped again clearly wants the account back.
    await db
      .update(appUsers)
      .set({
        role: 'ADMIN',
        isActive: true,
        deletedAt: null,
        ...(displayName ? { displayName } : {}),
      })
      .where(eq(appUsers.id, userId));
    console.log('app_users row already present — confirmed ADMIN and active');
  }

  // A restored admin must be able to sign in straight away, so the account's
  // login lockout goes too (spec/v3.md §28).
  await sql`delete from auth_failures where bucket = ${accountBucket(email)}`;
  console.log('Cleared any login lockout on the account');

  await sql.end();
  console.log(`\nDone. Sign in at /login with ${email} and that password.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
