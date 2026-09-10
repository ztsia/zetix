import 'server-only';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { appUsers, operatorShowAssignments } from '@/db/schema/people';
import { shows } from '@/db/schema/shows';
import { operatorEmail, operatorSlug } from '@/lib/auth/operator-slug';
import { writeAuditLog } from '@/lib/audit';
import { generateAccessCode } from './access-code';
import type { OperatorAuthAdmin } from './auth-admin';

/**
 * Operator provisioning (spec/admin.md §14.3 "Provisioning operators",
 * spec/checkin.md §12.1, decision 20/20a).
 *
 * The admin creates one account per usher, hands over a code, assigns shows, and
 * can rotate the code or deactivate the account. That is the whole of it — there
 * is no invitation, no self-service and no password reset flow, because the
 * population is about six people who are handed a code in person.
 *
 * **Every operator address comes from `operatorEmail()`** in
 * `src/lib/auth/operator-slug.ts`, which the scanner's login form also uses to
 * derive the address from the typed display name. A second implementation of
 * that slug here would be an usher who cannot sign in with nothing in the logs
 * to say why (modules.md §5.2.1) — so it is imported, never re-derived.
 */

export type CreatedOperator = {
  userId: string;
  displayName: string;
  email: string;
  /** Shown once, then never recoverable — only rotatable (spec/admin.md §14.3). */
  accessCode: string;
};

/** Refusals an admin can act on, as distinct from a genuine failure. */
export class OperatorProvisionError extends Error {}

function requireSlug(displayName: string): string {
  const slug = operatorSlug(displayName);
  if (!slug) {
    throw new OperatorProvisionError(
      'That display name has no letters or digits to build an address from. ' +
        'Use the name the usher will type when they sign in.',
    );
  }
  return slug;
}

/**
 * Creates an operator: a Supabase Auth user and the `app_users` row that gives
 * it a role.
 *
 * **Ordering is deliberate, and it is the same argument `bootstrap-admin.ts`
 * makes.** The database is checked *before* Supabase is touched, because an
 * account that fails validation after `createUser()` succeeds leaves an Auth
 * user nothing in this system references — invisible in every admin screen, and
 * removable only from the Supabase dashboard. Where the write can still fail
 * after that point, the Auth user is deleted again below.
 *
 * The duplicate check ignores `deleted_at` on purpose. Supabase Auth holds the
 * address whatever this table says, so a soft-deleted or deactivated operator
 * with the same slug still blocks it — and reporting "that name is taken" is
 * more useful than letting Supabase reject it with a message about an email the
 * admin never typed and the usher will never see.
 */
export async function createOperator(
  {
    displayName,
    actorId,
  }: {
    displayName: string;
    actorId: string;
  },
  auth: OperatorAuthAdmin,
): Promise<CreatedOperator> {
  const name = displayName.trim();
  requireSlug(name);
  const email = operatorEmail(name);
  const db = getDb();

  const clash = await db
    .select({ id: appUsers.id, displayName: appUsers.displayName })
    .from(appUsers)
    .where(eq(appUsers.email, email))
    .limit(1);

  if (clash.length > 0) {
    throw new OperatorProvisionError(
      `"${name}" resolves to the same sign-in name as the existing operator ` +
        `"${clash[0]!.displayName ?? email}". Give one of them a fuller name — ` +
        'a surname or an initial is enough.',
    );
  }

  const accessCode = generateAccessCode();

  let created: { id: string };
  try {
    created = await auth.createUser(email, accessCode);
  } catch (error) {
    /**
     * Supabase Auth already holds this address while `app_users` does not.
     *
     * The two can drift — a row deleted by hand, or a create that failed after
     * the Auth user existed — and the provider's own message names an email the
     * admin never typed and the usher will never see, which reads as a bug in
     * something else entirely. Say what actually has to happen instead.
     */
    const message = error instanceof Error ? error.message : String(error);
    if (/already|exists|registered|duplicate/i.test(message)) {
      throw new OperatorProvisionError(
        `Supabase Auth already holds an account for "${name}" (${email}), but this ` +
          'system has no operator by that name. Either give the new usher a fuller ' +
          'name, or remove the stale user from the Supabase dashboard first.',
      );
    }
    throw error;
  }

  try {
    await db.insert(appUsers).values({
      id: created.id,
      email,
      displayName: name,
      role: 'OPERATOR',
      isActive: true,
    });
  } catch (error) {
    // The Auth user exists and the row that would give it a role does not, so
    // it can authenticate and resolve to nobody. `getSessionUser()` would return
    // null and the operator would see a login that appears to work and then
    // does nothing. Undo it rather than leave that behind.
    await auth.deleteUser(created.id).catch(() => {
      // Reported through the original failure below; swallowing the cleanup
      // error keeps the admin looking at the cause rather than the symptom.
    });
    throw error;
  }

  // The access code itself is never logged, here or anywhere.
  await writeAuditLog({
    action: 'operator.created',
    entityType: 'app_users',
    entityId: created.id,
    after: { displayName: name, email, role: 'OPERATOR' },
    actorId,
  });

  return { userId: created.id, displayName: name, email, accessCode };
}

