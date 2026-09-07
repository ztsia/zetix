import { sql } from 'drizzle-orm';

/**
 * Which attendees a ticket operation touches.
 *
 * Extracted because `mint.ts` and `issue.ts` had a copy each — about twenty-five
 * near-identical lines including the empty-list guard below. Two copies of a
 * filter that decides who gets a ticket is how one of them later drifts, and the
 * drift is silent: both still compile, both still return rows, and only one is
 * right.
 */

export type TicketScope = {
  showId?: number;
  segmentId?: number;
  attendeeIds?: number[];
};

/**
 * `a` is `attendees`, `r` is `registrations` — both must be in the query.
 *
 * `require: false` is for a caller that already constrains the rows some other
 * way — `showsInScope()` filters by concert, so "no show, segment or attendee"
 * genuinely means "the whole concert" there rather than "the whole database".
 * Every other caller leaves it on.
 */
export function scopeFilter(scope: TicketScope, { require = true } = {}) {
  const clauses = [];
  if (scope.showId !== undefined) clauses.push(sql`a.show_id = ${scope.showId}`);
  if (scope.segmentId !== undefined) clauses.push(sql`a.segment_id = ${scope.segmentId}`);
  if (scope.attendeeIds !== undefined) {
    /**
     * An empty list matches **nothing**, not everything.
     *
     * `in ()` is a syntax error in Postgres, so the tempting shortcut is to drop
     * the clause when the list is empty — which turns "issue tickets for the
     * rows I ticked" into "issue tickets for every attendee in scope" at the
     * moment the operator ticked none.
     */
    clauses.push(
      scope.attendeeIds.length === 0 ? sql`false` : sql`a.id in ${idList(scope.attendeeIds)}`,
    );
  }
  if (clauses.length === 0) {
    // No scope at all would reach every concert in the database. That is never
    // what a caller means, and the failure is silent and wide.
    if (require) {
      throw new Error('A ticket operation needs a scope: showId, segmentId or attendeeIds.');
    }
    return sql`true`;
  }
  return sql.join(clauses, sql` and `);
}

/**
 * Who may hold a ticket.
 *
 * `CONFIRMED` only, and neither the attendee nor its registration soft-deleted.
 * A `WAITLIST` or `PENDING_REVIEW` row has no seat yet (spec/allocation.md
 * §7.5), and a scannable ticket for an ungranted seat is worse than no ticket.
 *
 * A **cancelled registration keeps** whatever it was already issued — nothing
 * here clears a token, and `ticket_sent_at` survives cancellation on purpose so
 * the door can say "cancelled — refer to desk" rather than "not found"
 * (spec/allocation.md §7.9). It simply stops being given anything new.
 */
export function ticketable() {
  return sql`
    a.status = 'CONFIRMED'
    and a.deleted_at is null
    and r.deleted_at is null
    and r.status <> 'CANCELLED'
  `;
}

export function idList(ids: number[]) {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}
