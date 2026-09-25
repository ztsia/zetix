import { z } from 'zod';

/**
 * The Audience workspace's one filter model (spec/v3.md §22.1, §22.2).
 *
 * **Both grains share it.** A view — "Needs tickets", "Bounced" — selects
 * *parties*; the Seats grain shows the seats of exactly those parties. So a
 * queue means the same thing whichever way the admin is looking at it, and a
 * command handed `{ filter, excludedIds }` from either grain resolves the same
 * parties on the server (§22.3).
 *
 * Pure and client-safe: the page parses the URL with it, the table writes the
 * URL with it, and the commands validate their filter with the same schema.
 */

export const STAGES = [
  'NEEDS_REVIEW',
  'UNVERIFIED',
  'NEEDS_TICKETS',
  'READY_TO_SEND',
  'SENT',
  'ADMITTED',
  'WAITLISTED',
  'CANCELLED',
] as const;
export type Stage = (typeof STAGES)[number];

export const FLAGS = [
  'BOUNCED',
  'SEND_FAILED',
  'SUSPICIOUS_ADDRESS',
  'CHANGED_AFTER_SEND',
  'POSSIBLE_DUPLICATE',
  'UNNAMED_GUESTS',
  'REPLY_WAITING',
  'OVER_CAPACITY',
] as const;
export type Flag = (typeof FLAGS)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  NEEDS_REVIEW: 'Needs review',
  UNVERIFIED: 'Unverified',
  NEEDS_TICKETS: 'Needs tickets',
  READY_TO_SEND: 'Ready to send',
  SENT: 'Sent',
  ADMITTED: 'Admitted',
  WAITLISTED: 'Waitlisted',
  CANCELLED: 'Cancelled',
};

/** The view's name, which is the problem in the admin's words (§22.2). */
export const FLAG_LABEL: Record<Flag, string> = {
  BOUNCED: 'Bounced',
  SEND_FAILED: 'Send failed',
  SUSPICIOUS_ADDRESS: 'Suspicious address',
  CHANGED_AFTER_SEND: 'Changed after send',
  POSSIBLE_DUPLICATE: 'Possible duplicates',
  UNNAMED_GUESTS: 'Unnamed guests',
  REPLY_WAITING: 'Replies',
  OVER_CAPACITY: 'Over capacity',
};

/** What the stage asks for next (§21.1), for the record's primary button and the table's hint. */
export const STAGE_NEXT: Record<Stage, string | null> = {
  NEEDS_REVIEW: 'Approve, or grant or decline the extras',
  UNVERIFIED: 'Remind, or release',
  NEEDS_TICKETS: 'Send tickets',
  READY_TO_SEND: 'Send tickets',
  SENT: null,
  ADMITTED: null,
  WAITLISTED: 'Promote when seats free up',
  CANCELLED: null,
};

/** The flag column `party_pipeline` carries for each flag (`0200`). */
export const FLAG_COLUMN: Record<Flag, string> = {
  BOUNCED: 'flag_bounced',
  SEND_FAILED: 'flag_send_failed',
  SUSPICIOUS_ADDRESS: 'flag_suspicious_address',
  CHANGED_AFTER_SEND: 'flag_changed_after_send',
  POSSIBLE_DUPLICATE: 'flag_possible_duplicate',
  UNNAMED_GUESTS: 'flag_unnamed_guests',
  REPLY_WAITING: 'flag_reply_waiting',
  OVER_CAPACITY: 'flag_over_capacity',
};

/** A view in the URL: the stage or flag, kebab-cased. `needs-review`, `bounced`. */
export type ViewId = string;

export type View =
  | { id: ViewId; kind: 'stage'; value: Stage; label: string }
  | { id: ViewId; kind: 'flag'; value: Flag; label: string };

const kebab = (value: string) => value.toLowerCase().replace(/_/g, '-');

/** Every built-in view, stages in pipeline order, then flags (§22.2). */
export const VIEWS: View[] = [
  ...STAGES.map((value) => ({ id: kebab(value), kind: 'stage' as const, value, label: STAGE_LABEL[value] })),
  ...FLAGS.map((value) => ({ id: kebab(value), kind: 'flag' as const, value, label: FLAG_LABEL[value] })),
];

export function findView(id: string | null | undefined): View | null {
  return VIEWS.find((view) => view.id === id) ?? null;
}

export const SEAT_STATUSES = ['CONFIRMED', 'PENDING_REVIEW', 'WAITLIST', 'CANCELLED'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

/** Where a seat's ticket is, as the Seats grain filters it. */
export const TICKET_STATES = ['none', 'issued', 'delivered', 'needs-reissue'] as const;
export type TicketState = (typeof TICKET_STATES)[number];

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * The filter a command receives with "select all N matching" (§22.3), and what
 * the page queries with. Everything is optional: an empty filter is every live
 * party in the concert. The concert itself is never part of it — the command
 * context carries that, so a filter cannot name another concert's rows.
 *
 * `seatStatus` and `ticket` refine only the Seats grain. At the party grain
 * they are ignored, and the table hides them.
 */
export const audienceFilterSchema = z
  .object({
    // Only a built-in view: an unknown one would otherwise match nothing in
    // particular — the whole concert — and a command would run on all of it.
    view: z
      .string()
      .max(40)
      .refine((value) => findView(value) !== null, 'Unknown view.')
      .optional(),
    search: z.string().max(200).optional(),
    showId: id.optional(),
    segmentId: id.optional(),
    playerId: id.optional(),
    source: z.enum(['FORM', 'IMPORT', 'ADMIN']).optional(),
    seatStatus: z.enum(SEAT_STATUSES).optional(),
    ticket: z.enum(TICKET_STATES).optional(),
  })
  .strict();
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;

export type Grain = 'parties' | 'seats';

/** The screen's own URL keys, beside the table's page, size, sort and `q`. */
export const AUDIENCE_URL_KEYS = [
  'grain',
  'view',
  'show',
  'segment',
  'player',
  'source',
  'status',
  'ticket',
] as const;

const positive = (value: string | undefined) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/**
 * The filter a page's URL describes. Anything malformed is dropped rather than
 * failing the page — a hand-edited link should degrade, not 500.
 */
export function filterFromUrl(extra: Record<string, string>, search: string): AudienceFilter {
  const filter: AudienceFilter = {};
  if (findView(extra.view)) filter.view = extra.view;
  if (search.trim()) filter.search = search.trim();
  const showId = positive(extra.show);
  if (showId) filter.showId = showId;
  const segmentId = positive(extra.segment);
  if (segmentId) filter.segmentId = segmentId;
  const playerId = positive(extra.player);
  if (playerId) filter.playerId = playerId;
  if (extra.source === 'FORM' || extra.source === 'IMPORT' || extra.source === 'ADMIN') {
    filter.source = extra.source;
  }
  if ((SEAT_STATUSES as readonly string[]).includes(extra.status)) {
    filter.seatStatus = extra.status as SeatStatus;
  }
  if ((TICKET_STATES as readonly string[]).includes(extra.ticket)) {
    filter.ticket = extra.ticket as TicketState;
  }
  return filter;
}

export function grainFromUrl(extra: Record<string, string>): Grain {
  return extra.grain === 'seats' ? 'seats' : 'parties';
}

/** A party-grain filter: the seat refinements removed. */
export function partyFilter(filter: AudienceFilter): AudienceFilter {
  const rest = { ...filter };
  delete rest.seatStatus;
  delete rest.ticket;
  return rest;
}
