import 'server-only';
import { cache } from 'react';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { appUsers } from '@/db/schema/people';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * `VIEWER` arrived with the V3 schema (`0200`, spec/v3.md §28). Until module `R`
 * lands `requireRole()`, every guard checks for `ADMIN` or `OPERATOR` by name, so
 * a viewer is refused everywhere — the safe side of a role nobody can yet be
 * given through the UI.
 */
export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export type SessionUser = {
  /** The Supabase Auth id. `app_users.id` **is** this value (spec/domain.md §5.1). */
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
};

/**
 * The authoritative answer to "who is this, and may they be here".
 *
 * Two checks, and both matter:
 *
 * 1. `supabase.auth.getUser()` — **not** `getSession()`. `getSession()` decodes
 *    whatever the cookie says without asking anyone, so a forged or stale cookie
 *    reads as a valid session. `getUser()` revalidates against the Auth server.
 * 2. The `app_users` row — Supabase decides *authentication*, we decide
 *    *authorisation* (spec/admin.md §14.3). The role lives here, never in the
 *    JWT, so revoking it takes effect on the next request rather than at the
 *    next token refresh.
 *
 * A user who is deactivated or soft-deleted resolves to `null` even though their
 * Supabase session is still perfectly valid. That is what makes "deactivating an
 * operator invalidates their session at the next request" true (spec/admin.md
 * §14.3) without having to reach into Auth and revoke anything.
 *
 * `cache()` dedupes this within a single request, so a layout, a page and three
 * nested Server Components asking the same question cost one round trip.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;

  const rows = await getDb()
    .select({
      id: appUsers.id,
      email: appUsers.email,
      displayName: appUsers.displayName,
      role: appUsers.role,
      isActive: appUsers.isActive,
    })
    .from(appUsers)
    .where(and(eq(appUsers.id, user.id), isNull(appUsers.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) return null;

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
  };
});

/** Stamps `last_login_at`. Best effort — a failed stamp must never fail a login. */
export async function recordLogin(userId: string): Promise<void> {
  try {
    await getDb()
      .update(appUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(appUsers.id, userId));
  } catch {
    // Not worth failing a sign-in over. The column is for the operator list.
  }
}
