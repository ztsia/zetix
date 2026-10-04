import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import type { SortingState } from '@tanstack/react-table';
import { getDb } from '@/db/client';
import { segmentPool, type Executor, type SegmentPool } from '@/db/allocation';
import { likePattern } from '@/lib/trash/queries';
import { isFilterSelection, type Selection } from '@/lib/commands/selection';
import {
  FLAG_COLUMN,
  findView,
  partyFilter,
  type AudienceFilter,
  type Flag,
  type Stage,
  VIEWS,
} from './filter';

/**
 * What the Audience workspace reads (spec/v3.md §22).
 *
 * Everything pages over `party_pipeline` (§21, `0200`), so a stage, a flag or a
 * "2 of 3 sent" is read from the one place that derives it and never
 * recomputed here. The Seats grain is the seats of the parties the same filter
 * selects (`filter.ts`).
 *
 * Every read is scoped to a concert by the caller, never by the filter, so a
 * filter carried in a command cannot reach another concert's rows.
 */

// ---------------------------------------------------------------------------
// The filter, as SQL
// ---------------------------------------------------------------------------

/**
 * The conditions a filter puts on `party_pipeline p`.
 *
 * With no view, the table lists every party still on the line or beside it
 * (§21.1) — including cancelled ones, which are restorable and therefore still
 * work. A party with no live seat and nothing cancelled is off the line: its
 * stage is null, and it appears only in the unfiltered list.
 */
/**
 * Read options a page passes for its viewer. `searchContacts: false` is a
 * `VIEWER` (spec/v3.md §28): they see addresses and phones masked, so their
 * search must not match on them either — a search is an oracle otherwise.
 */
export type ReadOptions = { searchContacts?: boolean };

export function partyWhere(
  concertId: number,
  filter: AudienceFilter,
  { searchContacts = true }: ReadOptions = {},
): SQL {
  const clauses: SQL[] = [sql`p.concert_id = ${concertId}`];
  const view = findView(filter.view);
  if (view?.kind === 'stage') clauses.push(sql`p.stage = ${view.value}`);
  if (view?.kind === 'flag') clauses.push(sql.raw(`p.${FLAG_COLUMN[view.value]}`));
  if (filter.showId) clauses.push(sql`p.show_id = ${filter.showId}`);
  if (filter.segmentId) clauses.push(sql`p.segment_id = ${filter.segmentId}`);
  if (filter.playerId) clauses.push(sql`p.player_id = ${filter.playerId}`);
  if (filter.source) clauses.push(sql`p.source = ${filter.source}`);
  const search = filter.search?.trim();
  if (search) {
    const like = likePattern(search);
    const contacts = searchContacts
      ? sql`or p.contact_email::text ilike ${like} or p.contact_phone ilike ${like}`
      : sql``;
    // A name that is itself an address is shown masked to a viewer, so it is
    // not searchable by them either.
    const name = (column: SQL) =>
      searchContacts
        ? sql`${column} ilike ${like}`
        : sql`(${column} ilike ${like} and strpos(${column}, '@') = 0)`;
    clauses.push(sql`(
      ${name(sql`p.contact_name`)}
      ${contacts}
      or exists (select 1 from attendees s
                  where s.registration_id = p.registration_id
                    and s.deleted_at is null
                    and (${name(sql`s.full_name`)} or s.ticket_code ilike ${like})))`);
  }
  return sql.join(clauses, sql` and `);
}

/** The Seats grain's own refinements, on `attendees a`. */
function seatWhere(filter: AudienceFilter): SQL {
  const clauses: SQL[] = [sql`a.deleted_at is null`];
  if (filter.seatStatus) clauses.push(sql`a.status = ${filter.seatStatus}`);
  switch (filter.ticket) {
    case 'none':
      clauses.push(sql`a.status = 'CONFIRMED' and (a.qr_token is null or a.ticket_template_id is null)`);
      break;
    case 'issued':
      clauses.push(sql`a.qr_token is not null and a.ticket_template_id is not null and a.ticket_sent_at is null`);
      break;
    case 'delivered':
      clauses.push(sql`a.ticket_sent_at is not null`);
      break;
    case 'needs-reissue':
      clauses.push(sql`a.needs_reissue`);
      break;
  }
  return sql.join(clauses, sql` and `);
}

