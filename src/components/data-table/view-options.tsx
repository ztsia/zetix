'use client';

import { SlidersHorizontal } from 'lucide-react';
import type { ReactTable, RowData } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { DataTableFeatures } from './features';

/**
 * Column visibility.
 *
 * Labels come from `columnDef.meta.label` where a column sets one, because the
 * column id is often a database field name (`ticket_sent_at`) that means nothing
 * to a committee member.
 */
export function DataTableViewOptions<TData extends RowData>({
  table,
}: {
  table: ReactTable<DataTableFeatures, TData>;
}) {
  const hideable = table
    .getAllColumns()
    .filter((column) => typeof column.accessorFn !== 'undefined' && column.getCanHide());

  if (hideable.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="h-8">
            <SlidersHorizontal />
            <span className="hidden sm:inline">Columns</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-48">
        {/* Wrapped: Base UI's GroupLabel throws outside a Group. */}
        <DropdownMenuGroup>
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideable.map((column) => {
          const label =
            (column.columnDef.meta as { label?: string } | undefined)?.label ?? column.id;
          return (
            <DropdownMenuCheckboxItem
              key={column.id}
              className="capitalize"
              checked={column.getIsVisible()}
              onCheckedChange={(value: boolean) => column.toggleVisibility(!!value)}
            >
              {label}
            </DropdownMenuCheckboxItem>
          );
        })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
