import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { QR_TOKEN_LENGTH } from '@/lib/checkin/token';

/**
 * What `/t/{qr_token}` is allowed to say about one ticket
 * (spec/README.md §4.1, spec/v2.md §13.2).
 *
 * **The credential is the token itself.** 128 bits of CSPRNG entropy in the
 * URL, unique-indexed, and this read is scoped to the single row it names —
 * there is no session, no role, and nothing here can widen to a second
 * attendee. That is the whole authorization story for this surface
 * (spec/v2.md §13.3), and it is why the query below has no join to
 * `registrations`: the contact name, the email and the rest of the party are
 * not this page's business.
 *
 * Read through Drizzle on the server connection, deliberately. Decision 20b's
 * concern is the roster reachable over PostgREST with a key that ships in the
 * browser bundle; a Server Component reading one row by an unguessable token is
 * the opposite shape, and `manifest_for_show()` would be the wrong tool — it
 * answers "may this operator see this show's roster", a question with no
 * meaning here.
 *
 * **Nothing about admission depends on this** (decision 28). The scanner never
 * dereferences the QR, so every function in this file could throw and the door
 * would still admit every guest.
 */

/** The three states of §13.2's table, as V1 renders them. */
export type TicketState = 'ISSUED' | 'ADMITTED' | 'CANCELLED';

export type TicketStatus = {
  state: TicketState;
  /** The holder's own name, and the only person named on this page. */
  attendeeName: string;
  ticketCode: string | null;
  qrToken: string;
  concertName: string;
  /**
   * Null is survivable rather than fatal — see {@link formatMoment}. Every
   * printed timestamp resolves in this zone and never the viewer's
   * (`CLAUDE.md`, spec/domain.md §6.1).
   */
  timeZone: string | null;
  show: {
    name: string;
    startsAt: Date | null;
    doorsOpenAt: Date | null;
    venueName: string | null;
    venueAddress: string | null;
  };
  /** The earliest live scan, when there is one. Drives the checked-in badge. */
  admittedAt: Date | null;
};

/**
 * The token shape, built from module `D`'s own constant rather than a second
 * literal `22`.
 *
 * Checked before the database is touched. Not a security control — the column
 * is unique-indexed and the query is parameterised either way — but a scanner
 * that hands back a prefixed payload, or a hand-typed URL, should cost a 404
 * rather than a round trip.
 */
const TOKEN_SHAPE = new RegExp(`^[0-9A-Za-z]{${QR_TOKEN_LENGTH}}$`);

export function isTokenShaped(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

/**
 * One ticket by its token, or `null` when there is nothing to show.
 *
 * **`null` covers "no such token" and "soft-deleted" alike, and says which it
 * was to nobody.** The two are one state to a ticket holder, and distinguishing
 * them would turn this page into an oracle for probing tokens.
 *
 * The filters match `manifest_for_show()` exactly — `deleted_at is null`, and
 * cancellation read off `attendees.status` — because the door and this page
 * must never disagree about a ticket in the same hand. A registration-level
 * cancellation reaches `attendees.status` through the `0001` cascade trigger,
 * so the attendee's own status is the complete signal and neither side needs to
 * join `registrations` to find it.
 */
export async function ticketStatus(token: string): Promise<TicketStatus | null> {
  if (!isTokenShaped(token)) return null;

  const rows = await getDb().execute<{
    full_name: string;
    ticket_code: string | null;
    status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
    show_name: string;
    starts_at: string | null;
    doors_open_at: string | null;
    venue_name: string | null;
    venue_address: string | null;
    concert_name: string;
    timezone: string | null;
    admitted_at: string | null;
  }>(sql`
    select
      a.full_name,
      a.ticket_code,
      a.status,
      s.name          as show_name,
      s.starts_at,
      s.doors_open_at,
      s.venue_name,
      s.venue_address,
      c.name          as concert_name,
      c.timezone,
      ci.scanned_at   as admitted_at
    from attendees a
    join shows s    on s.id = a.show_id
    join concerts c on c.id = s.concert_id
    -- The earliest scan that still stands. check_ins is append-only and a
    -- revert stamps reverted_at rather than deleting (decision 7), so a
    -- reverted admission must read as never having happened here -- otherwise
    -- an admin undoing a mis-scan leaves the guest's own page insisting they
    -- are inside.
    left join lateral (
      select k.scanned_at
        from check_ins k
       where k.attendee_id = a.id
         and k.reverted_at is null
       order by k.scanned_at
       limit 1
    ) ci on true
    where a.qr_token = ${token}
      and a.deleted_at is null
    limit 1
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    /**
     * **Cancelled outranks admitted.** Both can be true — a party cancelled
     * after someone was scanned in — and §13.2 gives cancellation its own
     * terminal message. "No longer valid, see the front desk" sends them to a
     * human who can see the whole picture; a checked-in badge on a cancelled
     * ticket would send them nowhere.
     */
    state: row.status === 'CANCELLED' ? 'CANCELLED' : row.admitted_at ? 'ADMITTED' : 'ISSUED',
    attendeeName: row.full_name,
    ticketCode: row.ticket_code,
    qrToken: token,
    concertName: row.concert_name,
    timeZone: row.timezone,
    show: {
      name: row.show_name,
      startsAt: row.starts_at ? new Date(row.starts_at) : null,
      doorsOpenAt: row.doors_open_at ? new Date(row.doors_open_at) : null,
      venueName: row.venue_name,
      venueAddress: row.venue_address,
    },
    admittedAt: row.admitted_at ? new Date(row.admitted_at) : null,
  };
}
