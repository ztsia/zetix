'use client';

import * as React from 'react';
import {
  useTable,
  type Row,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import { Search, TableProperties } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  dataTableFeatures,
  type DataTableColumn,
  type DataTableFeatures,
} from './features';
import { DataTablePagination } from './pagination';
import { DataTableViewOptions } from './view-options';
import { DataTableExportMenu, type DataTableExport } from './export-menu';

/**
 * The one shared table (spec/surfaces.md §15.1, spec/modules.md §4).
 *
 * Registrations, attendees, players, notes, outbox and the scan log all render
 * through this component. **Nobody forks it.** If a screen needs something this
 * cannot do, extend it here in a small PR — six divergent copies is the specific
 * failure the module split exists to prevent.
 *
 * Built on TanStack Table v9, whose features are composed statically in
 * `features.ts` rather than passed per instance.
 *
 * What a consumer gets without asking: sorting, per-column filtering, a global
 * search box, column visibility, pagination, optional row selection, CSV/XLSX
 * export of the current view, a loading skeleton, and an empty state. What a
 * consumer supplies: columns, rows, and what a click on a row should do —
 * usually opening a detail `Sheet`, which is the dominant admin pattern.
 */
/**
 * Hands paging, sorting and searching to the server (spec/surfaces.md §15.1).
 *
 * Omit it and the table does all three in the browser, which is right for a
 * table whose whole dataset comfortably fits one payload. Supply it and the
 * parent owns the data and the state: the table renders the page it was given
 * and reports what the operator asked for next.
 *
 * The three move together on purpose. A server-paged table that filtered in the
 * browser would search only the rows currently on screen — the search box would
 * quietly mean something different from what it says.
 */
export type DataTableServerMode = {
  /** Total rows matching the current search, across every page. */
  rowCount: number;
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
  search: string;
  /** Called whenever any of the above changes. Refetch, then pass the new state back. */
  onChange: (next: {
    pageIndex: number;
    pageSize: number;
    sorting: SortingState;
    search: string;
  }) => void;
};

export type DataTableProps<TData extends RowData> = {
  columns: DataTableColumn<TData>[];
  data: TData[];

  /** Page, sort and search on the server. See {@link DataTableServerMode}. */
  server?: DataTableServerMode;

  /**
   * Stable row identity. Pass it whenever rows carry a database id: without it
   * TanStack keys selection by array index, so re-sorting a table silently moves
   * the selection to different rows.
   */
  getRowId?: (row: TData, index: number) => string;

  /** Global search box. Omit to hide it. */
  searchPlaceholder?: string;
  /** Extra filter controls, rendered next to the search box. */
  toolbar?: React.ReactNode;

  enableSelection?: boolean;
  onRowClick?: (row: TData) => void;

  /**
   * The currently selected rows, whenever the selection changes.
   *
   * Added by module `D`: an action that follows the selection — "reissue these
   * four tickets" — needs to know what is ticked, and export following the
   * selection internally does not help a button outside the table. Additive and
   * optional, so no existing caller changes (modules.md §4: extend the shared
   * component rather than growing a second one).
   *
   * Fires with the rows themselves rather than ids, since a caller doing
   * anything useful with a selection needs the row anyway.
   */
  onSelectionChange?: (rows: TData[]) => void;

  export?: DataTableExport<TData>;

  isLoading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Shown when a filter — rather than an absent dataset — is why nothing matched. */
  emptyFilteredDescription?: string;

  initialPageSize?: number;
  className?: string;
};

/**
 * How long the search box waits before asking the server.
 *
 * UI responsiveness, not an operational value — it is not a capacity, quota,
 * deadline, cap, batch size or rate limit, so it does not belong in the cascade
 * (`CLAUDE.md`). In client mode nothing is debounced; filtering an array as you
 * type is free.
 */
const SEARCH_DEBOUNCE_MS = 300;

const serverState = (s: DataTableServerMode) => ({
  pageIndex: s.pageIndex,
  pageSize: s.pageSize,
  sorting: s.sorting,
  search: s.search,
});

