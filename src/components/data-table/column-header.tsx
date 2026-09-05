'use client';

import type { Column, RowData } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { DataTableFeatures } from './features';

/**
 * A sortable, hideable column header.
 *
 * The arrow always reflects the *current* state — `ChevronsUpDown` for unsorted
 * rather than a hidden control — because a table where sorting is discoverable
 * only by clicking is a table nobody sorts.
 *
 * A column that can neither sort nor hide renders as plain text, so the header
 * row does not fill up with buttons that do nothing.
 */
export function DataTableColumnHeader<TData extends RowData, TValue>({
  column,
  title,
  className,
}: {
  column: Column<DataTableFeatures, TData, TValue>;
  title: string;
  className?: string;
}) {
  const canSort = column.getCanSort();
  const canHide = column.getCanHide();

  if (!canSort && !canHide) {
    return <div className={cn('px-2 py-1 font-medium', className)}>{title}</div>;
  }

  const sorted = column.getIsSorted();

  return (
    <div className={cn('flex items-center', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-8 data-[popup-open]:bg-accent"
            >
              <span>{title}</span>
              {sorted === 'desc' ? (
                <ArrowDown className="size-3.5" />
              ) : sorted === 'asc' ? (
                <ArrowUp className="size-3.5" />
              ) : (
                <ChevronsUpDown className="size-3.5 opacity-50" />
              )}
              <span className="sr-only">
                {sorted === 'asc'
                  ? `${title}, sorted ascending`
                  : sorted === 'desc'
                    ? `${title}, sorted descending`
                    : `${title}, not sorted`}
              </span>
            </Button>
          }
        />
        <DropdownMenuContent align="start">
          {canSort && (
            <>
              <DropdownMenuItem onClick={() => column.toggleSorting(false)}>
                <ArrowUp className="text-muted-foreground" />
                Ascending
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => column.toggleSorting(true)}>
                <ArrowDown className="text-muted-foreground" />
                Descending
              </DropdownMenuItem>
            </>
          )}
          {canSort && canHide && <DropdownMenuSeparator />}
          {canHide && (
            <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
              <EyeOff className="text-muted-foreground" />
              Hide column
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
