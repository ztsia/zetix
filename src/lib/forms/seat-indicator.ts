/**
 * How many seats the form admits to having left (spec/v2.md §8.3).
 *
 * **The threshold exists to prevent a stampede, and that decides its
 * direction.** `domain.md` §6 states it plainly — *"Below this the form shows a
 * band, not a number"* — so scarcity is the case that goes vague:
 *
 * | Seats left | Shown |
 * |---|---|
 * | 0 | full |
 * | below `form.seat_indicator_exact_below` | a band — "only a few seats left" |
 * | at or above it | the exact figure |
 *
 * Read the other way round it would be a countdown timer: "3 seats left!" is
 * the oldest urgency device there is, and this concert has free admission and
 * unreserved seating, so there is nothing to be urgent about and nothing to
 * gain from a rush. The one thing a precise small number reliably produces is
 * everybody submitting at once, which is exactly the contention
 * `claim_seats()` then has to settle.
 *
 * **The number is advisory either way.** It is read outside the row lock and
 * cached for a few seconds, so it is a hint about what is likely, never a
 * reservation. `claim_seats()` is the truth and the confirmation screen says
 * what actually happened (§8.3, §8.4).
 */

export type SeatIndicator =
  /** No seats. The form should be showing its full state, not a count. */
  | { state: 'FULL' }
  /**
   * Some seats, deliberately unquantified. Below the threshold, and also
   * whenever the threshold itself is unknown — see {@link seatIndicator}.
   */
  | { state: 'BAND' }
  /** Enough seats that naming the figure cannot start a rush. */
  | { state: 'EXACT'; seats: number };

/**
 * @param seatsLeft `segment_pool().extras_pool` — floored at zero by the
 *   engine, but floored again here because a caller passing `open_seats`
 *   (which is signed, and negative after an admin override) must not produce
 *   "−4 seats left".
 * @param exactBelow `form.seat_indicator_exact_below`, resolved through the
 *   cascade. **Null falls back to the band, never to an exact figure.** A
 *   missing setting is not a licence to invent a threshold (`README.md` §2.1),
 *   and of the two directions to be wrong in, showing less is the one that
 *   cannot cause the behaviour the setting exists to prevent. It is also why
 *   this is not the refusal `limits.ts` makes: a vague indicator is a fine
 *   page, whereas an invented row cap could oversell.
 */
export function seatIndicator(seatsLeft: number, exactBelow: number | null): SeatIndicator {
  const seats = Math.max(0, Math.trunc(seatsLeft));
  if (seats === 0) return { state: 'FULL' };

  if (exactBelow === null || !Number.isFinite(exactBelow)) return { state: 'BAND' };
  if (seats < Math.trunc(exactBelow)) return { state: 'BAND' };

  return { state: 'EXACT', seats };
}

/**
 * The sentence to put on the form.
 *
 * Kept beside the decision rather than in the component so the wording is
 * tested with the rule it implements — the band's whole job is to say "some,
 * not many" without saying how many, and a component that renders
 * `Only ${seats} left` under a `BAND` would defeat the threshold while still
 * passing every test of {@link seatIndicator}.
 */
export function seatIndicatorLabel(indicator: SeatIndicator): string {
  switch (indicator.state) {
    case 'FULL':
      return 'No seats left';
    case 'BAND':
      return 'Only a few seats left';
    case 'EXACT':
      return `${indicator.seats} seat${indicator.seats === 1 ? '' : 's'} left`;
  }
}
