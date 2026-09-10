import type { SortingState } from '@tanstack/react-table';

/**
 * The dashboard's URL state (spec/checkin.md §12.4).
 *
 * Extracted from the component so it can be tested. The rule it encodes has a
 * failure mode that renders perfectly and is wrong — paging that silently snaps
 * back to page one — which is exactly the kind a screenshot does not catch and a
 * unit test does.
 *
 * State lives in the URL rather than React state so that a narrowed view of the
 * scan log is a link somebody can send across the foyer.
 */
export type DashboardState = {
  showId: number;
  /** The concert's first show, whose id is omitted from the query as the default. */
  defaultShowId: number;
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
  search: string;
  includeReverted: boolean;
};

export type DashboardChange = {
  show?: number;
  pageIndex?: number;
  pageSize?: number;
  sorting?: SortingState;
  search?: string;
  includeReverted?: boolean;
};

export const DEFAULT_PAGE_SIZE = 25;

/**
 * Which show the dashboard opens on when the URL does not say.
 *
 * **The one happening now, not the earliest.** A concert with a matinee and an
 * evening show spends the evening's arrivals with the matinee already over, and
 * opening on a finished door shows a full house and an empty queue — which
 * reads as "everyone is in" rather than "wrong show". The admin would have to
 * notice and switch every time, at the moment they have least attention to
 * spare.
 *
 * "Now" is the show that has most recently started, falling back to the next one
 * still to come, and finally to the first — so before any doors open it behaves
 * exactly as it used to, and a show with no start time never wins.
 */
export function nearestShowId(
  shows: { id: number; startsAt: string | null }[],
  now: Date = new Date(),
): number {
  const first = shows[0];
  if (!first) throw new Error('nearestShowId needs at least one show.');

  const dated = shows
    .filter((show): show is { id: number; startsAt: string } => show.startsAt !== null)
    .map((show) => ({ id: show.id, at: new Date(show.startsAt).getTime() }))
    .filter((show) => Number.isFinite(show.at))
    .sort((a, b) => a.at - b.at);

  if (dated.length === 0) return first.id;

  const at = now.getTime();
  const started = dated.filter((show) => show.at <= at);
  if (started.length > 0) return started[started.length - 1]!.id;

  return dated[0]!.id;
}

export function buildDashboardQuery(
  current: DashboardState,
  next: DashboardChange,
): string {
  const params = new URLSearchParams();

  const show = next.show ?? current.showId;
  if (show !== current.defaultShowId) params.set('show', String(show));

  /**
   * Compared by **value**, not by presence.
   *
   * `DataTable`'s server mode reports all four of its fields on every change, so
   * a presence test (`next.search !== undefined`) is true even when the operator
   * only clicked "next page" — and paging would reset to the first page every
   * time. Narrowing the result set is what invalidates the page number; paging
   * through it is not.
   */
  const resets =
    (next.show !== undefined && next.show !== current.showId) ||
    (next.search !== undefined && next.search !== current.search) ||
    (next.includeReverted !== undefined &&
      next.includeReverted !== current.includeReverted);

  const page = resets ? 0 : (next.pageIndex ?? current.pageIndex);
  if (page > 0) params.set('page', String(page));

  const size = next.pageSize ?? current.pageSize;
  if (size !== DEFAULT_PAGE_SIZE) params.set('size', String(size));

  const sorting = next.sorting ?? current.sorting;
  if (sorting[0]) {
    params.set('sort', sorting[0].id);
    if (sorting[0].desc) params.set('dir', 'desc');
  }

  const search = next.search ?? current.search;
  if (search) params.set('q', search);

  const includeReverted = next.includeReverted ?? current.includeReverted;
  if (includeReverted) params.set('reverted', '1');

  return params.toString();
}
