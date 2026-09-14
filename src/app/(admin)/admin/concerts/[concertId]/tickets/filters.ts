import { and, eq, ilike, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import { attendees, registrations } from '@/db/schema/registrations';
import { shows } from '@/db/schema/shows';

/**
 * What narrows the tickets screen (spec/tickets.md §10.5).
 *
 * **One builder, two callers.** The page renders a filtered count and a page of
 * rows; "select everything that matches" turns the same filters into a list of
 * ids for the mutation to act on. A second spelling of this predicate is how the
 * banner comes to promise 244 tickets and the action touches a different 244 —
 * the same class of silent drift `scope.ts` was extracted to end.
 */

/**
 * Deliberately overlapping rather than mutually exclusive: a ticket that was
 * sent and has since been flagged is both `sent` and `needs_reissue`. Each term
 * answers one question on its own, which is what an operator picking from a
 * dropdown expects — the badge column's precedence order is a display concern
 * and does not belong in a filter.
 */
export const TICKET_STATES = ['not_issued', 'issued', 'sent', 'needs_reissue'] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const TICKET_STATE_LABELS: Record<TicketState, string> = {
  not_issued: 'Not issued',
  issued: 'Issued, not sent',
  sent: 'Sent',
  needs_reissue: 'Needs reissue',
};

export const BOOKING_STATUSES = [
  'CONFIRMED',
  'PENDING_REVIEW',
  'WAITLIST',
  'CANCELLED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type TicketFilters = {
  showId: number | null;
  segmentId: number | null;
  status: BookingStatus | null;
  ticketState: TicketState | null;
  search: string;
};

export type TicketQuery = {
  show?: string;
  segment?: string;
  status?: string;
  ticket?: string;
  q?: string;
};

export function parseTicketFilters(query: TicketQuery): TicketFilters {
  const positive = (raw: string | undefined) => {
    const value = Number(raw ?? 0) || 0;
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  return {
    showId: positive(query.show),
    segmentId: positive(query.segment),
    status: BOOKING_STATUSES.includes(query.status as BookingStatus)
      ? (query.status as BookingStatus)
      : null,
    ticketState: TICKET_STATES.includes(query.ticket as TicketState)
      ? (query.ticket as TicketState)
      : null,
    search: (query.q ?? '').trim(),
  };
}

/**
 * Renderable: a token **and** a pinned template version. Either one alone is a
 * half-issued row that `/api/tickets/{id}/pdf` cannot draw, so the screen must
 * not call it issued (§10.5).
 */
const issued = () =>
  and(isNotNull(attendees.qrToken), isNotNull(attendees.ticketTemplateVersion))!;

/** Requires `attendees`, `registrations` and `shows` to all be in the query. */
export function ticketWhere(concertId: number, filters: TicketFilters): SQL {
  const clauses: SQL[] = [
    eq(shows.concertId, concertId),
    isNull(attendees.deletedAt),
    isNull(registrations.deletedAt),
  ];

  if (filters.showId) clauses.push(eq(attendees.showId, filters.showId));
  if (filters.segmentId) clauses.push(eq(attendees.segmentId, filters.segmentId));
  if (filters.status) clauses.push(eq(attendees.status, filters.status));

  switch (filters.ticketState) {
    case 'not_issued':
      clauses.push(
        or(isNull(attendees.qrToken), isNull(attendees.ticketTemplateVersion))!,
      );
      break;
    case 'issued':
      clauses.push(and(issued(), isNull(attendees.ticketSentAt))!);
      break;
    case 'sent':
      clauses.push(isNotNull(attendees.ticketSentAt));
      break;
    case 'needs_reissue':
      clauses.push(eq(attendees.needsReissue, true));
      break;
    default:
      break;
  }

  if (filters.search) {
    const like = `%${filters.search}%`;
    clauses.push(
      or(
        ilike(attendees.fullName, like),
        ilike(attendees.ticketCode, like),
        ilike(registrations.contactName, like),
      )!,
    );
  }

  return and(...clauses)!;
}

/** The filters as a query string, so every link and `router.replace` agrees. */
export function ticketSearchParams(
  filters: TicketFilters,
  extra: { page?: number; size?: number; sort?: string; dir?: string } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (extra.page && extra.page > 0) params.set('page', String(extra.page));
  if (extra.size && extra.size !== 25) params.set('size', String(extra.size));
  if (extra.sort) params.set('sort', extra.sort);
  if (extra.dir) params.set('dir', extra.dir);
  if (filters.search) params.set('q', filters.search);
  if (filters.showId) params.set('show', String(filters.showId));
  if (filters.segmentId) params.set('segment', String(filters.segmentId));
  if (filters.status) params.set('status', filters.status);
  if (filters.ticketState) params.set('ticket', filters.ticketState);
  return params;
}
