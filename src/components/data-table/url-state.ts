import type { SortingState } from '@tanstack/react-table';

/**
 * A server-paged table's state, held in the URL (spec/v3.md §22.2).
 *
 * A view is a named filter "encoded in the URL so it can be linked": the page
 * a colleague opens from a pasted link must show what the sender saw. So page,
 * size, sort, search and every screen-specific filter live in the query
 * string, the Server Component page reads them from `searchParams` and queries
 * with them, and the client only ever *writes* the URL (`useUrlTableState`).
 * Nothing is kept in component state that the URL does not also say.
 *
 * Pure functions, so the server page and the client hook share one encoding.
 */

export type UrlTableState = {
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
  search: string;
  /** Screen-specific keys — a view, a kind, a status filter. */
  extra: Record<string, string>;
};

/**
 * Page sizes offered by the pagination control. UI, not an operational value:
 * it limits a render, not a capacity, quota, deadline, cap, batch or rate.
 */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

type RawParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/**
 * Reads the table state from a page's `searchParams`. Anything malformed falls
 * back to the default rather than failing the page: a hand-edited link should
 * degrade, not 500. `extraKeys` lists the screen's own keys to keep.
 */
export function parseTableState(
  params: RawParams,
  options: { extraKeys?: readonly string[]; defaultSort?: SortingState } = {},
): UrlTableState {
  const page = Number(first(params.page));
  const size = Number(first(params.size));
  const sortParam = first(params.sort);
  const sorting: SortingState = sortParam
    ? sortParam
        .split(',')
        .map((part) => part.trim())
        .filter((part) => /^-?[A-Za-z0-9_]+$/.test(part))
        .map((part) => ({ id: part.replace(/^-/, ''), desc: part.startsWith('-') }))
    : (options.defaultSort ?? []);

  const extra: Record<string, string> = {};
  for (const key of options.extraKeys ?? []) {
    const value = first(params[key]);
    if (value) extra[key] = value;
  }

  return {
    pageIndex: Number.isInteger(page) && page > 1 ? page - 1 : 0,
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
    sorting,
    search: (first(params.q) ?? '').slice(0, 200),
    extra,
  };
}

/** The query string for a state. Defaults are omitted so links stay short. */
export function tableStateToQuery(state: UrlTableState): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.extra)) if (value) params.set(key, value);
  if (state.search) params.set('q', state.search);
  if (state.sorting.length > 0) {
    params.set('sort', state.sorting.map((s) => (s.desc ? '-' : '') + s.id).join(','));
  }
  if (state.pageIndex > 0) params.set('page', String(state.pageIndex + 1));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set('size', String(state.pageSize));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** A stable key for "the filter", for `useTableSelection`: everything but paging and sort. */
export function filterKeyOf(state: UrlTableState): string {
  return JSON.stringify([state.search, Object.entries(state.extra).sort()]);
}
