import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * Everything the registrations screen reads (spec/admin.md §14.1,
 * spec/allocation.md §7.6).
 *
 * One row per **registration**, with its seats counted by status rather than
 * listed: a registration is a party of N (decision 31), and the table is a list
 * of parties. The seats themselves appear in the detail sheet, which is where
 * they can actually be edited.
 */

export type SeatCounts = {
  confirmed: number;
  pending: number;
  waitlisted: number;
  cancelled: number;
};

export type RegistrationRow = {
  id: number;
  showId: number;
  showName: string;
  segmentId: number;
  segmentName: string;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  playerId: number | null;
  playerName: string | null;
  roundLabel: string | null;
  source: 'FORM' | 'IMPORT' | 'ADMIN';
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  requestedAt: Date;
  seats: SeatCounts;
  /** Seats already delivered — the party has tickets in an inbox somewhere. */
  ticketsSent: number;
  needsReissue: number;
};

/**
 * Every registration in the concert, newest request first.
 *
 * Client-side paging, not server: this concert is a few hundred parties across
 * two segments (`context.md` §2.1), so the whole set fits one payload and
 * sorting or filtering it is instant. `DataTable` supports server mode and the
 * scan log will want it; paying a round trip per keystroke here would buy
 * nothing.
 */
export async function listRegistrations(concertId: number): Promise<RegistrationRow[]> {
  const rows = await getDb().execute<{
    id: string;
    show_id: string;
    show_name: string;
    segment_id: string;
    segment_name: string;
    audience_mode: 'PLAYER_INVITED' | 'PUBLIC';
    contact_name: string;
    contact_email: string | null;
    contact_phone: string | null;
    player_id: string | null;
    player_name: string | null;
    round_label: string | null;
    source: 'FORM' | 'IMPORT' | 'ADMIN';
    status: RegistrationRow['status'];
    requested_at: string;
    confirmed: number;
    pending: number;
    waitlisted: number;
    cancelled: number;
    tickets_sent: number;
    needs_reissue: number;
  }>(sql`
    select r.id, r.show_id, s.name as show_name,
           r.segment_id, g.name as segment_name, g.audience_mode,
           r.contact_name, r.contact_email, r.contact_phone,
           r.player_id, p.full_name as player_name,
           r.round_label, r.source, r.status, r.requested_at,
           count(a.id) filter (where a.status = 'CONFIRMED')::int      as confirmed,
           count(a.id) filter (where a.status = 'PENDING_REVIEW')::int as pending,
           count(a.id) filter (where a.status = 'WAITLIST')::int       as waitlisted,
           count(a.id) filter (where a.status = 'CANCELLED')::int      as cancelled,
           count(a.id) filter (where a.ticket_sent_at is not null)::int as tickets_sent,
           count(a.id) filter (where a.needs_reissue)::int             as needs_reissue
      from registrations r
      join shows s on s.id = r.show_id
      join show_segments g on g.id = r.segment_id
      left join players p on p.id = r.player_id
      left join attendees a on a.registration_id = r.id and a.deleted_at is null
     where s.concert_id = ${concertId}
       and r.deleted_at is null
     group by r.id, s.name, g.name, g.audience_mode, p.full_name
     order by r.requested_at desc, r.id desc
  `);

  return rows.map((row) => ({
    id: Number(row.id),
    showId: Number(row.show_id),
    showName: row.show_name,
    segmentId: Number(row.segment_id),
    segmentName: row.segment_name,
    audienceMode: row.audience_mode,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    playerId: row.player_id === null ? null : Number(row.player_id),
    playerName: row.player_name,
    roundLabel: row.round_label,
    source: row.source,
    status: row.status,
    requestedAt: new Date(row.requested_at),
    seats: {
      confirmed: row.confirmed,
      pending: row.pending,
      waitlisted: row.waitlisted,
      cancelled: row.cancelled,
    },
    ticketsSent: row.tickets_sent,
    needsReissue: row.needs_reissue,
  }));
}

export type AttendeeRow = {
  id: number;
  fullName: string;
  namePlaceholder: boolean;
  email: string | null;
  allocationType: 'BASE' | 'EXTRA' | 'HELD' | 'COMP';
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  ticketCode: string | null;
  ticketSentAt: Date | null;
  needsReissue: boolean;
};

