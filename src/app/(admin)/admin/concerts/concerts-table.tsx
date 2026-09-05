'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import {
  DataTable,
  DataTableColumnHeader,
  selectionColumn,
  type DataTableColumn,
} from '@/components/data-table';
import type { ExportColumn } from '@/lib/export';

export type ConcertRow = {
  id: number;
  name: string;
  slug: string;
  season: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  startsOn: string | null;
  endsOn: string | null;
  timezone: string | null;
  shows: number;
};

const STATUS_VARIANT: Record<ConcertRow['status'], 'default' | 'secondary' | 'outline'> = {
  ACTIVE: 'default',
  DRAFT: 'secondary',
  ARCHIVED: 'outline',
};

const columns: DataTableColumn<ConcertRow>[] = [
  // Selection earns its place here rather than waiting for a wave-2 module:
  // ticking rows narrows the export to those concerts, and it means the
  // selection path is exercised by a real screen instead of shipping untried.
  selectionColumn<ConcertRow>(),
  {
    accessorKey: 'name',
    meta: { label: 'Name' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
    cell: ({ row }) => (
      <Link
        href={`/admin/concerts/${row.original.id}/overview`}
        className="font-medium underline-offset-4 hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: 'season',
    meta: { label: 'Season' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Season" />,
    cell: ({ row }) => row.original.season ?? <span className="text-muted-foreground">—</span>,
  },
  {
    accessorKey: 'status',
    meta: { label: 'Status' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <Badge variant={STATUS_VARIANT[row.original.status]}>
        {row.original.status.toLowerCase()}
      </Badge>
    ),
  },
  {
    accessorKey: 'startsOn',
    meta: { label: 'Starts' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Starts" />,
    // `starts_on` is a calendar date, not an instant: it is the same day in
    // every zone, so it is rendered as stored rather than converted.
    cell: ({ row }) => row.original.startsOn ?? <span className="text-muted-foreground">—</span>,
  },
  {
    accessorKey: 'shows',
    meta: { label: 'Shows' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Shows" />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.shows}</span>,
  },
];

const exportColumns: ExportColumn<ConcertRow>[] = [
  { header: 'Name', value: (row) => row.name, width: 32 },
  { header: 'Slug', value: (row) => row.slug },
  { header: 'Season', value: (row) => row.season },
  { header: 'Status', value: (row) => row.status },
  { header: 'Starts on', value: (row) => row.startsOn },
  { header: 'Ends on', value: (row) => row.endsOn },
  { header: 'Timezone', value: (row) => row.timezone },
  { header: 'Shows', value: (row) => row.shows },
];

/**
 * The concert list — and the first real consumer of the shared `DataTable`.
 *
 * Deliberately built against live rows rather than a demo fixture: a table that
 * only works on invented data proves nothing about the one every other module is
 * about to use.
 */
export function ConcertsTable({
  concerts,
  timeZone,
  rowCount,
  pageIndex,
  pageSize,
  sorting,
  search,
}: {
  concerts: ConcertRow[];
  timeZone: string;
  rowCount: number;
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
  search: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  /**
   * Table state lives in the URL, so the server can answer from it and a
   * narrowed-down view is a shareable link. `replace` rather than `push` keeps
   * paging out of the back-button history — a reader who pages five times wants
   * Back to leave the list, not walk it in reverse.
   */
  function apply(next: {
    pageIndex: number;
    pageSize: number;
    sorting: SortingState;
    search: string;
  }) {
    const params = new URLSearchParams();
    if (next.pageIndex > 0) params.set('page', String(next.pageIndex));
    if (next.pageSize !== 25) params.set('size', String(next.pageSize));
    if (next.sorting[0]) {
      params.set('sort', next.sorting[0].id);
      if (next.sorting[0].desc) params.set('dir', 'desc');
    }
    if (next.search) params.set('q', next.search);
    const query = params.toString();
    startTransition(() => router.replace(query ? `/admin/concerts?${query}` : '/admin/concerts'));
  }

  return (
    <DataTable
      columns={columns}
      data={concerts}
      getRowId={(row) => String(row.id)}
      searchPlaceholder="Search concerts…"
      enableSelection
      server={{ rowCount, pageIndex, pageSize, sorting, search, onChange: apply }}
      isLoading={isPending}
      onRowClick={(row) => router.push(`/admin/concerts/${row.id}/overview`)}
      export={{ filename: 'concerts', columns: exportColumns, timeZone, sheetName: 'Concerts' }}
      emptyTitle="No concerts yet"
      emptyDescription="Module A builds concert creation. Until then, seed one with pnpm db:seed:dev."
    />
  );
}
