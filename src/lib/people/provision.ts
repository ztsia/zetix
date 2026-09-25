import 'server-only';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { appUsers } from '@/db/schema/people';
import { OPERATOR_EMAIL_DOMAIN } from '@/lib/auth/operator-slug';
import { writeAuditLog } from '@/lib/audit';
import { generateAccessCode } from '@/lib/operators/access-code';
import type { AuthAdmin } from '@/lib/operators/auth-admin';

/**
 * Named console accounts — Settings › People (spec/v3.md §28, decision 50).
 *
 * V1 had one shared `ADMIN` behind one code. V3 gives each committee member
 * their own account, as an `ADMIN` or a read-only `VIEWER`, so the audit log
 * says who. An admin provisions them here; there is still no sign-up and no
 * invitation mail — the admin hands the password over, as with an usher's code.
 *
 * Operators are not managed here. They keep their own screen and their own
 * synthetic addresses (`src/lib/operators/provision.ts`); a console account and
 * an operator account never turn into one another.
 *
 * **The console can never be left without an admin.** Demoting or deactivating
 * the last active `ADMIN` is refused, and an admin cannot demote or deactivate
 * themselves — the second rule is what makes the first safe from the one person
 * most likely to try it. Both checks lock the admin rows first, so two admins
 * demoting each other at the same moment cannot both succeed.
 */

export type ConsoleRole = 'ADMIN' | 'VIEWER';
export const CONSOLE_ROLES: readonly ConsoleRole[] = ['ADMIN', 'VIEWER'];

export type ConsoleAccount = {
  id: string;
  email: string;
  displayName: string | null;
  role: ConsoleRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
};

/** Refusals an admin can act on, as distinct from a genuine failure. */
export class PeopleProvisionError extends Error {}

/**
 * Characters in a console password. Longer than an usher's code: it reaches the
 * whole console rather than one show's roster. Grouped in fours like the code,
 * from the same unambiguous alphabet, so it survives being read aloud.
 *
 * 20 characters over 30 glyphs is ~98 bits — a security parameter, not an
 * operational value from `context.md`.
 */
export const CONSOLE_PASSWORD_LENGTH = 20;

export function generateConsolePassword(): string {
  return generateAccessCode(CONSOLE_PASSWORD_LENGTH);
}

export async function listConsoleAccounts(): Promise<ConsoleAccount[]> {
  const rows = await getDb()
    .select({
      id: appUsers.id,
      email: appUsers.email,
      displayName: appUsers.displayName,
      role: appUsers.role,
      isActive: appUsers.isActive,
      lastLoginAt: appUsers.lastLoginAt,
      createdAt: appUsers.createdAt,
    })
    .from(appUsers)
    .where(and(inArray(appUsers.role, [...CONSOLE_ROLES]), isNull(appUsers.deletedAt)))
    .orderBy(asc(appUsers.role), asc(appUsers.displayName), asc(appUsers.email));
  return rows.map((row) => ({ ...row, role: row.role as ConsoleRole }));
}

/**
 * Creates a console account: the Supabase Auth user and the `app_users` row
 * that gives it a role. Returns the password, which is shown **once**.
 *
 * Ordered like operator provisioning, for the same reason: the database is
 * checked before Supabase is touched, and if the row cannot be written after
 * the Auth user exists, the Auth user is deleted again rather than left behind
 * as an account that signs in and resolves to nobody.
 */
export async function createConsoleAccount(
  {
    email: rawEmail,
    displayName: rawName,
    role,
    actorId,
  }: { email: string; displayName: string; role: ConsoleRole; actorId: string },
  auth: AuthAdmin,
): Promise<{ userId: string; email: string; displayName: string; password: string }> {
  const email = rawEmail.trim().toLowerCase();
  const displayName = rawName.trim();

  if (email.endsWith(`@${OPERATOR_EMAIL_DOMAIN}`)) {
    throw new PeopleProvisionError(
      'That is an operator sign-in address. Ushers are added on a concert’s Operators screen.',
    );
  }

  const db = getDb();
  const clash = await db
    .select({ id: appUsers.id, role: appUsers.role })
    .from(appUsers)
    .where(eq(appUsers.email, email))
    .limit(1);
  if (clash.length > 0) {
    throw new PeopleProvisionError(`There is already an account for ${email}.`);
  }

  const password = generateConsolePassword();

  let created: { id: string };
  try {
    created = await auth.createUser(email, password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already|exists|registered|duplicate/i.test(message)) {
      throw new PeopleProvisionError(
        `Supabase Auth already holds an account for ${email}, but this system has no ` +
          'account for it. Remove the stale user from the Supabase dashboard first.',
      );
    }
    throw error;
  }

  try {
    await db.insert(appUsers).values({
      id: created.id,
      email,
      displayName,
      role,
      isActive: true,
    });
  } catch (error) {
    await auth.deleteUser(created.id).catch(() => {
      // Reported through the original failure below.
    });
    throw error;
  }

  // The password is never logged, here or anywhere.
  await writeAuditLog({
    action: 'account.created',
    entityType: 'app_users',
    entityId: created.id,
    after: { email, displayName, role },
    actorId,
  });

  return { userId: created.id, email, displayName, password };
}

