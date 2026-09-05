'use client';

import type { RowData } from '@tanstack/react-table';
import { Checkbox } from '@/components/ui/checkbox';
import type { DataTableColumn } from './features';

/**
 * The leading checkbox column, for tables that act on several rows at once —
 * the extras review walk, an email blast, bulk note approval.
 *
 * Header state is three-valued. Base UI takes `indeterminate` as its own prop
 * rather than as a third value of `checked` (the Radix convention the shadcn
 * docs describe), and getting that wrong renders a "some selected" header as
 * plain unchecked.
 *
 * Pass `getRowId` to `DataTable` alongside this, or selection is keyed by array
 * index and follows position rather than row when the table is re-sorted.
 */
export function selectionColumn<TData extends RowData>(): DataTableColumn<TData> {
  return {
    id: 'select',
    header: ({ table }) => {
      const allSelected = table.getIsAllPageRowsSelected();
      const someSelected = table.getIsSomePageRowsSelected();
      return (
        <Checkbox
          checked={allSelected}
          indeterminate={!allSelected && someSelected}
          onCheckedChange={(checked: boolean) => table.toggleAllPageRowsSelected(!!checked)}
          aria-label="Select all rows on this page"
        />
      );
    },
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(checked: boolean) => row.toggleSelected(!!checked)}
        aria-label="Select row"
        // The row itself may open a detail sheet; a click on the checkbox must
        // select, not navigate.
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
      />
    ),
    enableSorting: false,
    enableHiding: false,
  };
}
