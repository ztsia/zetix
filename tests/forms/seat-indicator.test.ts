/**
 * The seat indicator's one rule (spec/v2.md §8.3, `domain.md` §6).
 *
 * The direction is the whole test. `form.seat_indicator_exact_below` reads like
 * "show the exact figure below this", and the admin catalogue described it that
 * way until this module was written; the spec says the opposite, twice, and
 * gives the reason — the band exists to avoid a stampede, so **scarcity is what
 * goes vague**. Reversed, the form becomes a countdown timer for a free concert
 * with unreserved seating.
 */

import { describe, expect, it } from 'vitest';
import { seatIndicator, seatIndicatorLabel } from '@/lib/forms/seat-indicator';

const THRESHOLD = 20;

describe('seatIndicator', () => {
  it('is full at zero, whatever the threshold', () => {
    expect(seatIndicator(0, THRESHOLD)).toEqual({ state: 'FULL' });
    expect(seatIndicator(0, null)).toEqual({ state: 'FULL' });
  });

  describe('below the threshold it shows a band, never a number', () => {
    it.each([1, 2, 3, 10, 19])('bands %d seats', (seats) => {
      expect(seatIndicator(seats, THRESHOLD)).toEqual({ state: 'BAND' });
    });

    /**
     * The reversal test. If the comparison flips, this is the case that catches
     * it: three seats left is exactly the number that starts a rush, and it
     * must never reach the page.
     */
    it('never names a small number — the stampede case', () => {
      const indicator = seatIndicator(3, THRESHOLD);
      expect(indicator.state).toBe('BAND');
      expect(seatIndicatorLabel(indicator)).not.toContain('3');
    });
  });

  describe('at or above the threshold it shows the figure', () => {
    it.each([20, 21, 50, 347])('names %d seats', (seats) => {
      expect(seatIndicator(seats, THRESHOLD)).toEqual({ state: 'EXACT', seats });
    });

    it('is inclusive at the boundary — "below" means below', () => {
      expect(seatIndicator(THRESHOLD, THRESHOLD)).toEqual({ state: 'EXACT', seats: 20 });
      expect(seatIndicator(THRESHOLD - 1, THRESHOLD)).toEqual({ state: 'BAND' });
    });
  });

  /**
   * A missing setting is not a licence to invent a threshold (`README.md`
   * §2.1). Of the two ways to be wrong, showing less cannot cause the behaviour
   * the setting exists to prevent.
   */
  describe('an unresolved threshold falls back to the band', () => {
    it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('bands when the threshold is %s', (bad) => {
      expect(seatIndicator(5, bad as number | null)).toEqual({ state: 'BAND' });
      expect(seatIndicator(500, bad as number | null)).toEqual({ state: 'BAND' });
    });

    it('never leaks an exact count because a setting is missing', () => {
      const indicator = seatIndicator(347, null);
      expect(indicator.state).toBe('BAND');
      expect(seatIndicatorLabel(indicator)).not.toContain('347');
    });
  });

  /**
   * `open_seats` is signed and goes negative after an admin override (§7.2).
   * The pool floors it; this floors it again rather than trusting every caller
   * to pass the right one of the two numbers.
   */
  it('floors a negative count instead of rendering it', () => {
    expect(seatIndicator(-4, THRESHOLD)).toEqual({ state: 'FULL' });
  });

  it('truncates a fractional count', () => {
    expect(seatIndicator(19.9, THRESHOLD)).toEqual({ state: 'BAND' });
    expect(seatIndicator(20.9, THRESHOLD)).toEqual({ state: 'EXACT', seats: 20 });
  });

  /** A threshold of zero means "never band" — every non-zero count is exact. */
  it('names every count when the threshold is zero', () => {
    expect(seatIndicator(1, 0)).toEqual({ state: 'EXACT', seats: 1 });
  });
});

describe('seatIndicatorLabel', () => {
  it('says nothing quantitative for a band', () => {
    expect(seatIndicatorLabel({ state: 'BAND' })).toBe('Only a few seats left');
    expect(seatIndicatorLabel({ state: 'BAND' })).not.toMatch(/\d/);
  });

  it('reports full without a number', () => {
    expect(seatIndicatorLabel({ state: 'FULL' })).toBe('No seats left');
  });

  it('singularises one seat', () => {
    expect(seatIndicatorLabel({ state: 'EXACT', seats: 1 })).toBe('1 seat left');
    expect(seatIndicatorLabel({ state: 'EXACT', seats: 2 })).toBe('2 seats left');
  });
});
