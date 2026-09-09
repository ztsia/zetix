import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * The live check-in dashboard's reads (spec/checkin.md §12.4).
 *
 * §12.4 is one sentence — "confirmed, checked in, remaining, arrival rate over
 * time, per-operator counts, and a searchable scan log with revert" — so the
 * definitions behind those words are settled here, once, and shared by the page
 * and its tests.
 *
 * **Every count excludes reverted rows.** A revert is the admin undoing a
 * mistaken scan (decision 7); leaving it in the totals would report an arrival
 * that the admin has just said did not happen, and the door uses these numbers
 * to decide when to stop holding seats.
 *
 * **Counts are of distinct attendees, not of rows.** `check_ins` is append-only
 * and §12.3 explicitly accepts duplicates from two offline devices rather than
 * attempting distributed locking — so a row count would double-count exactly the
 * people the offline design expects to be scanned twice.
 */

/** What one attendee's row in the scan log looks like on screen. */
export type ScanLogRow = {
  id: number;
  attendeeId: number;
  attendeeName: string;
  ticketCode: string | null;
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  operatorId: string | null;
  operatorName: string | null;
  deviceId: string | null;
  scannedAt: string;
  syncedAt: string | null;
  source: 'ONLINE' | 'OFFLINE_SYNC' | 'MANUAL';
  overrideReason: string | null;
  revertedAt: string | null;
  revertedByName: string | null;
};

export type CheckinStats = {
  /** Seats that should walk through the door tonight. */
  confirmed: number;
  /** Confirmed attendees with at least one live scan. */
  checkedIn: number;
  /** `confirmed - checkedIn`, never below zero. */
  remaining: number;
  /**
   * Admitted despite not being confirmed — a cancelled or waitlisted ticket the
   * usher let through with **Admit anyway** (spec/checkin.md §12.1: amber and
   * red are never hard blocks).
   *
   * Kept out of `checkedIn` so that `confirmed - checkedIn` stays the number of
   * expected guests still outside, and surfaced separately because it is the
   * count worth a second look at the desk rather than one to bury.
   */
  admittedUnconfirmed: number;
};

/**
 * How wide one bar of the arrival chart is.
 *
 * **Not an operational value in CLAUDE.md's sense** — no capacity, quota,
 * deadline or party cap from `context.md` is involved, and nothing about the
 * concert changes if it moves. It is a presentation choice: five minutes is fine
 * enough to show a queue building and coarse enough that a full house arriving
 * inside twenty minutes still reads as a shape rather than noise.
 */
export const ARRIVAL_BUCKET_MINUTES = 5;

export type ArrivalBucket = { bucketStart: string; count: number };

export type OperatorCount = {
  operatorId: string | null;
  operatorName: string | null;
  count: number;
};

export async function getCheckinStats(showId: number): Promise<CheckinStats> {
  const rows = await getDb().execute<{
    confirmed: number;
    checked_in: number;
    admitted_unconfirmed: number;
  }>(sql`
    with live as (
      select distinct c.attendee_id
        from check_ins c
       where c.show_id = ${showId}
         and c.reverted_at is null
    )
    select
      (select count(*)::int
         from attendees a
        where a.show_id = ${showId}
          and a.status = 'CONFIRMED') as confirmed,
      (select count(*)::int
         from live
         join attendees a on a.id = live.attendee_id
        where a.status = 'CONFIRMED') as checked_in,
      (select count(*)::int
         from live
         join attendees a on a.id = live.attendee_id
        where a.status <> 'CONFIRMED') as admitted_unconfirmed
  `);

  const row = rows[0];
  const confirmed = Number(row?.confirmed ?? 0);
  const checkedIn = Number(row?.checked_in ?? 0);

  return {
    confirmed,
    checkedIn,
    // Clamped: a door that admitted more confirmed guests than the roster holds
    // is impossible by construction, but "-3 remaining" would be a worse way to
    // find out than a zero.
    remaining: Math.max(0, confirmed - checkedIn),
    admittedUnconfirmed: Number(row?.admitted_unconfirmed ?? 0),
  };
}

/**
 * Arrivals per time bucket, in `scanned_at` order.
 *
 * **Bucketed on `scanned_at`, not `synced_at`.** `scanned_at` is when the phone
 * read the QR; `synced_at` is when the row reached the server, and they differ
 * by however long the usher was offline (spec/checkin.md §12.3). Charting the
 * sync time would draw a flat line through the whole arrival window and then a
 * spike at the moment the wifi came back — a picture of the network, not of the
 * queue.
 *
 * Buckets with no arrivals are absent rather than zero-filled; the chart fills
 * the gaps, because only it knows the window it wants to draw.
 */
export async function getArrivalBuckets(
  showId: number,
  bucketMinutes: number = ARRIVAL_BUCKET_MINUTES,
): Promise<ArrivalBucket[]> {
  const rows = await getDb().execute<{ bucket_start: string; count: number }>(sql`
    select
      to_char(
        date_bin(
          ${`${bucketMinutes} minutes`}::interval,
          first_scan,
          timestamptz '2000-01-01 00:00:00+00'
        ) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ) as bucket_start,
      count(*)::int as count
    from (
      -- One row per attendee, at their *first* live scan: a party admitted in
      -- one tap and a ticket scanned twice on two phones are both one arrival.
      select c.attendee_id, min(c.scanned_at) as first_scan
        from check_ins c
       where c.show_id = ${showId}
         and c.reverted_at is null
       group by c.attendee_id
    ) arrivals
    group by 1
    order by 1
  `);

  return rows.map((row) => ({
    bucketStart: row.bucket_start,
    count: Number(row.count),
  }));
}

