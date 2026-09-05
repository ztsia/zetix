'use client';

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import type { ReactTable, RowData } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { DataTableFeatures } from './features';

/**
 * Page size options.
 *
 * Not an operational value: this is how many rows fit on a screen, not a
 * capacity, quota, deadline or cap. Nothing here comes from `context.md`.
 */
const PAGE_SIZES = [10, 25, 50, 100] as const;

export function DataTablePagination<TData extends RowData>({
  table,
  selectable,
  totalCount,
}: {
  table: ReactTable<DataTableFeatures, TData>;
  selectable: boolean;
  /** Server mode: rows matching the search across every page, not just this one. */
  totalCount?: number;
}) {
  const pageCount = table.getPageCount();
  const { pageIndex, pageSize } = table.state.pagination;
  const filteredRows = totalCount ?? table.getFilteredRowModel().rows.length;
  const selectedRows = table.getFilteredSelectedRowModel().rows.length;

  return (
    <div className="flex flex-col-reverse items-center gap-4 px-1 sm:flex-row sm:justify-between">
      <div className="text-muted-foreground text-sm" aria-live="polite">
        {selectable && selectedRows > 0
          ? `${selectedRows} of ${filteredRows} row${filteredRows === 1 ? '' : 's'} selected`
          : `${filteredRows} row${filteredRows === 1 ? '' : 's'}`}
      </div>

      <div className="flex items-center gap-4 sm:gap-6">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium whitespace-nowrap">Rows per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(value: string | null) => {
              if (value !== null) table.setPageSize(Number(value));
            }}
          >
            <SelectTrigger size="sm" className="w-[4.5rem]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="text-sm font-medium whitespace-nowrap">
          Page {pageCount === 0 ? 0 : pageIndex + 1} of {pageCount}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="hidden size-8 lg:flex"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">First page</span>
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Previous page</span>
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Next page</span>
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="hidden size-8 lg:flex"
            onClick={() => table.setPageIndex(pageCount - 1)}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Last page</span>
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