export function DataTable<TData extends RowData>({
  columns,
  data,
  server,
  getRowId,
  searchPlaceholder,
  toolbar,
  enableSelection = false,
  onRowClick,
  onSelectionChange,
  export: exportConfig,
  isLoading = false,
  emptyTitle = 'Nothing here yet',
  emptyDescription = 'There is no data to show.',
  emptyFilteredDescription = 'No rows match the current filters.',
  initialPageSize = 25,
  className,
}: DataTableProps<TData>) {
  /**
   * In server mode the parent is the source of truth, so the table is told not
   * to slice, sort or filter what it was handed — it already holds exactly one
   * page. `rowCount` is what lets it still say "page 2 of 9" without the other
   * eight pages.
   */
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
    enableRowSelection: enableSelection,
    ...(server
      ? {
          manualPagination: true,
          manualSorting: true,
          manualFiltering: true,
          rowCount: server.rowCount,
          state: {
            pagination: { pageIndex: server.pageIndex, pageSize: server.pageSize },
            sorting: server.sorting,
            globalFilter: server.search,
          },
          onPaginationChange: (updater) => {
            const current = { pageIndex: server.pageIndex, pageSize: server.pageSize };
            const next = typeof updater === 'function' ? updater(current) : updater;
            server.onChange({ ...serverState(server), ...next });
          },
          onSortingChange: (updater) => {
            const next = typeof updater === 'function' ? updater(server.sorting) : updater;
            // A new sort order re-orders the whole set, not this page, so the
            // operator belongs back at the top of it.
            server.onChange({ ...serverState(server), sorting: next, pageIndex: 0 });
          },
          onGlobalFilterChange: (updater) => {
            const next = typeof updater === 'function' ? updater(server.search) : updater;
            server.onChange({ ...serverState(server), search: String(next ?? ''), pageIndex: 0 });
          },
        }
      : {
          initialState: { pagination: { pageIndex: 0, pageSize: initialPageSize } },
        }),
  });

  const rows = table.getRowModel().rows;
  const filteredRows = table.getFilteredRowModel().rows;
  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const globalFilter = (table.state.globalFilter as string | undefined) ?? '';

  /**
   * Export follows the selection when there is one, and the filtered view
   * otherwise — never the raw dataset, which would silently ignore whatever the
   * operator did to narrow it down.
   */
  const exportRows = React.useMemo(
    () =>
      (selectedRows.length > 0 ? selectedRows : filteredRows).map(
        (row: Row<DataTableFeatures, TData>) => row.original,
      ),
    [selectedRows, filteredRows],
  );

  /**
   * Report the selection outward for callers that act on it.
   *
   * Keyed on the row ids rather than the row objects: TanStack rebuilds the row
   * wrappers on every render, so depending on `selectedRows` itself would fire
   * this on each pass and, for a caller that sets state from it, loop.
   */
  const selectionKey = selectedRows
    .map((row: Row<DataTableFeatures, TData>) => row.id)
    .join(',');

  // Both the callback and the rows are read through a ref that a second effect
  // refreshes after every render, so neither has to be a dependency below. The
  // row wrappers are rebuilt on each pass, so depending on them directly would
  // fire this every render and loop any caller that sets state from it.
  const latest = React.useRef<{
    rows: TData[];
    notify: ((rows: TData[]) => void) | undefined;
  }>({ rows: [], notify: undefined });

  React.useEffect(() => {
    latest.current = {
      rows: selectedRows.map((row: Row<DataTableFeatures, TData>) => row.original),
      notify: onSelectionChange,
    };
  });

  React.useEffect(() => {
    latest.current.notify?.(latest.current.rows);
  }, [selectionKey]);

  /**
   * The search box types locally and tells the table on a delay.
   *
   * In server mode every change is a round trip, so propagating per keystroke
   * would fire a query per letter. The box is the local truth while someone is
   * typing; the table is told once they stop. Client mode has nothing to wait
   * for, so it is told immediately.
   */
  const [draft, setDraft] = React.useState(globalFilter);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  function onSearchInput(value: string) {
    setDraft(value);
    clearTimeout(timer.current);
    if (!server) {
      table.setGlobalFilter(value);
      return;
    }
    timer.current = setTimeout(() => table.setGlobalFilter(value), SEARCH_DEBOUNCE_MS);
  }

  const columnCount = table.getAllLeafColumns().length;
  const isFiltered = draft.length > 0 || table.state.columnFilters.length > 0;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          {searchPlaceholder && (
            <div className="relative w-full sm:max-w-xs">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                value={draft}
                onChange={(event) => onSearchInput(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-8 pl-8"
              />
            </div>
          )}
          {toolbar}
        </div>
        <div className="flex items-center gap-2">
          <DataTableViewOptions table={table} />
          {exportConfig && (
            <DataTableExportMenu
              rows={exportRows}
              config={exportConfig}
              // In server mode the table holds one page, so an unqualified
              // "export" would quietly hand over far less than the operator
              // filtered down to. Say which it is.
              scopeNote={
                server && selectedRows.length === 0 ? 'this page only' : undefined
              }
            />
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} colSpan={header.colSpan}>
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, rowIndex) => (
                  <TableRow key={rowIndex}>
                    {Array.from({ length: Math.max(1, columnCount) }).map((__, cellIndex) => (
                      <TableCell key={cellIndex}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={Math.max(1, columnCount)} className="h-64">
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <TableProperties />
                        </EmptyMedia>
                        <EmptyTitle>{isFiltered ? 'No matches' : emptyTitle}</EmptyTitle>
                        <EmptyDescription>
                          {isFiltered ? emptyFilteredDescription : emptyDescription}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() ? 'selected' : undefined}
                    // A row is only a button when there is somewhere to go. Without
                    // the role and key handler this would be a click target that
                    // keyboard users cannot reach.
                    {...(onRowClick
                      ? {
                          role: 'button',
                          tabIndex: 0,
                          onClick: () => onRowClick(row.original),
                          onKeyDown: (event: React.KeyboardEvent) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onRowClick(row.original);
                            }
                          },
                          className: 'cursor-pointer',
                        }
                      : {})}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <DataTablePagination
        table={table}
        selectable={enableSelection}
        totalCount={server?.rowCount}
      />
    </div>
  );
}
