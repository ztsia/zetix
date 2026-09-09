import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';

/**
 * Scans refused because the operator's assignment was revoked
 * (spec/admin.md §14.3, spec/checkin.md §12.3).
 *
 * §14.3 is explicit about both halves: revoking an assignment "takes effect
 * immediately on the server, including for a device that is currently offline —
 * its queued scans are rejected on sync **and surfaced to the admin rather than
 * silently dropped**."
 *
 * The rejection is the easy half and `/api/checkin/scan` already does it. This
 * is the other half, and it matters because of who is standing where: the
 * refused admissions are people who were physically let into the hall by an
 * usher holding a phone that believed it was still rostered. They exist in the
 * building and nowhere in the database. Without this, the only record is the
 * operator's own IndexedDB, on a device the admin is not holding.
 *
 * **This does not weaken the 404.** The caller still learns nothing — the
 * response is unchanged, and this writes only where the admin can see it. The
 * asymmetry is the point: probing ids must stay indistinguishable from the
 * outside (modules.md §5.2.1) while the desk still finds out.
 */

export const REJECTED_SYNC_ACTION = 'checkin.sync_rejected';

export type RejectedSync = {
  id: number;
  operatorId: string | null;
  operatorName: string | null;
  deviceId: string | null;
  scanCount: number;
  earliestScanAt: string | null;
  latestScanAt: string | null;
  at: string;
};

/**
 * Records one refused batch.
 *
 * **Best effort, and deliberately so.** It runs on a path that has already
 * decided to refuse the request, so a failure here must not turn a clean 404
 * into a 500 — that would tell an unassigned caller that their probe hit
 * something, which is exactly what the 404 exists to prevent.
 */
export async function recordRejectedSync({
  userId,
  showId,
  deviceId,
  scannedAts,
}: {
  userId: string;
  showId: number;
  deviceId: string | null;
  scannedAts: string[];
}): Promise<void> {
  try {
    /**
     * Only for a show that exists.
     *
     * An unassigned caller walking ids would otherwise fill the audit log with
     * one row per guess, and the log the desk actually needs to read on the
     * night would be buried under noise. A refused sync against a *real* show
     * is the event worth surfacing; a refused sync against id 99999 is a probe.
     */
    const [show] = await getDb().execute<{ id: number }>(
      sql`select id from shows where id = ${showId} limit 1`,
    );
    if (!show) return;

    const sorted = [...scannedAts].sort();

    await writeAuditLog({
      action: REJECTED_SYNC_ACTION,
      entityType: 'shows',
      entityId: showId,
      after: {
        deviceId,
        scanCount: scannedAts.length,
        earliestScanAt: sorted[0] ?? null,
        latestScanAt: sorted[sorted.length - 1] ?? null,
      },
      // No attendee is named. The caller was not entitled to this show's roster
      // when the batch arrived, and resolving the digests here would write the
      // roster into the log on their behalf.
      reason: 'Operator is not assigned to this show.',
      actorId: userId,
    });
  } catch {
    // Swallowed on purpose — see the note above.
  }
}

/**
 * Refused batches for one show, most recent first.
 *
 * Read straight from `audit_log` rather than a table of its own: this is an
 * admin-facing record of something an admin's own revocation caused, which is
 * exactly what `audit_log` is for (spec/README.md §2.4), and the schema is
 * frozen (modules.md §4).
 */
export async function getRejectedSyncs(
  showId: number,
  limit = 20,
): Promise<RejectedSync[]> {
  const rows = await getDb().execute<{
    id: number;
    actor_id: string | null;
    operator_name: string | null;
    after: {
      deviceId?: string | null;
      scanCount?: number;
      earliestScanAt?: string | null;
      latestScanAt?: string | null;
    } | null;
    created_at: string;
  }>(sql`
    select
      a.id,
      a.actor_id,
      u.display_name as operator_name,
      a.after,
      a.created_at
    from audit_log a
    left join app_users u on u.id = a.actor_id
    where a.action = ${REJECTED_SYNC_ACTION}
      and a.entity_type = 'shows'
      and a.entity_id = ${String(showId)}
    order by a.created_at desc
    limit ${limit}
  `);

  return rows.map((row) => ({
    id: Number(row.id),
    operatorId: row.actor_id,
    operatorName: row.operator_name,
    deviceId: row.after?.deviceId ?? null,
    scanCount: Number(row.after?.scanCount ?? 0),
    earliestScanAt: row.after?.earliestScanAt ?? null,
    latestScanAt: row.after?.latestScanAt ?? null,
    at: new Date(row.created_at).toISOString(),
  }));
}
