import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';

/**
 * Walk-ins: people admitted with no ticket and no roster row
 * (spec/v3.md §32.2, decision 58).
 *
 * **One row per tap**, never a counter and never a fabricated registration. A
 * counter cannot merge offline taps from several phones or undo one mistake; a
 * fake party would drag walk-ins into allocation, Audience and email. Every
 * count that wants the hall adds them in explicitly.
 *
 * **Reverted, never deleted** (decision 7). An operator may undo their own
 * entry on the phone before it syncs; once on the server, only an admin can
 * revert it, and the revert is audited.
 */

export type WalkInInput = {
  /** Minted on the phone at tap time: what makes a re-sent sync harmless. */
  clientId: string;
  headcount: number;
  label: string | null;
  segmentId: number | null;
  /** The phone's clock, preserved through a delayed sync. */
  admittedAt: string;
  deviceId: string;
};

export type WalkInOutcome =
  | { outcome: 'RECORDED' | 'ALREADY_SYNCED' }
  | { outcome: 'REFUSED'; reason: string };

/**
 * Record one walk-in, idempotently on `client_id`.
 *
 * The caller has already checked the session, the role and the show
 * assignment, and the settings (§32.5); this is the write. A `client_id` the
 * table already holds for *another* show is refused rather than reported as
 * synced, so a replayed id cannot vouch for a row it does not own.
 */
export async function recordWalkIn(
  input: WalkInInput,
  ctx: { showId: number; operatorId: string },
): Promise<WalkInOutcome> {
  const db = getDb();
  try {
    const inserted = await db.execute<{ id: number }>(sql`
      insert into walk_ins (client_id, show_id, segment_id, headcount, label, operator_id, device_id, admitted_at)
      values (${input.clientId}::uuid, ${ctx.showId}, ${input.segmentId}, ${input.headcount},
              ${input.label}, ${ctx.operatorId}, ${input.deviceId}, ${input.admittedAt}::timestamptz)
      on conflict (client_id) do nothing
      returning id
    `);
    if (inserted.length > 0) return { outcome: 'RECORDED' };
  } catch {
    // The composite key refused a segment of another show, or Postgres refused
    // the time. Either is this row's answer, not the batch's.
    return { outcome: 'REFUSED', reason: 'The server could not read this walk-in.' };
  }

  const [existing] = await db.execute<{ show_id: string }>(sql`
    select show_id from walk_ins where client_id = ${input.clientId}::uuid
  `);
  return existing && Number(existing.show_id) === ctx.showId
    ? { outcome: 'ALREADY_SYNCED' }
    : { outcome: 'REFUSED', reason: 'The server could not read this walk-in.' };
}

export type WalkInRow = {
  id: number;
  headcount: number;
  label: string | null;
  segmentName: string | null;
  operatorName: string | null;
  deviceId: string | null;
  admittedAt: string;
  syncedAt: string;
  revertedAt: string | null;
  revertedByName: string | null;
};

/** The walk-ins log for one show, newest first: the Door screen and the export. */
export async function listWalkIns(
  showId: number,
  options: { includeReverted: boolean } = { includeReverted: true },
): Promise<WalkInRow[]> {
  const rows = await getDb().execute<{
    id: string;
    headcount: number;
    label: string | null;
    segment_name: string | null;
    operator_name: string | null;
    device_id: string | null;
    admitted_at: string;
    synced_at: string;
    reverted_at: string | null;
    reverted_by_name: string | null;
  }>(sql`
    select w.id, w.headcount, w.label, g.name as segment_name,
           u.display_name as operator_name, w.device_id,
           to_json(w.admitted_at) #>> '{}' as admitted_at,
           to_json(w.synced_at) #>> '{}' as synced_at,
           to_json(w.reverted_at) #>> '{}' as reverted_at,
           r.display_name as reverted_by_name
      from walk_ins w
      left join show_segments g on g.id = w.segment_id
      left join app_users u on u.id = w.operator_id
      left join app_users r on r.id = w.reverted_by
     where w.show_id = ${showId}
       ${options.includeReverted ? sql`` : sql`and w.reverted_at is null`}
     order by w.admitted_at desc, w.id desc
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    headcount: row.headcount,
    label: row.label,
    segmentName: row.segment_name,
    operatorName: row.operator_name,
    deviceId: row.device_id,
    admittedAt: new Date(row.admitted_at).toISOString(),
    syncedAt: new Date(row.synced_at).toISOString(),
    revertedAt: row.reverted_at ? new Date(row.reverted_at).toISOString() : null,
    revertedByName: row.reverted_by_name,
  }));
}

export class WalkInRevertError extends Error {}

/**
 * Revert one walk-in: an admin's correction, audited (§32.2). Guarded on
 * `reverted_at is null` in the statement, so two admins clicking the same row
 * cannot re-attribute the revert to whoever was slower.
 */
export async function revertWalkIn({
  walkInId,
  showId,
  concertId,
  actorId,
  reason,
}: {
  walkInId: number;
  /** The show the admin was looking at, matched so a forged id reverts nothing elsewhere. */
  showId: number;
  concertId: number;
  actorId: string;
  reason?: string | null;
}): Promise<void> {
  const db = getDb();
  const updated = await db.execute<{ headcount: number; admitted_at: string }>(sql`
    update walk_ins w
       set reverted_at = now(), reverted_by = ${actorId}
      from shows s
     where w.id = ${walkInId} and w.show_id = ${showId}
       and s.id = w.show_id and s.concert_id = ${concertId}
       and w.reverted_at is null
    returning w.headcount, to_json(w.admitted_at) #>> '{}' as admitted_at
  `);
  if (updated.length === 0) {
    throw new WalkInRevertError('That walk-in is not in this show’s log, or was already reverted.');
  }
  await writeAuditLog({
    action: 'checkin.walk_in_reverted',
    entityType: 'walk_ins',
    entityId: walkInId,
    concertId,
    before: { showId, headcount: updated[0]!.headcount, admittedAt: updated[0]!.admitted_at, revertedAt: null },
    after: { revertedBy: actorId },
    reason: reason ?? null,
    actorId,
  });
}
