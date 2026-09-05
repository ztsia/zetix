import {
  type ColumnDef,
  type RowData,
  columnFilteringFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
} from '@tanstack/react-table';

/**
 * The feature set every admin table shares.
 *
 * TanStack Table v9 is feature-composed rather than monolithic: row models,
 * sort functions and filter functions are stitched in statically here instead of
 * being passed per table. Declaring them once, outside any component, is both
 * the documented pattern and the thing that keeps six consuming modules on
 * identical behaviour.
 *
 * Registered `sortFns` and `filterFns` keys become the valid string values for a
 * column's `sortFn` / `filterFn`, with inference — so a typo in a column
 * definition is a type error rather than a table that silently does not sort.
 */
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,

  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),

  filterFns: { includesString: filterFn_includesString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
});

export type DataTableFeatures = typeof dataTableFeatures;

/**
 * A column definition for {@link DataTable}.
 *
 * `TValue` is `any` deliberately, and it is TanStack's own recommendation for
 * this position: one `columns` array holds a string column beside a number
 * column beside a date column, and any single concrete `TValue` makes the array
 * unassignable. The value type is still checked *inside* each column, where
 * `accessorKey` and `cell` are inferred against `TData`.
 */
export type DataTableColumn<TData extends RowData> = ColumnDef<
  DataTableFeatures,
  TData,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;
