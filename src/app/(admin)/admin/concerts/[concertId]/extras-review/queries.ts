import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loadReviewQueue } from '@/lib/registrations/review';
import type { SegmentPool } from '@/db/allocation';

/**
 * What the extras review screen loads (spec/allocation.md §7.5).
 *
 * The queue itself comes from `src/lib/registrations/review.ts`, which is also
 * what the commit uses — so the walk the screen shows and the seats the commit
 * decides are computed by the same function, in the same order.
 */

export type ReviewSegmentOption = {
  id: number;
  label: string;
  pending: number;
};

export type ReviewRow = {
  registrationId: number;
  requestedAt: Date;
  roundLabel: string | null;
  playerName: string | null;
  contactName: string;
  contactEmail: string | null;
  seatsRequested: number;
  seatsConfirmed: number;
  guestNames: string[];
};

export type ReviewBoardData = {
  segment: { id: number; name: string; showName: string };
  pool: SegmentPool;
  allowPartialGrant: boolean;
  requests: ReviewRow[];
  preselection: { registrationId: number; granted: number }[];
};

/**
 * Every segment of the concert, with how many seats are waiting in each.
 *
 * All of them, not only the ones under `REVIEW`: a segment on `AUTO_FCFS` has an
 * empty queue and says so, which is a more useful answer than not appearing at
 * all when an admin goes looking for it.
 */
export async function listReviewSegments(
  concertId: number,
): Promise<ReviewSegmentOption[]> {
  const rows = await getDb().execute<{
    id: string;
    name: string;
    show_name: string;
    pending: number;
  }>(sql`
    select g.id, g.name, s.name as show_name,
           coalesce((
             select count(*)::int
               from attendees a
               join registrations r on r.id = a.registration_id
              where a.segment_id = g.id
                and a.status = 'PENDING_REVIEW'
                and a.deleted_at is null
                and r.deleted_at is null
                and r.status <> 'CANCELLED'), 0) as pending
      from show_segments g
      join shows s on s.id = g.show_id
     where s.concert_id = ${concertId}
       and g.deleted_at is null
       and s.deleted_at is null
     order by s.starts_at nulls last, s.id, g.display_order nulls last, g.id
  `);

  return rows.map((row) => ({
    id: Number(row.id),
    label: `${row.show_name} · ${row.name}`,
    pending: row.pending,
  }));
}

/** The board for one segment. */
export async function loadReviewBoard(segmentId: number): Promise<ReviewBoardData> {
  const queue = await loadReviewQueue(segmentId);

  return {
    segment: {
      id: queue.segment.id,
      name: queue.segment.name,
      showName: queue.segment.showName,
    },
    pool: queue.pool,
    allowPartialGrant: queue.allowPartialGrant,
    requests: queue.requests.map((request) => ({
      registrationId: request.registrationId,
      requestedAt: request.requestedAt,
      roundLabel: request.roundLabel,
      playerName: request.playerName,
      contactName: request.contactName,
      contactEmail: request.contactEmail,
      seatsRequested: request.seatsRequested,
      seatsConfirmed: request.seatsConfirmed,
      guestNames: request.guestNames,
    })),
    preselection: queue.preselection.rows.map((row) => ({
      registrationId: row.registrationId,
      granted: row.granted,
    })),
  };
}
