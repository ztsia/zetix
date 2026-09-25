import 'server-only';
import { getDb } from '@/db/client';
import { auditLog } from '@/db/schema/audit';
import { getSessionUser } from '@/lib/auth/session';

/**
 * The audit trail for admin overrides (spec/README.md §2.4, spec/domain.md §5.1).
 *
 * Every automated rule in this system has a manual escape hatch — exceeding a
 * capacity, granting extras out of order, admitting a red scan at the door — and
 * the deal is that overrides are *recorded*, never silently blocked. This is
 * where they are recorded.
 *
 * `before` and `after` hold the row on either side of the change, so a record
 * stands on its own months later without having to replay the rest of the log.
 *
 * **Attribution stops at the account, not the person.** There is one shared
 * `ADMIN`, so every admin action is attributed to it (decision 19). That is a
 * known and accepted cost, written down here so the next reader does not mistake
 * it for a bug.
 */

type Db = ReturnType<typeof getDb>;
/**
 * The transaction handle Drizzle hands a `db.transaction()` callback, derived
 * from the client rather than spelled out — `PgTransaction`'s three type
 * parameters have to match the driver exactly, and writing them by hand is how
 * callers end up casting at every call site.
 */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type AuditEntry = {
  /** Past tense and specific: `registration.cancelled`, `segment.capacity_changed`. */
  action: string;
  entityType: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  /** The typed confirmation an admin gives when overriding (spec/allocation.md §7.5). */
  reason?: string | null;
  /** Defaults to the signed-in user. Pass explicitly from a script or a cron. */
  actorId?: string | null;
  /**
   * The concert the change belongs to (`0201`). Optional: the database derives
   * it from `entityType` / `entityId` when it is left out, so pass it only where
   * that cannot work — an entity with no id, or one about to be deleted.
   */
  concertId?: number | null;
  /** The command run this change is part of (spec/v3.md §23.1). */
  commandRunId?: number | null;
};

/**
 * Writes one audit row.
 *
 * **Pass `tx` whenever the change being audited is itself in a transaction.**
 * A log written on a separate connection survives a rollback of the thing it
 * describes, which is worse than no log: it records an override that never
 * happened.
 *
 * **Passing `tx` requires passing `actorId`, and the overloads below enforce
 * it at compile time.** Without one this resolves the actor with
 * `getSessionUser()`, which issues *its own query*; `src/db/client.ts` is
 * `max: 1`, so inside a transaction that query waits for the connection the
 * transaction is already holding and the request deadlocks against itself —
 * then starves the pool, taking the rest of the console down with it.
 *
 * That shipped twice in module `A` and no test caught it: suites mock
 * `@/lib/auth/session`, so the fatal query never runs under test. A runtime
 * test therefore cannot be the guard. Making it a type error means `tsc` is,
 * and CI already runs `tsc`. The runtime check below covers the paths types do
 * not reach, and fails loudly instead of hanging.
 *
 * Callers already have the value: `requireAdmin()` returns the user.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void>;
export async function writeAuditLog(
  entry: AuditEntry & { actorId: string | null },
  tx: Tx,
): Promise<void>;
export async function writeAuditLog(entry: AuditEntry, tx?: Tx): Promise<void> {
  if (tx && entry.actorId === undefined) {
    throw new Error(
      'writeAuditLog was given a transaction but no actorId. Resolving the ' +
        'actor needs a second connection, and the pool holds one — this would ' +
        'deadlock against the transaction rather than fail. Pass the user ' +
        'requireAdmin() returned.',
    );
  }

  const actorId =
    entry.actorId !== undefined ? entry.actorId : ((await getSessionUser())?.id ?? null);

  const values = {
    actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId == null ? null : String(entry.entityId),
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    concertId: entry.concertId ?? null,
    commandRunId: entry.commandRunId ?? null,
  };

  const db: Db | Tx = tx ?? getDb();
  await db.insert(auditLog).values(values);
}