/** A new password for an account; the old one stops working at once. */
export async function resetConsolePassword(
  { userId, actorId }: { userId: string; actorId: string },
  auth: AuthAdmin,
): Promise<{ displayName: string; password: string }> {
  const account = await requireConsoleAccount(userId);
  const password = generateConsolePassword();
  await auth.updatePassword(userId, password);

  await writeAuditLog({
    action: 'account.password_reset',
    entityType: 'app_users',
    entityId: userId,
    after: { email: account.email },
    actorId,
  });

  return { displayName: account.displayName ?? account.email, password };
}

/**
 * Changes an account between `ADMIN` and `VIEWER`. Takes effect on the
 * account's next request: the role is read from `app_users` every time, never
 * from the session (`src/lib/auth/session.ts`).
 */
export async function setConsoleRole({
  userId,
  role,
  actorId,
}: {
  userId: string;
  role: ConsoleRole;
  actorId: string;
}): Promise<void> {
  if (userId === actorId) {
    throw new PeopleProvisionError(
      'You cannot change your own role. Ask another admin — that way the console always keeps one.',
    );
  }

  await getDb().transaction(async (tx) => {
    const admins = await lockActiveAdmins(tx);
    const account = await lockConsoleAccount(tx, userId);
    if (account.role === role) return;
    if (account.role === 'ADMIN') refuseIfLastAdmin(admins, userId, 'demote');

    await tx.update(appUsers).set({ role }).where(eq(appUsers.id, userId));
    await writeAuditLog(
      {
        action: 'account.role_changed',
        entityType: 'app_users',
        entityId: userId,
        before: { role: account.role },
        after: { role },
        actorId,
      },
      tx,
    );
  });
}

/**
 * Deactivates or restores an account. Deactivation cuts access on the next
 * request, whatever the Supabase session says, because `getSessionUser()`
 * resolves an inactive account to nobody.
 */
export async function setConsoleActive({
  userId,
  isActive,
  actorId,
}: {
  userId: string;
  isActive: boolean;
  actorId: string;
}): Promise<void> {
  if (userId === actorId && !isActive) {
    throw new PeopleProvisionError('You cannot deactivate your own account.');
  }

  await getDb().transaction(async (tx) => {
    const admins = await lockActiveAdmins(tx);
    const account = await lockConsoleAccount(tx, userId);
    if (account.isActive === isActive) return;
    if (!isActive && account.role === 'ADMIN') refuseIfLastAdmin(admins, userId, 'deactivate');

    await tx.update(appUsers).set({ isActive }).where(eq(appUsers.id, userId));
    await writeAuditLog(
      {
        action: isActive ? 'account.reactivated' : 'account.deactivated',
        entityType: 'app_users',
        entityId: userId,
        before: { isActive: account.isActive },
        after: { isActive },
        actorId,
      },
      tx,
    );
  });
}

/** Renames an account — the name the Activity log shows for everything it did. */
export async function renameConsoleAccount({
  userId,
  displayName,
  actorId,
}: {
  userId: string;
  displayName: string;
  actorId: string;
}): Promise<void> {
  const account = await requireConsoleAccount(userId);
  const name = displayName.trim();
  if (account.displayName === name) return;

  await getDb().update(appUsers).set({ displayName: name }).where(eq(appUsers.id, userId));
  await writeAuditLog({
    action: 'account.renamed',
    entityType: 'app_users',
    entityId: userId,
    before: { displayName: account.displayName },
    after: { displayName: name },
    actorId,
  });
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function requireConsoleAccount(userId: string) {
  const [account] = await getDb()
    .select({
      id: appUsers.id,
      email: appUsers.email,
      displayName: appUsers.displayName,
      role: appUsers.role,
      isActive: appUsers.isActive,
    })
    .from(appUsers)
    .where(and(eq(appUsers.id, userId), isNull(appUsers.deletedAt)))
    .limit(1);
  return checkConsole(account);
}

async function lockConsoleAccount(tx: Tx, userId: string) {
  const [account] = await tx
    .select({
      id: appUsers.id,
      email: appUsers.email,
      displayName: appUsers.displayName,
      role: appUsers.role,
      isActive: appUsers.isActive,
    })
    .from(appUsers)
    .where(and(eq(appUsers.id, userId), isNull(appUsers.deletedAt)))
    .for('update')
    .limit(1);
  return checkConsole(account);
}

function checkConsole<T extends { role: string }>(account: T | undefined): T {
  if (!account) throw new PeopleProvisionError('That account no longer exists.');
  // Operators live in this table too. None of these controls may reach one —
  // an usher is managed from the concert's Operators screen, and turning one
  // into a console account would hand the door app's credential the console.
  if (account.role !== 'ADMIN' && account.role !== 'VIEWER') {
    throw new PeopleProvisionError('That is not a console account.');
  }
  return account;
}

/**
 * Locks every active admin row, in id order, and returns their ids.
 *
 * **Taken before the target's own row, always.** Every change that can remove
 * an admin runs this first, so two of them queue on the same rows in the same
 * order: the second waits for the first, then re-reads a row the first may have
 * demoted and no longer counts it. Locking the target first instead would let
 * two admins demoting each other each hold one row and wait on the other.
 */
async function lockActiveAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from app_users
     where role = 'ADMIN' and is_active and deleted_at is null
     order by id
       for update
  `);
  return rows.map((row) => row.id);
}

/** Refuses a change that would leave no active admin. */
function refuseIfLastAdmin(admins: string[], userId: string, verb: 'demote' | 'deactivate') {
  if (admins.every((id) => id === userId)) {
    throw new PeopleProvisionError(
      `This is the only active admin. Make someone else an admin before you ${verb} them.`,
    );
  }
}
