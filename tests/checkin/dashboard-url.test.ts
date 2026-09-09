import { describe, expect, it } from 'vitest';
import {
  buildDashboardQuery,
  nearestShowId,
  type DashboardState,
} from '@/app/(admin)/admin/concerts/[concertId]/checkin/dashboard-url';

/**
 * The dashboard's URL state (spec/checkin.md §12.4).
 *
 * Worth its own file because the interesting failure renders perfectly. Every
 * one of these produces a page that looks right; the question is only whether it
 * is showing what the operator asked for.
 */
const base: DashboardState = {
  showId: 1,
  defaultShowId: 1,
  pageIndex: 0,
  pageSize: 25,
  sorting: [],
  search: '',
  includeReverted: false,
};

describe('buildDashboardQuery', () => {
  it('is empty when nothing differs from the defaults', () => {
    expect(buildDashboardQuery(base, {})).toBe('');
  });

  it('omits the concert’s first show, and names any other', () => {
    expect(buildDashboardQuery(base, { show: 1 })).toBe('');
    expect(buildDashboardQuery(base, { show: 2 })).toBe('show=2');
  });

  it('keeps the page when only the page changes', () => {
    // The regression this file exists for. `DataTable`'s server mode reports all
    // four of its fields on every change, so a presence test rather than a value
    // test would reset to page one on every click of "next page" — a table that
    // silently refuses to page, on the screen used to run a door.
    const next = { pageIndex: 3, pageSize: 25, sorting: [], search: '' };
    expect(buildDashboardQuery(base, next)).toBe('page=3');
  });

  it('keeps the page while paging a searched, filtered log', () => {
    const state: DashboardState = {
      ...base,
      search: 'alice',
      includeReverted: true,
      pageIndex: 2,
    };
    const next = { pageIndex: 3, pageSize: 25, sorting: [], search: 'alice' };
    const query = buildDashboardQuery(state, next);
    expect(query).toContain('page=3');
    expect(query).toContain('q=alice');
    expect(query).toContain('reverted=1');
  });

  it('resets to the first page when the search changes', () => {
    // Page 4 of a narrower result set is a page that may not exist.
    const state = { ...base, pageIndex: 4 };
    const query = buildDashboardQuery(state, {
      pageIndex: 4,
      pageSize: 25,
      sorting: [],
      search: 'wei',
    });
    expect(query).toBe('q=wei');
  });

  it('resets to the first page when the show changes', () => {
    const state = { ...base, pageIndex: 4 };
    expect(buildDashboardQuery(state, { show: 2 })).toBe('show=2');
  });

  it('resets to the first page when reverted rows are shown or hidden', () => {
    const state = { ...base, pageIndex: 4 };
    expect(buildDashboardQuery(state, { includeReverted: true })).toBe('reverted=1');

    const shown = { ...base, pageIndex: 4, includeReverted: true };
    expect(buildDashboardQuery(shown, { includeReverted: false })).toBe('');
  });

  it('carries sort direction, and omits the default ascending', () => {
    expect(buildDashboardQuery(base, { sorting: [{ id: 'attendeeName', desc: false }] })).toBe(
      'sort=attendeeName',
    );
    expect(buildDashboardQuery(base, { sorting: [{ id: 'scannedAt', desc: true }] })).toBe(
      'sort=scannedAt&dir=desc',
    );
  });

  it('omits the default page size and keeps any other', () => {
    expect(buildDashboardQuery(base, { pageSize: 25 })).toBe('');
    expect(buildDashboardQuery(base, { pageSize: 100 })).toBe('size=100');
  });

  it('clears the search when it is emptied', () => {
    // `''` is a value, not an absence: `?? current.search` would restore the
    // text the operator just deleted.
    const state = { ...base, search: 'alice', pageIndex: 2 };
    expect(buildDashboardQuery(state, { search: '' })).toBe('');
  });
});

describe('nearestShowId', () => {
  const shows = [
    { id: 1, startsAt: '2026-09-19T06:00:00Z' }, // matinee
    { id: 2, startsAt: '2026-09-19T11:00:00Z' }, // evening
  ];

  it('opens on the matinee while the matinee is running', () => {
    expect(nearestShowId(shows, new Date('2026-09-19T06:30:00Z'))).toBe(1);
  });

  it('opens on the evening once the evening has started', () => {
    // The regression: opening on the earliest show puts the desk in front of a
    // finished door — full house, empty queue — which reads as "everyone is in"
    // rather than "wrong show".
    expect(nearestShowId(shows, new Date('2026-09-19T11:30:00Z'))).toBe(2);
  });

  it('opens on the first show before any doors have opened', () => {
    expect(nearestShowId(shows, new Date('2026-09-18T09:00:00Z'))).toBe(1);
  });

  it('falls back to the first show when none carries a start time', () => {
    expect(nearestShowId([{ id: 7, startsAt: null }, { id: 8, startsAt: null }])).toBe(7);
  });

  it('ignores an undated show rather than letting it win', () => {
    const mixed = [
      { id: 5, startsAt: null },
      { id: 6, startsAt: '2026-09-19T06:00:00Z' },
    ];
    expect(nearestShowId(mixed, new Date('2026-09-19T07:00:00Z'))).toBe(6);
  });

  it('refuses an empty list rather than inventing an id', () => {
    expect(() => nearestShowId([])).toThrow();
  });
});
