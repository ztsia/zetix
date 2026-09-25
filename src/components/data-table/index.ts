/**
 * The one shared admin table (spec/modules.md §4). Import from here, never from
 * the individual files, so the surface stays a single reviewable API.
 */
export { DataTable, type DataTableProps } from './data-table';
export { DataTableColumnHeader } from './column-header';
export { DataTablePagination } from './pagination';
export { DataTableViewOptions } from './view-options';
export { DataTableExportMenu, type DataTableExport } from './export-menu';
export { selectionColumn } from './selection-column';
export { dataTableFeatures, type DataTableColumn, type DataTableFeatures } from './features';
export { useTableSelection } from './use-selection';
export { useUrlTableState } from './use-url-state';
export { parseTableState, tableStateToQuery, filterKeyOf, type UrlTableState } from './url-state';
export { DataTableSavedViews, type BuiltInView } from './saved-views';
