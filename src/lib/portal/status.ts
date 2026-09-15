import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { QR_TOKEN_LENGTH } from '@/lib/checkin/token';
import { SHOW_IS_OVER } from './phase';
import { isUnlockMode, type PortalUnlockMode } from './sections';

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

/** The three states of §13.2's table that describe a real ticket. */
export type TicketState = 'ISSUED' | 'ADMITTED' | 'CANCELLED';

/**
 * Everything the V2 portal needs to decide which of §13.3's sections to draw,
 * resolved **through the cascade** and never read off a column (§2.2).
 *
 * It rides on this query rather than a second one because it answers a question
 * about the same single row: one round trip is what this surface gets, on venue
 * wifi, at the worst possible moment (spec/surfaces.md §15.3).
 *
 * **Every flag here is null when nobody has configured it**, and every consumer
 * treats null as off. These are `operational` settings with no seed and no code
 * default (spec/README.md §2.1) — an unconfigured concert has no portal
 * sections, which is the same answer the allocation engine gives for an
 * unconfigured segment.
 */
export type PortalContext = {
  /** `portal.unlock_mode` — **who** may see unlocked sections, never when (decision 39). */
  unlockMode: PortalUnlockMode | null;
  /**
   * `portal.enabled`. Gates §13.3's sections and **nothing above them**: the
   * status page is served regardless, because a printed QR cannot be recalled
   * when a flag is flipped and turning the portal off must never turn a ticket
   * into a dead link (§13.2).
   */
  enabled: boolean;
  bookletEnabled: boolean;
  feedbackEnabled: boolean;
  /** `portal.feedback_close_at`. Null means the form has no closing date, not that it is shut. */
  feedbackCloseAt: Date | null;
  /** Per-concert Markdown: parking, latecomers, the interval (§13.3 item 5). */
  practicalInfoMd: string | null;
};

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
    id: number;
    name: string;
    startsAt: Date | null;
    doorsOpenAt: Date | null;
    venueName: string | null;
    venueAddress: string | null;
  };
  concertId: number;
  /**
   * **The post-show phase, computed in the database on this read** — never
   * stored, never waited for (decision 40, `lib/portal/phase.ts`). False
   * whenever `shows.ends_at` is null, because nothing is inferred from
   * `starts_at` (decision 41).
   *
   * It is deliberately *not* `shows.status = 'COMPLETED'`. The flag trails the
   * clock by up to a day — it only moves when the daily sweep runs — and a
   * guest opening their link at 11pm on concert night must get the feedback
   * form rather than a page waiting for a cron.
   */
  showIsOver: boolean;
  /** The earliest live scan, when there is one. Drives the checked-in badge. */
  admittedAt: Date | null;
  portal: PortalContext;
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
    show_id: string | number;
    show_name: string;
    starts_at: string | null;
    doors_open_at: string | null;
    venue_name: string | null;
    venue_address: string | null;
    concert_id: string | number;
    concert_name: string;
    timezone: string | null;
    admitted_at: string | null;
    show_is_over: boolean | null;
    unlock_mode: unknown;
    portal_enabled: unknown;
    booklet_enabled: unknown;
    feedback_enabled: unknown;
    feedback_close_at: unknown;
    practical_info_md: string | null;
  }>(sql`
    select
      a.full_name,
      a.ticket_code,
      a.status,
      s.id            as show_id,
      s.name          as show_name,
      s.starts_at,
      s.doors_open_at,
      s.venue_name,
      s.venue_address,
      c.id            as concert_id,
      c.name          as concert_name,
      c.timezone,
      c.practical_info_md,
      ci.scanned_at   as admitted_at,

      -- The post-show phase, off the clock (decision 40). Evaluated here rather
      -- than in TypeScript so that this page and the auto-completion sweep can
      -- never disagree about whether an evening is over.
      ${SHOW_IS_OVER} as show_is_over,

      -- Resolved through the cascade, never off the column (§2.2). A null
      -- shows.portal_unlock_mode does not mean ON_ADMISSION; it means the show
      -- does not override, and the answer is further up.
      resolve_setting('portal.unlock_mode',     null, s.id, c.id) as unlock_mode,
      resolve_setting('portal.enabled',         null, s.id, c.id) as portal_enabled,
      resolve_setting('portal.booklet_enabled', null, s.id, c.id) as booklet_enabled,
      resolve_setting('portal.feedback_enabled', null, s.id, c.id) as feedback_enabled,
      resolve_setting('portal.feedback_close_at', null, s.id, c.id) as feedback_close_at
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
      id: Number(row.show_id),
      name: row.show_name,
      startsAt: row.starts_at ? new Date(row.starts_at) : null,
      doorsOpenAt: row.doors_open_at ? new Date(row.doors_open_at) : null,
      venueName: row.venue_name,
      venueAddress: row.venue_address,
    },
    concertId: Number(row.concert_id),
    showIsOver: row.show_is_over === true,
    admittedAt: row.admitted_at ? new Date(row.admitted_at) : null,
    portal: {
      unlockMode: isUnlockMode(row.unlock_mode) ? row.unlock_mode : null,
      enabled: settingIsTrue(row.portal_enabled),
      bookletEnabled: settingIsTrue(row.booklet_enabled),
      feedbackEnabled: settingIsTrue(row.feedback_enabled),
      feedbackCloseAt: settingAsDate(row.feedback_close_at),
      practicalInfoMd: row.practical_info_md,
    },
  };
}

/**
 * A cascading boolean, read strictly.
 *
 * **Only `true` is true.** Null (nobody set it), a string, a number and a
 * malformed hand-edit are all "off", because every one of these flags opens a
 * section of the portal to whoever holds a token and the failure direction that
 * matters is the one that publishes something early. `resolve_setting` returns
 * `jsonb`, so a value written through the settings screen arrives as a real
 * boolean and anything else did not come from the settings screen.
 */
function settingIsTrue(value: unknown): boolean {
  return value === true;
}

/**
 * A cascading timestamp, read strictly.
 *
 * Stored as an ISO string in jsonb — `portal.feedback_close_at` is a `text`
 * setting in the catalogue, and `concerts.notes_close_at` is the only one of
 * these with a typed column. An unparseable value reads as **no closing date**
 * rather than as a date in the past: a typo must not silently shut a form that
 * attendees have just been emailed a link to.
 */
function settingAsDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The attendee id behind a token, for the routes that serve this holder their
 * own files (§13.3 item 1, item 2).
 *
 * **Deliberately not a field on {@link TicketStatus}.** The page renders on the
 * server and needs no id; putting one in the payload would ship an internal
 * primary key to a surface a stranger can open with a guessed token, for the
 * benefit of nothing. The routes that do need it resolve it here instead.
 *
 * The filters are {@link ticketStatus}'s own — shaped token, live row — so a
 * ticket the page refuses to describe is one no route will serve a file for.
 * A cancelled attendee still resolves: cancellation is a state the holder is
 * told about, and the caller decides whether a cancelled party may still
 * download what they were sent.
 */
export async function attendeeIdForToken(token: string): Promise<number | null> {
  if (!isTokenShaped(token)) return null;

  const rows = await getDb().execute<{ id: string | number }>(sql`
    select a.id
      from attendees a
     where a.qr_token = ${token}
       and a.deleted_at is null
     limit 1
  `);

  const id = rows[0]?.id;
  return id === undefined ? null : Number(id);
}
