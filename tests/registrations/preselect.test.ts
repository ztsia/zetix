import { describe, expect, it } from 'vitest';
import { preselect, type ExtrasRequest } from '@/lib/registrations/preselect';

/**
 * The strict-FCFS preselection walk (spec/allocation.md §7.5).
 *
 * > Preselection is a strict FCFS greedy walk by cumulative seat count — walk in
 * > time order, selecting until the next request would exceed the pool. The
 * > boundary request is granted in part when `allow_partial_grant` is on,
 * > otherwise skipped whole. Strict order, never best-fit: first come first
 * > served means the clock decides, not the packing.
 *
 * These tests are written against that sentence, before the implementation.
 * The one that matters most is `stops at the boundary` — every plausible
 * "improvement" to this function is a best-fit variant, and best-fit is what
 * the spec forbids.
 */

/** A request at minute `n`, wanting `seats`. */
function req(id: number, minute: number, seats: number): ExtrasRequest {
  return {
    registrationId: id,
    requestedAt: new Date(Date.UTC(2026, 8, 1, 0, minute)),
    seats,
  };
}

const granted = (rows: ReturnType<typeof preselect>['rows']) =>
  rows.map((r) => r.granted);

describe('preselect', () => {
  it('grants everyone when the pool covers every request', () => {
    const result = preselect([req(1, 0, 2), req(2, 1, 3)], 10, false);
    expect(granted(result.rows)).toEqual([2, 3]);
    expect(result.selectedSeats).toBe(5);
    expect(result.remaining).toBe(5);
  });

  it('walks in requested_at order regardless of the order given', () => {
    const result = preselect([req(2, 5, 1), req(1, 0, 1), req(3, 9, 1)], 2, false);
    expect(result.rows.map((r) => r.registrationId)).toEqual([1, 2, 3]);
    expect(granted(result.rows)).toEqual([1, 1, 0]);
  });

  it('keeps a running cumulative total, in walk order', () => {
    const result = preselect([req(1, 0, 2), req(2, 1, 3), req(3, 2, 1)], 10, false);
    expect(result.rows.map((r) => r.cumulative)).toEqual([2, 5, 6]);
  });

  /**
   * The core of §7.5. With three seats left and a party of four next, the party
   * of four is skipped whole — **and the walk stops there**. Granting the party
   * of one behind it would be best-fit: it packs the pool tighter by letting a
   * later request overtake an earlier one, which is precisely what "the clock
   * decides, not the packing" rules out.
   */
  it('stops at the boundary rather than packing a later, smaller request in', () => {
    const result = preselect([req(1, 0, 2), req(2, 1, 4), req(3, 2, 1)], 5, false);
    expect(granted(result.rows)).toEqual([2, 0, 0]);
    expect(result.selectedSeats).toBe(2);
    expect(result.boundaryRegistrationId).toBe(2);
  });

  it('grants the boundary request in part when partial grants are allowed', () => {
    const result = preselect([req(1, 0, 2), req(2, 1, 4), req(3, 2, 1)], 5, true);
    expect(granted(result.rows)).toEqual([2, 3, 0]);
    expect(result.selectedSeats).toBe(5);
    expect(result.remaining).toBe(0);
    expect(result.rows[1].partial).toBe(true);
  });

  it('does not mark an exactly-fitting boundary request as partial', () => {
    const result = preselect([req(1, 0, 2), req(2, 1, 3)], 5, true);
    expect(granted(result.rows)).toEqual([2, 3]);
    expect(result.rows.every((r) => !r.partial)).toBe(true);
    expect(result.boundaryRegistrationId).toBeNull();
  });

  it('selects nothing when the pool is empty', () => {
    const result = preselect([req(1, 0, 1)], 0, true);
    expect(granted(result.rows)).toEqual([0]);
    expect(result.selectedSeats).toBe(0);
  });

  /**
   * `extras_pool` is floored at zero by `segment_pool()` (§7.2), but a caller
   * that computed a pool by hand could pass a negative. It must read as "no
   * room", never as capacity.
   */
  it('treats a negative pool as no room', () => {
    const result = preselect([req(1, 0, 1)], -3, true);
    expect(granted(result.rows)).toEqual([0]);
    expect(result.remaining).toBe(0);
  });

  it('breaks a requested_at tie on registration id, so the walk is deterministic', () => {
    const a = { registrationId: 7, requestedAt: new Date(0), seats: 1 };
    const b = { registrationId: 3, requestedAt: new Date(0), seats: 1 };
    expect(preselect([a, b], 1, false).rows.map((r) => r.registrationId)).toEqual([3, 7]);
    expect(preselect([b, a], 1, false).rows.map((r) => r.registrationId)).toEqual([3, 7]);
  });

  it('returns an empty walk for no requests', () => {
    const result = preselect([], 10, false);
    expect(result.rows).toEqual([]);
    expect(result.selectedSeats).toBe(0);
    expect(result.remaining).toBe(10);
  });

  it('does not mutate the array it was given', () => {
    const input = [req(2, 5, 1), req(1, 0, 1)];
    preselect(input, 5, false);
    expect(input.map((r) => r.registrationId)).toEqual([2, 1]);
  });
});
