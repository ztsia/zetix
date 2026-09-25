'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { DataTableServerMode } from './data-table';
import { tableStateToQuery, type UrlTableState } from './url-state';

/**
 * Wires a server-paged `DataTable` to the URL (`url-state.ts`).
 *
 * The page passes the state it parsed from `searchParams`; every change is a
 * `router.replace` to the new query string, and the Server Component renders
 * the new page. `replace` rather than `push`, so paging through a table does
 * not fill the back button with every page visited. `isPending` covers the
 * round trip, for the table's loading state.
 */
export function useUrlTableState(state: UrlTableState, rowCount: number) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = React.useTransition();

  const navigate = React.useCallback(
    (next: UrlTableState) => {
      startTransition(() => {
        router.replace(`${pathname}${tableStateToQuery(next)}`, { scroll: false });
      });
    },
    [router, pathname],
  );

  const server: DataTableServerMode = {
    rowCount,
    pageIndex: state.pageIndex,
    pageSize: state.pageSize,
    sorting: state.sorting,
    search: state.search,
    onChange: (next) => navigate({ ...state, ...next }),
  };

  /** Set a screen-specific key; a changed filter starts again at page one. */
  const setExtra = (key: string, value: string | null) => {
    const extra = { ...state.extra };
    if (value) extra[key] = value;
    else delete extra[key];
    navigate({ ...state, extra, pageIndex: 0 });
  };

  return { server, setExtra, navigate, isPending };
}
