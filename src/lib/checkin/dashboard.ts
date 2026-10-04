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
  /**
   * People admitted with no ticket and no roster row, by headcount, reverted
   * ones excluded (spec/v3.md §32.2).
   */
  walkIns: number;
  /** Everyone through the door: tickets of any status, plus walk-ins. */
  inHall: number;
  /** The hall's capacity, `shows.capacity`. Being over it warns; it never blocks (§12.1). */
  capacity: number | null;
};

/**
 * What the door's Stats tab shows (spec/v3.md §32.2, decision 59): the house
 * for the selected show, and this operator's share of it — from the same
 * implementation the admin Door screen reads, so the two never disagree.
 */
export type DoorStats = CheckinStats & {
  /** Server time of the reading, so the phone can say "as of 19:42". */
  asOf: string;
  /** This operator's admissions on this show, from every phone they used. */
  byYou: { admitted: number; walkIns: number };
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

/** One bar of the arrival chart: ticketed guests and walk-ins, stacked (§32.2). */
export type ArrivalBucket = { bucketStart: string; count: number; walkIns: number };

export type OperatorCount = {
  operatorId: string | null;
  operatorName: string | null;
  count: number;
  /** Walk-ins this operator recorded, by headcount (spec/v3.md §32.2). */
  walkIns: number;
};

export async function getCheckinStats(showId: number): Promise<CheckinStats> {
  const rows = await getDb().execute<{
    confirmed: number;
    checked_in: number;
    admitted_unconfirmed: number;
    walk_ins: number;
    capacity: number | null;
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
          and a.deleted_at is null
          and a.status = 'CONFIRMED') as confirmed,
      (select coalesce(sum(w.headcount), 0)::bigint
         from walk_ins w
        where w.show_id = ${showId}
          and w.reverted_at is null) as walk_ins,
      (select s.capacity from shows s where s.id = ${showId}) as capacity,
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
  const admittedUnconfirmed = Number(row?.admitted_unconfirmed ?? 0);
  const walkIns = Number(row?.walk_ins ?? 0);

  return {
    confirmed,
    checkedIn,
    // Clamped: a door that admitted more confirmed guests than the roster holds
    // is impossible by construction, but "-3 remaining" would be a worse way to
    // find out than a zero.
    remaining: Math.max(0, confirmed - checkedIn),
    admittedUnconfirmed,
    walkIns,
    inHall: checkedIn + admittedUnconfirmed + walkIns,
    capacity: row?.capacity == null ? null : Number(row.capacity),
  };
}

/**
 * The door's Stats tab, for one show and one operator (spec/v3.md §32.2).
 *
 * Counts only — no names — and the caller has already held the request to the
 * manifest's own rule: an operator not rostered on the show gets a 404.
 */
export async function getDoorStats(showId: number, operatorId: string): Promise<DoorStats> {
  const [house, mine] = await Promise.all([
    getCheckinStats(showId),
    getDb().execute<{ admitted: number; walk_ins: number; as_of: string }>(sql`
      select
        (select count(distinct c.attendee_id)::int
           from check_ins c
          where c.show_id = ${showId}
            and c.operator_id = ${operatorId}
            and c.reverted_at is null) as admitted,
        (select coalesce(sum(w.headcount), 0)::bigint
           from walk_ins w
          where w.show_id = ${showId}
            and w.operator_id = ${operatorId}
            and w.reverted_at is null) as walk_ins,
        to_json(now()) #>> '{}' as as_of
    `),
  ]);
  const row = mine[0];
  return {
    ...house,
    asOf: new Date(row?.as_of ?? Date.now()).toISOString(),
    byYou: { admitted: Number(row?.admitted ?? 0), walkIns: Number(row?.walk_ins ?? 0) },
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
  const rows = await getDb().execute<{ bucket_start: string; count: number; walk_ins: number }>(sql`
    with events as (
      -- One row per attendee, at their *first* live scan: a party admitted in
      -- one tap and a ticket scanned twice on two phones are both one arrival.
      -- Sums of headcount are bigint: an int sum overflows long before the
      -- column does, and the stats endpoint would answer 500 until reverted.
      select min(c.scanned_at) as at, 1 as ticketed, 0::bigint as walk_ins
        from check_ins c
       where c.show_id = ${showId}
         and c.reverted_at is null
       group by c.attendee_id
      union all
      -- Walk-ins by headcount, at the phone's time of the tap.
      select w.admitted_at, 0, w.headcount::bigint
        from walk_ins w
       where w.show_id = ${showId}
         and w.reverted_at is null
    )
    select
      to_char(
        date_bin(
          ${`${bucketMinutes} minutes`}::interval,
          at,
          timestamptz '2000-01-01 00:00:00+00'
        ) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ) as bucket_start,
      sum(ticketed)::int as count,
      sum(walk_ins)::bigint as walk_ins
    from events
    group by 1
    order by 1
  `);

  return rows.map((row) => ({
    bucketStart: row.bucket_start,
    count: Number(row.count),
    walkIns: Number(row.walk_ins),
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
    walk_ins: number;
  }>(sql`
    with per as (
      select c.operator_id, count(distinct c.attendee_id)::int as count, 0::bigint as walk_ins
        from check_ins c
       where c.show_id = ${showId}
         and c.reverted_at is null
       group by c.operator_id
      union all
      select w.operator_id, 0, sum(w.headcount)::bigint
        from walk_ins w
       where w.show_id = ${showId}
         and w.reverted_at is null
       group by w.operator_id
    )
    select per.operator_id, u.display_name as operator_name,
           sum(per.count)::int as count, sum(per.walk_ins)::bigint as walk_ins
      from per
      left join app_users u on u.id = per.operator_id
     group by per.operator_id, u.display_name
     order by sum(per.count) + sum(per.walk_ins) desc, u.display_name asc nulls last
  `);

  return rows.map((row) => ({
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    count: Number(row.count),
    walkIns: Number(row.walk_ins),
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
  /** Null for every matching row: the whole-set export (spec/v3.md §32.1). */
  pageSize: number | null;
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

  /**
   * `%`, `_` and `\` are escaped before the term is wrapped.
   *
   * They are `ILIKE` metacharacters, so an unescaped `%` matches everything and
   * a search for it silently returns the whole log — which reads as "no filter
   * applied" rather than "nothing found". Device ids are among the searched
   * columns and are the field most likely to contain an underscore.
   *
   * The term is parameterised either way, so this is about the search meaning
   * what it says, not about injection.
   */
  const escaped = search.trim().replace(/([\\%_])/g, '\\$1');
  const like = `%${escaped}%`;
  const searching = search.trim().length > 0;

  // A caller passing 0 or a negative page size would otherwise reach Postgres as
  // `LIMIT -1` and throw. The page clamps its own input; this makes the library
  // safe for any caller.
  const limit = pageSize === null ? null : Math.max(1, Math.trunc(pageSize));
  const offset = limit === null ? 0 : Math.max(0, Math.trunc(pageIndex)) * limit;

  const where = sql`
    c.show_id = ${showId}
    ${includeReverted ? sql`` : sql`and c.reverted_at is null`}
    ${
      searching
        ? sql`and (a.full_name ilike ${like} escape '\\'
                or a.ticket_code ilike ${like} escape '\\'
                or u.display_name ilike ${like} escape '\\'
                or c.device_id ilike ${like} escape '\\')`
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
    ${limit === null ? sql`` : sql`limit ${limit} offset ${offset}`}
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