/**
 * Live scans per operator, busiest first (spec/checkin.md §12.4).
 *
 * `operator_id` is nullable and the join is a left join: a scan whose operator
 * was later removed still happened, and dropping it would make the per-operator
 * counts disagree with the total on the same screen.
 */
export async function getOperatorCounts(showId: number): Promise<OperatorCount[]> {
  const rows = await getDb().execute<{
    operator_id: string | null;
    operator_name: string | null;
    count: number;
  }>(sql`
    select
      c.operator_id,
      u.display_name as operator_name,
      count(distinct c.attendee_id)::int as count
    from check_ins c
    left join app_users u on u.id = c.operator_id
    where c.show_id = ${showId}
      and c.reverted_at is null
    group by c.operator_id, u.display_name
    order by count desc, u.display_name asc nulls last
  `);

  return rows.map((row) => ({
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    count: Number(row.count),
  }));
}

/** Only these can be sorted on — never interpolate a column name from a query string. */
const SCAN_LOG_SORTABLE = {
  scannedAt: sql`c.scanned_at`,
  attendeeName: sql`a.full_name`,
  operatorName: sql`u.display_name`,
  source: sql`c.source`,
} as const;

export type ScanLogSort = keyof typeof SCAN_LOG_SORTABLE;

export type ScanLogQuery = {
  showId: number;
  pageIndex: number;
  pageSize: number;
  sort: ScanLogSort | null;
  desc: boolean;
  search: string;
  /** Reverted rows are hidden by default; the log can still show them. */
  includeReverted: boolean;
};

/**
 * One page of the scan log (spec/checkin.md §12.4).
 *
 * Paged, sorted and searched **in Postgres**, following `/admin/concerts`
 * (modules.md §5.2.1 names the scan log as one of the three that must). The
 * three move together on purpose: a server-paged table that filtered in the
 * browser would search only the rows already on screen.
 *
 * **Reverted rows are kept and shown, struck through, rather than filtered out
 * of existence.** The log is the record of the night, and a revert is part of
 * that record — decision 7 keeps the row precisely so the history stays
 * reconstructable afterwards.
 */
export async function getScanLog(
  query: ScanLogQuery,
): Promise<{ rows: ScanLogRow[]; total: number }> {
  const { showId, pageIndex, pageSize, sort, desc, search, includeReverted } = query;
  const db = getDb();

  const like = `%${search.trim()}%`;
  const searching = search.trim().length > 0;

  const where = sql`
    c.show_id = ${showId}
    ${includeReverted ? sql`` : sql`and c.reverted_at is null`}
    ${
      searching
        ? sql`and (a.full_name ilike ${like}
                or a.ticket_code ilike ${like}
                or u.display_name ilike ${like}
                or c.device_id ilike ${like})`
        : sql``
    }
  `;

  const orderColumn = sort ? SCAN_LOG_SORTABLE[sort] : SCAN_LOG_SORTABLE.scannedAt;
  const direction = sort ? (desc ? sql`desc` : sql`asc`) : sql`desc`;

  const rows = await db.execute<{
    id: number;
    attendee_id: number;
    attendee_name: string;
    ticket_code: string | null;
    status: ScanLogRow['status'];
    operator_id: string | null;
    operator_name: string | null;
    device_id: string | null;
    scanned_at: string;
    synced_at: string | null;
    source: ScanLogRow['source'];
    override_reason: string | null;
    reverted_at: string | null;
    reverted_by_name: string | null;
  }>(sql`
    select
      c.id,
      c.attendee_id,
      a.full_name as attendee_name,
      a.ticket_code,
      a.status,
      c.operator_id,
      u.display_name as operator_name,
      c.device_id,
      c.scanned_at,
      c.synced_at,
      c.source,
      c.override_reason,
      c.reverted_at,
      r.display_name as reverted_by_name
    from check_ins c
    join attendees a on a.id = c.attendee_id
    left join app_users u on u.id = c.operator_id
    left join app_users r on r.id = c.reverted_by
    where ${where}
    -- Ties are broken by id so a row cannot appear on two pages, or on neither,
    -- when many scans share a second.
    order by ${orderColumn} ${direction} nulls last, c.id desc
    limit ${pageSize} offset ${pageIndex * pageSize}
  `);

  const totals = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from check_ins c
    join attendees a on a.id = c.attendee_id
    left join app_users u on u.id = c.operator_id
    where ${where}
  `);

  return {
    rows: rows.map((row) => ({
      id: Number(row.id),
      attendeeId: Number(row.attendee_id),
      attendeeName: row.attendee_name,
      ticketCode: row.ticket_code,
      status: row.status,
      operatorId: row.operator_id,
      operatorName: row.operator_name,
      deviceId: row.device_id,
      scannedAt: new Date(row.scanned_at).toISOString(),
      syncedAt: row.synced_at ? new Date(row.synced_at).toISOString() : null,
      source: row.source,
      overrideReason: row.override_reason,
      revertedAt: row.reverted_at ? new Date(row.reverted_at).toISOString() : null,
      revertedByName: row.reverted_by_name,
    })),
    total: Number(totals[0]?.total ?? 0),
  };
}