type Paging = { pageIndex: number; pageSize: number; sorting: SortingState };

/** Sortable columns, by the id the table sends. Anything else falls back to the default. */
const PARTY_SORT: Record<string, string> = {
  requestedAt: 'p.requested_at',
  contactName: 'p.contact_name',
  seats: 'p.live_seats',
  stage: 'p.stage',
};
const SEAT_SORT: Record<string, string> = {
  requestedAt: 'a.requested_at',
  fullName: 'a.full_name',
  contactName: 'p.contact_name',
  ticketCode: 'a.ticket_code',
};

/**
 * First come first: the queue order every stage is worked in (§7.4), so the
 * party that asked first is at the top unless the admin sorts otherwise.
 */
function orderBy(sorting: SortingState, columns: Record<string, string>, fallback: string): SQL {
  const parts = sorting
    .filter((s) => columns[s.id])
    .map((s) => `${columns[s.id]} ${s.desc ? 'desc' : 'asc'} nulls last`);
  return sql.raw(`order by ${[...parts, fallback].join(', ')}`);
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export type SeatCounters = {
  live: number;
  confirmed: number;
  pending: number;
  waitlisted: number;
  cancelled: number;
  issued: number;
  delivered: number;
  admitted: number;
};

export type PartyRow = {
  id: number;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  showId: number;
  showName: string;
  segmentId: number;
  segmentName: string;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  playerId: number | null;
  playerName: string | null;
  source: 'FORM' | 'IMPORT' | 'ADMIN';
  roundLabel: string | null;
  requestedAt: string;
  approvedAt: string | null;
  stage: Stage | null;
  flags: Flag[];
  seats: SeatCounters;
};

type PartyDbRow = {
  registration_id: string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  show_id: string;
  show_name: string;
  segment_id: string;
  segment_name: string;
  audience_mode: PartyRow['audienceMode'];
  player_id: string | null;
  player_name: string | null;
  source: PartyRow['source'];
  round_label: string | null;
  requested_at: string;
  approved_at: string | null;
  stage: Stage | null;
  flags: Flag[] | null;
  live_seats: number;
  confirmed_seats: number;
  pending_seats: number;
  waitlisted_seats: number;
  cancelled_seats: number;
  issued_seats: number;
  delivered_seats: number;
  admitted_seats: number;
};

const PARTY_COLUMNS = sql`
  p.registration_id, p.contact_name, p.contact_email::text as contact_email, p.contact_phone,
  p.show_id, s.name as show_name, p.segment_id, g.name as segment_name, p.audience_mode,
  p.player_id, pl.full_name as player_name, p.source, p.round_label,
  to_json(p.requested_at) #>> '{}' as requested_at,
  to_json(p.approved_at) #>> '{}' as approved_at,
  p.stage, p.flags,
  p.live_seats, p.confirmed_seats, p.pending_seats, p.waitlisted_seats, p.cancelled_seats,
  p.issued_seats, p.delivered_seats, p.admitted_seats`;

const PARTY_JOINS = sql`
  join shows s on s.id = p.show_id
  join show_segments g on g.id = p.segment_id
  left join players pl on pl.id = p.player_id`;

function toParty(row: PartyDbRow): PartyRow {
  return {
    id: Number(row.registration_id),
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    showId: Number(row.show_id),
    showName: row.show_name,
    segmentId: Number(row.segment_id),
    segmentName: row.segment_name,
    audienceMode: row.audience_mode,
    playerId: row.player_id === null ? null : Number(row.player_id),
    playerName: row.player_name,
    source: row.source,
    roundLabel: row.round_label,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    stage: row.stage,
    flags: row.flags ?? [],
    seats: {
      live: row.live_seats,
      confirmed: row.confirmed_seats,
      pending: row.pending_seats,
      waitlisted: row.waitlisted_seats,
      cancelled: row.cancelled_seats,
      issued: row.issued_seats,
      delivered: row.delivered_seats,
      admitted: row.admitted_seats,
    },
  };
}

export type Page<T> = { rows: T[]; total: number };

export async function listParties(
  concertId: number,
  filter: AudienceFilter,
  paging: Paging,
  read: ReadOptions = {},
): Promise<Page<PartyRow>> {
  const rows = await getDb().execute<PartyDbRow & { total: number }>(sql`
    select ${PARTY_COLUMNS}, count(*) over ()::int as total
      from party_pipeline p
      ${PARTY_JOINS}
     where ${partyWhere(concertId, partyFilter(filter), read)}
     ${orderBy(paging.sorting, PARTY_SORT, 'p.requested_at asc, p.registration_id asc')}
     limit ${paging.pageSize} offset ${paging.pageIndex * paging.pageSize}
  `);
  return { rows: rows.map(toParty), total: rows[0]?.total ?? (await countParties(concertId, filter, read)) };
}

/** The total when the requested page is past the end, so the pager can step back. */
async function countParties(concertId: number, filter: AudienceFilter, read: ReadOptions): Promise<number> {
  const [row] = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n from party_pipeline p
     where ${partyWhere(concertId, partyFilter(filter), read)}
  `);
  return row?.n ?? 0;
}

/** Every party id the filter matches, in first-come order — a command's `match` (§22.3). */
export async function matchPartyIds(
  tx: Executor,
  concertId: number,
  filter: AudienceFilter,
): Promise<number[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select p.registration_id as id from party_pipeline p
     where ${partyWhere(concertId, partyFilter(filter))}
     order by p.requested_at, p.registration_id
  `);
  return rows.map((row) => Number(row.id));
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export type SeatRow = {
  id: number;
  registrationId: number;
  fullName: string;
  placeholder: boolean;
  contactName: string;
  showName: string;
  segmentName: string;
  allocationType: 'BASE' | 'EXTRA' | 'HELD' | 'COMP';
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  ticketCode: string | null;
  templateName: string | null;
  templateVersion: number | null;
  issuedAt: string | null;
  sentAt: string | null;
  sentSource: 'EMAIL' | 'MANUAL' | null;
  needsReissue: boolean;
  overCapacity: boolean;
  admittedAt: string | null;
  requestedAt: string;
  partyStage: Stage | null;
};

type SeatDbRow = {
  id: string;
  registration_id: string;
  full_name: string;
  name_source: 'PROVIDED' | 'PLACEHOLDER';
  contact_name: string;
  show_name: string;
  segment_name: string;
  allocation_type: SeatRow['allocationType'];
  status: SeatRow['status'];
  ticket_code: string | null;
  template_name: string | null;
  ticket_template_version: number | null;
  issued_at: string | null;
  sent_at: string | null;
  ticket_sent_source: SeatRow['sentSource'];
  needs_reissue: boolean;
  over_capacity: boolean;
  admitted_at: string | null;
  requested_at: string;
  stage: Stage | null;
};

const SEAT_COLUMNS = sql`
  a.id, a.registration_id, a.full_name, a.name_source, p.contact_name,
  s.name as show_name, g.name as segment_name,
  a.allocation_type, a.status, a.ticket_code,
  t.name as template_name, a.ticket_template_version,
  to_json(a.ticket_issued_at) #>> '{}' as issued_at,
  to_json(a.ticket_sent_at) #>> '{}' as sent_at,
  a.ticket_sent_source, a.needs_reissue,
  (a.over_capacity_at is not null) as over_capacity,
  (select to_json(max(c.scanned_at)) #>> '{}' from check_ins c
    where c.attendee_id = a.id and c.reverted_at is null) as admitted_at,
  to_json(a.requested_at) #>> '{}' as requested_at,
  p.stage`;

function toSeat(row: SeatDbRow): SeatRow {
  return {
    id: Number(row.id),
    registrationId: Number(row.registration_id),
    fullName: row.full_name,
    placeholder: row.name_source === 'PLACEHOLDER',
    contactName: row.contact_name,
    showName: row.show_name,
    segmentName: row.segment_name,
    allocationType: row.allocation_type,
    status: row.status,
    ticketCode: row.ticket_code,
    templateName: row.template_name,
    templateVersion: row.ticket_template_version,
    issuedAt: row.issued_at,
    sentAt: row.sent_at,
    sentSource: row.ticket_sent_source,
    needsReissue: row.needs_reissue,
    overCapacity: row.over_capacity,
    admittedAt: row.admitted_at,
    requestedAt: row.requested_at,
    partyStage: row.stage,
  };
}

const SEAT_FROM = sql`
  attendees a
  join party_pipeline p on p.registration_id = a.registration_id
  join shows s on s.id = a.show_id
  join show_segments g on g.id = a.segment_id
  left join ticket_templates t on t.id = a.ticket_template_id`;

export async function listSeats(
  concertId: number,
  filter: AudienceFilter,
  paging: Paging,
  read: ReadOptions = {},
): Promise<Page<SeatRow>> {
  const where = sql`${partyWhere(concertId, partyFilter(filter), read)} and ${seatWhere(filter)}`;
  const rows = await getDb().execute<SeatDbRow & { total: number }>(sql`
    select ${SEAT_COLUMNS}, count(*) over ()::int as total
      from ${SEAT_FROM}
     where ${where}
     ${orderBy(paging.sorting, SEAT_SORT, 'p.requested_at asc, a.registration_id asc, a.id asc')}
     limit ${paging.pageSize} offset ${paging.pageIndex * paging.pageSize}
  `);
  let total = rows[0]?.total;
  if (total === undefined) {
    const [row] = await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from attendees a
        join party_pipeline p on p.registration_id = a.registration_id
       where ${where}
    `);
    total = row?.n ?? 0;
  }
  return { rows: rows.map(toSeat), total };
}

/** Every seat id the filter matches, party by party in first-come order. */
export async function matchSeatIds(
  tx: Executor,
  concertId: number,
  filter: AudienceFilter,
): Promise<number[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select a.id from attendees a
      join party_pipeline p on p.registration_id = a.registration_id
     where ${partyWhere(concertId, partyFilter(filter))} and ${seatWhere(filter)}
     order by p.requested_at, a.registration_id, a.requested_at, a.id
  `);
  return rows.map((row) => Number(row.id));
}

// ---------------------------------------------------------------------------
// Export: the whole selection, never a page (spec/v3.md §32.1)
// ---------------------------------------------------------------------------

const idArray = (ids: number[]) => sql`${`{${ids.join(',')}}`}::bigint[]`;

/**
 * Every party a selection covers, in the table's order, for export.
 *
 * The same WHERE the listing and `matchPartyIds` use, so the file holds exactly
 * what "Select all N matching" named, minus what was unticked. Ticked ids are
 * re-scoped to this concert: an id from elsewhere exports nothing.
 */
export async function exportParties(
  concertId: number,
  selection: Selection<AudienceFilter>,
  sorting: SortingState,
): Promise<PartyRow[]> {
  const where = isFilterSelection(selection)
    ? sql`${partyWhere(concertId, partyFilter(selection.filter))}
          and not (p.registration_id = any(${idArray(selection.excludedIds)}))`
    : sql`p.concert_id = ${concertId} and p.registration_id = any(${idArray(selection.ids)})`;
  const rows = await getDb().execute<PartyDbRow>(sql`
    select ${PARTY_COLUMNS}
      from party_pipeline p
      ${PARTY_JOINS}
     where ${where}
     ${orderBy(sorting, PARTY_SORT, 'p.requested_at asc, p.registration_id asc')}
  `);
  return rows.map(toParty);
}

/** Every seat a selection covers, in the table's order, for export. */
export async function exportSeats(
  concertId: number,
  selection: Selection<AudienceFilter>,
  sorting: SortingState,
): Promise<SeatRow[]> {
  const where = isFilterSelection(selection)
    ? sql`${partyWhere(concertId, partyFilter(selection.filter))} and ${seatWhere(selection.filter)}
          and not (a.id = any(${idArray(selection.excludedIds)}))`
    : sql`p.concert_id = ${concertId} and a.deleted_at is null and a.id = any(${idArray(selection.ids)})`;
  const rows = await getDb().execute<SeatDbRow>(sql`
    select ${SEAT_COLUMNS}
      from ${SEAT_FROM}
     where ${where}
     ${orderBy(sorting, SEAT_SORT, 'p.requested_at asc, a.registration_id asc, a.id asc')}
  `);
  return rows.map(toSeat);
}

// ---------------------------------------------------------------------------
// View counts
// ---------------------------------------------------------------------------

/**
 * How many parties each built-in view holds, under the rest of the filter
 * (§22.2: "each with its count"). One statement over the pipeline, so the
 * counts on the view bar and the rows in the table can never disagree.
 */
export async function viewCounts(
  concertId: number,
  filter: AudienceFilter,
  read: ReadOptions = {},
): Promise<{ all: number; views: Record<string, number> }> {
  const base = partyFilter({ ...filter, view: undefined });
  const columns = VIEWS.map((view) =>
    view.kind === 'stage'
      ? sql`count(*) filter (where p.stage = ${view.value})::int`
      : sql`count(*) filter (where ${sql.raw(`p.${FLAG_COLUMN[view.value]}`)})::int`,
  );
  const [row] = await getDb().execute<{ counts: number[]; all: number }>(sql`
    select array[${sql.join(columns, sql`, `)}] as counts, count(*)::int as all
      from party_pipeline p
     where ${partyWhere(concertId, base, read)}
  `);
  const views: Record<string, number> = {};
  VIEWS.forEach((view, index) => {
    views[view.id] = row?.counts[index] ?? 0;
  });
  return { all: row?.all ?? 0, views };
}

// ---------------------------------------------------------------------------
// The extras pool meter (§22.2)
// ---------------------------------------------------------------------------

export type PoolMeter = {
  segmentId: number;
  label: string;
  policy: string | null;
  /** Seats waiting for a first-come decision in this segment. */
  pendingSeats: number;
  pendingParties: number;
  pool: SegmentPool;
};

/**
 * The review board's live counter, kept as the Needs review view's toolbar:
 * per segment with extras waiting, how many seats are left in the pool. It is
 * read from `segment_pool()` — the same figures `promote_seats()` checks
 * against — so the meter and a Grant extras run agree.
 */
export async function poolMeters(
  concertId: number,
  options: { segmentId?: number; showId?: number } = {},
): Promise<PoolMeter[]> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    label: string;
    policy: string | null;
    pending_seats: number;
    pending_parties: number;
  }>(sql`
    select g.id, s.name || ' · ' || g.name as label,
           (resolve_setting('allocation.extras_policy', g.id) #>> '{}') as policy,
           count(a.id)::int as pending_seats,
           count(distinct a.registration_id)::int as pending_parties
      from show_segments g
      join shows s on s.id = g.show_id
      join attendees a on a.segment_id = g.id
                      and a.status = 'PENDING_REVIEW' and a.deleted_at is null
      join registrations r on r.id = a.registration_id
                          and r.deleted_at is null and r.status <> 'CANCELLED'
     where s.concert_id = ${concertId}
       and g.deleted_at is null
       ${options.segmentId ? sql`and g.id = ${options.segmentId}` : sql``}
       ${options.showId ? sql`and g.show_id = ${options.showId}` : sql``}
     group by g.id, s.name, g.name, s.starts_at, s.id, g.display_order
     order by s.starts_at nulls last, s.id, g.display_order nulls last, g.id
  `);
  const meters: PoolMeter[] = [];
  for (const row of rows) {
    meters.push({
      segmentId: Number(row.id),
      label: row.label,
      policy: row.policy,
      pendingSeats: row.pending_seats,
      pendingParties: row.pending_parties,
      pool: await segmentPool(Number(row.id)),
    });
  }
  return meters;
}

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

export type Option = { id: number; label: string };

export async function audienceOptions(concertId: number): Promise<{
  shows: Option[];
  segments: (Option & { showId: number })[];
  players: Option[];
}> {
  const db = getDb();
  const [shows, segments, players] = await Promise.all([
    db.execute<{ id: string; name: string }>(sql`
      select id, name from shows
       where concert_id = ${concertId} and deleted_at is null
       order by starts_at nulls last, id`),
    db.execute<{ id: string; label: string; show_id: string }>(sql`
      select g.id, s.name || ' · ' || g.name as label, g.show_id
        from show_segments g join shows s on s.id = g.show_id
       where s.concert_id = ${concertId} and g.deleted_at is null and s.deleted_at is null
       order by s.starts_at nulls last, s.id, g.display_order nulls last, g.id`),
    db.execute<{ id: string; full_name: string }>(sql`
      select id, full_name from players
       where concert_id = ${concertId} and deleted_at is null
       order by full_name`),
  ]);
  return {
    shows: shows.map((r) => ({ id: Number(r.id), label: r.name })),
    segments: segments.map((r) => ({ id: Number(r.id), label: r.label, showId: Number(r.show_id) })),
    players: players.map((r) => ({ id: Number(r.id), label: r.full_name })),
  };
}