/**
 * Issues a new access code for an existing operator (spec/admin.md §14.3).
 *
 * The old code stops working the moment this returns; the operator's *session*
 * does not, because a Supabase password change does not revoke an issued
 * refresh token. That is the right behaviour at a concert — rotating a code
 * during arrivals must not sign an usher out mid-queue — and deactivation is the
 * control that does cut access immediately.
 */
export async function regenerateAccessCode(
  { userId, actorId }: { userId: string; actorId: string },
  auth: OperatorAuthAdmin,
): Promise<{ displayName: string | null; accessCode: string }> {
  const operator = await requireOperator(userId);
  const accessCode = generateAccessCode();

  await auth.updatePassword(userId, accessCode);

  await writeAuditLog({
    action: 'operator.code_regenerated',
    entityType: 'app_users',
    entityId: userId,
    after: { displayName: operator.displayName },
    actorId,
  });

  return { displayName: operator.displayName, accessCode };
}

/**
 * Deactivates or restores an operator.
 *
 * **This is what cuts access immediately.** `getSessionUser()` resolves an
 * inactive user to `null` on the next request, whatever their Supabase session
 * says (spec/admin.md §14.3) — so nothing here needs to reach into Auth and
 * revoke a token, and a device that is currently offline is refused the moment
 * it syncs.
 */
export async function setOperatorActive({
  userId,
  isActive,
  actorId,
}: {
  userId: string;
  isActive: boolean;
  actorId: string;
}): Promise<void> {
  const operator = await requireOperator(userId);
  if (operator.isActive === isActive) return;

  await getDb().update(appUsers).set({ isActive }).where(eq(appUsers.id, userId));

  await writeAuditLog({
    action: isActive ? 'operator.reactivated' : 'operator.deactivated',
    entityType: 'app_users',
    entityId: userId,
    before: { isActive: operator.isActive },
    after: { isActive },
    actorId,
  });
}

/**
 * Replaces an operator's assignments **within one concert**
 * (spec/admin.md §14.3, "a checkbox grid of shows per operator").
 *
 * **Scoped to the concert, and that scoping is the load-bearing part.** The
 * screen is per concert, so it can only show that concert's shows — and a naive
 * "delete all, insert the ticked ones" would silently strip an operator of every
 * assignment on every *other* concert the moment someone saved this grid. The
 * delete is therefore bounded to the shows this concert actually owns.
 *
 * The requested ids are re-derived from the database rather than trusted, so a
 * hand-edited form cannot assign an operator to a show belonging to a different
 * concert — that would grant a roster the admin never saw on screen.
 *
 * Revocation takes effect on the server immediately, including for a device that
 * is offline right now: `/api/checkin/scan` re-checks `canAccessShow()` on every
 * write, so its queued scans are refused on sync rather than silently accepted
 * (spec/checkin.md §12.3).
 */
export async function setShowAssignments({
  userId,
  concertId,
  showIds,
  actorId,
}: {
  userId: string;
  concertId: number;
  showIds: number[];
  actorId: string;
}): Promise<{ assigned: number[] }> {
  await requireOperator(userId);
  const db = getDb();

  const concertShows = await db
    .select({ id: shows.id })
    .from(shows)
    .where(eq(shows.concertId, concertId));
  const inConcert = new Set(concertShows.map((s) => s.id));

  // Silently dropping an unknown id would be a checkbox that appears to save and
  // does not. There is no legitimate way for the form to carry one.
  const unknown = showIds.filter((id) => !inConcert.has(id));
  if (unknown.length > 0) {
    throw new OperatorProvisionError(
      'That assignment refers to a show outside this concert. Reload the page and try again.',
    );
  }

  const wanted = [...new Set(showIds)];
  const scope = [...inConcert];

  await db.transaction(async (tx) => {
    if (scope.length > 0) {
      const stale = and(
        eq(operatorShowAssignments.userId, userId),
        inArray(operatorShowAssignments.showId, scope),
        // `notInArray` with an empty list is not valid SQL, so clearing every
        // box is expressed as "delete everything in scope" instead.
        ...(wanted.length > 0
          ? [notInArray(operatorShowAssignments.showId, wanted)]
          : []),
      );
      await tx.delete(operatorShowAssignments).where(stale);
    }

    if (wanted.length > 0) {
      await tx
        .insert(operatorShowAssignments)
        .values(wanted.map((showId) => ({ userId, showId, assignedBy: actorId })))
        // Re-saving an unchanged grid must be harmless; the unique index on
        // `(user_id, show_id)` is what makes that true rather than a race.
        .onConflictDoNothing();
    }
  });

  await writeAuditLog({
    action: 'operator.shows_assigned',
    entityType: 'app_users',
    entityId: userId,
    after: { concertId, showIds: wanted },
    actorId,
  });

  return { assigned: wanted };
}

async function requireOperator(userId: string) {
  const rows = await getDb()
    .select({
      id: appUsers.id,
      displayName: appUsers.displayName,
      role: appUsers.role,
      isActive: appUsers.isActive,
    })
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1);

  const operator = rows[0];
  if (!operator) throw new OperatorProvisionError('That operator no longer exists.');
  // The shared ADMIN lives in this table too (spec/domain.md §5.1). None of
  // these controls may reach it: deactivating it locks the committee out of
  // their own console, and there is no second admin to undo it.
  if (operator.role !== 'OPERATOR') {
    throw new OperatorProvisionError('That account is not an operator.');
  }
  return operator;
}