/** The seats of one party, for the detail sheet. Soft-deleted seats are gone. */
export async function listAttendees(registrationId: number): Promise<AttendeeRow[]> {
  const rows = await getDb().execute<{
    id: string;
    full_name: string;
    name_source: 'PROVIDED' | 'PLACEHOLDER';
    email: string | null;
    allocation_type: AttendeeRow['allocationType'];
    status: AttendeeRow['status'];
    ticket_code: string | null;
    ticket_sent_at: string | null;
    needs_reissue: boolean;
  }>(sql`
    select id, full_name, name_source, email, allocation_type, status,
           ticket_code, ticket_sent_at, needs_reissue
      from attendees
     where registration_id = ${registrationId}
       and deleted_at is null
     order by id
  `);

  return rows.map((row) => ({
    id: Number(row.id),
    fullName: row.full_name,
    namePlaceholder: row.name_source === 'PLACEHOLDER',
    email: row.email,
    allocationType: row.allocation_type,
    status: row.status,
    ticketCode: row.ticket_code,
    ticketSentAt: row.ticket_sent_at === null ? null : new Date(row.ticket_sent_at),
    needsReissue: row.needs_reissue,
  }));
}

export type SegmentOption = {
  id: number;
  label: string;
  showId: number;
  showName: string;
  segmentName: string;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  /**
   * `form.max_tickets_per_response`, **resolved** through the cascade.
   *
   * Null means no cap is configured, not zero — the same reading module `C`
   * applies to the same key. It is read here so the seats field can bound
   * itself; the Server Action resolves it again and is what actually enforces
   * it, because a `max` attribute is a convenience and not a check.
   */
  maxTicketsPerResponse: number | null;
};

/**
 * The segments a registration can be created in or moved to.
 *
 * Every segment of the concert, including those whose form has closed: §7.6 is
 * explicitly about the admin working outside those windows.
 */
export async function listSegmentOptions(concertId: number): Promise<SegmentOption[]> {
  const rows = await getDb().execute<{
    id: string;
    name: string;
    audience_mode: 'PLAYER_INVITED' | 'PUBLIC';
    show_id: string;
    show_name: string;
    max_tickets: number | null;
  }>(sql`
    select g.id, g.name, g.audience_mode, g.show_id, s.name as show_name,
           (resolve_setting('form.max_tickets_per_response', g.id) #>> '{}')::int
             as max_tickets
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
    showId: Number(row.show_id),
    showName: row.show_name,
    segmentName: row.name,
    audienceMode: row.audience_mode,
    maxTicketsPerResponse: row.max_tickets,
  }));
}

export type PlayerOption = { id: number; label: string };

/** Active players of the concert, for the player link on a registration. */
export async function listPlayerOptions(concertId: number): Promise<PlayerOption[]> {
  const rows = await getDb().execute<{
    id: string;
    full_name: string;
    instrument: string | null;
  }>(sql`
    select id, full_name, instrument from players
     where concert_id = ${concertId}
       and deleted_at is null
       and is_active
     order by full_name
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    label: row.instrument ? `${row.full_name} · ${row.instrument}` : row.full_name,
  }));
}

/**
 * Whether a registration belongs to the concert in the URL.
 *
 * Ids reach the Server Actions from the browser, and `requireAdmin()` says the
 * caller may act on *this* console — not that this id is one of its rows. The
 * one shared ADMIN account can reach every concert anyway, so this is about a
 * mistyped or stale id editing something on another concert's screen, which is
 * silent and confusing rather than merely refused.
 */
export async function registrationInConcert(
  concertId: number,
  registrationId: number,
): Promise<boolean> {
  const rows = await getDb().execute<{ ok: boolean }>(sql`
    select true as ok
      from registrations r
      join shows s on s.id = r.show_id
     where r.id = ${registrationId}
       and s.concert_id = ${concertId}
       and r.deleted_at is null
  `);
  return rows.length > 0;
}

/** The same question for one seat. */
export async function attendeeInConcert(
  concertId: number,
  attendeeId: number,
): Promise<boolean> {
  const rows = await getDb().execute<{ ok: boolean }>(sql`
    select true as ok
      from attendees a
      join shows s on s.id = a.show_id
     where a.id = ${attendeeId}
       and s.concert_id = ${concertId}
       and a.deleted_at is null
  `);
  return rows.length > 0;
}

/** And for a destination segment, before a move or a create is attempted. */
export async function segmentInConcert(
  concertId: number,
  segmentId: number,
): Promise<boolean> {
  const rows = await getDb().execute<{ ok: boolean }>(sql`
    select true as ok
      from show_segments g
      join shows s on s.id = g.show_id
     where g.id = ${segmentId}
       and s.concert_id = ${concertId}
       and g.deleted_at is null
  `);
  return rows.length > 0;
}
