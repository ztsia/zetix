import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * The three things operator provisioning needs from Supabase Auth
 * (spec/checkin.md §12.1), behind a port.
 *
 * **This interface exists so the provisioning logic is testable.** Creating an
 * operator needs `SUPABASE_SERVICE_ROLE_KEY`, which no cloud session holds and
 * none should (spec/local.md §7, §5b) — so a session that can build this flow
 * cannot execute it end to end. Without a seam, the parts worth testing (the
 * duplicate-slug refusal, and the orphan cleanup when the database write fails
 * after the Auth user already exists) would be reachable only from a machine
 * with production credentials, which means in practice they would never be
 * tested at all.
 *
 * The seam is deliberately this narrow. It is not an abstraction over Supabase;
 * it is the exact surface `provision.ts` touches, so a fake in a test cannot
 * drift into pretending to be something richer than the real client.
 */
export type OperatorAuthAdmin = {
  /** Returns the new user's id, which becomes `app_users.id` (spec/domain.md §5.1). */
  createUser(email: string, password: string): Promise<{ id: string }>;
  /** Code rotation: same account, new password (spec/admin.md §14.3). */
  updatePassword(userId: string, password: string): Promise<void>;
  /** Only ever used to undo a `createUser` whose database half then failed. */
  deleteUser(userId: string): Promise<void>;
};

/** The same port for console accounts (`src/lib/people/provision.ts`). */
export type AuthAdmin = OperatorAuthAdmin;

/**
 * The real port, over the service-role client.
 *
 * `email_confirm: true` is not optional and is the whole of the synthetic-address
 * overhead (spec/checkin.md §12.1). Email confirmation is on project-wide, and
 * `<slug>@operators.invalid` can never receive a confirmation mail — `.invalid`
 * is reserved by RFC 2606 precisely so it never resolves. Omit the flag and the
 * operator is created, looks correct in every list, and simply cannot sign in.
 */
export function createOperatorAuthAdmin(): OperatorAuthAdmin {
  return createAuthAdmin({ noun: 'operator', secret: 'code' });
}

/**
 * The same three calls for any population. Settings › People uses it for named
 * console accounts (spec/v3.md §28), whose addresses are real — `email_confirm`
 * is still set, because the admin hands the password over in person and no
 * confirmation mail should stand between a new account and its first sign-in.
 */
export function createAuthAdmin({
  noun,
  secret,
}: {
  /** What the account is, in an error message: `operator`, `account`. */
  noun: string;
  /** What its password is called on screen: `code`, `password`. */
  secret: string;
}): OperatorAuthAdmin {
  const supabase = createSupabaseAdminClient();

  return {
    async createUser(email, password) {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) throw new Error(`Supabase Auth refused the new ${noun}: ${error.message}`);
      if (!data.user) throw new Error(`Supabase Auth returned no user for the new ${noun}.`);
      return { id: data.user.id };
    },

    async updatePassword(userId, password) {
      const { error } = await supabase.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error(`Supabase Auth refused the new ${secret}: ${error.message}`);
    },

    async deleteUser(userId) {
      const { error } = await supabase.auth.admin.deleteUser(userId);
      if (error) throw new Error(`Could not remove the orphaned Auth user: ${error.message}`);
    },
  };
}
