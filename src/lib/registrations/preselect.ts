/**
 * The strict-FCFS preselection walk (spec/allocation.md §7.5).
 *
 * > Preselection is a strict FCFS greedy walk by cumulative seat count — walk
 * > in time order, selecting until the next request would exceed the pool. The
 * > boundary request is granted in part when `allow_partial_grant` is on,
 * > otherwise skipped whole. Strict order, never best-fit: first come first
 * > served means the clock decides, not the packing.
 *
 * Pure, and deliberately so: it decides a *recommendation*, and the admin then
 * edits it freely (§7.5). Nothing here writes a seat — `promoteAttendees()` and
 * `claim_seats()` do that, under the show lock, against figures re-read at
 * commit time. So this function never needs to be right about capacity; it
 * needs to be right about **order**.
 *
 * No module of this file imports the database, which is why the walk is
 * testable against the §7.5 sentence directly.
 */

export type ExtrasRequest = {
  registrationId: number;
  /**
   * The FCFS ordering key: form submission time, or the Google Form response
   * timestamp for an import. **Never `created_at`** — an import run a week later
   * must preserve the order people actually asked in (§7.4).
   */
  requestedAt: Date;
  /** Seats still awaiting review in this registration. */
  seats: number;
};

export type PreselectedRow = ExtrasRequest & {
  /** Seats selected for this request. Zero once the walk has stopped. */
  granted: number;
  /** Cumulative seats *requested* up to and including this row (§7.5's column). */
  cumulative: number;
  /** True only for a boundary request granted in part. */
  partial: boolean;
};

export type Preselection = {
  /** Every request, in walk order — not only the selected ones. */
  rows: PreselectedRow[];
  selectedSeats: number;
  /** Pool left over. Never negative: preselection alone cannot overspend. */
  remaining: number;
  /**
   * The request the walk stopped at, if it stopped short.
   *
   * The screen uses it to say *why* everything below the line is unselected —
   * "a party of 4 does not fit the 3 remaining seats" — which is the difference
   * between a list that looks arbitrary and one that explains itself.
   */
  boundaryRegistrationId: number | null;
};

/**
 * Walk `requests` in time order and select while they fit.
 *
 * **The walk stops at the first request that does not fit.** It does not
 * continue looking for a smaller one further down: doing so would let a later
 * request overtake an earlier one purely because it packs better, which is the
 * best-fit behaviour §7.5 rules out in the same breath that it defines this.
 * With `allowPartial` the boundary request takes what is left, so the pool is
 * empty and everything after it is unselected anyway — both branches end at the
 * same row, for the same reason.
 */
export function preselect(
  requests: readonly ExtrasRequest[],
  pool: number,
  allowPartial: boolean,
): Preselection {
  // A negative pool is what `segment_pool()` floors away (§7.2); floor it here
  // too, so a hand-computed one reads as "no room" rather than as capacity.
  let remaining = Math.max(0, pool);

  /**
   * Ties broken on id so two requests sharing a timestamp always walk in the
   * same order. Imports stamp `requested_at` from the spreadsheet and a Google
   * Form export truncates to the second, so ties are ordinary — and a walk that
   * reordered them between two renders would move the line under the admin
   * mid-decision.
   */
  const ordered = [...requests].sort(
    (a, b) =>
      a.requestedAt.getTime() - b.requestedAt.getTime() ||
      a.registrationId - b.registrationId,
  );

  let cumulative = 0;
  let stopped = false;
  let boundaryRegistrationId: number | null = null;
  let selectedSeats = 0;

  const rows = ordered.map((request) => {
    cumulative += request.seats;

    if (stopped) {
      return { ...request, granted: 0, cumulative, partial: false };
    }

    if (request.seats <= remaining) {
      remaining -= request.seats;
      selectedSeats += request.seats;
      return { ...request, granted: request.seats, cumulative, partial: false };
    }

    // The boundary. Either it takes what is left, or it is skipped whole —
    // and either way the walk ends here.
    stopped = true;
    boundaryRegistrationId = request.registrationId;

    if (allowPartial && remaining > 0) {
      const granted = remaining;
      remaining = 0;
      selectedSeats += granted;
      return { ...request, granted, cumulative, partial: true };
    }

    return { ...request, granted: 0, cumulative, partial: false };
  });

  return { rows, selectedSeats, remaining, boundaryRegistrationId };
}
