'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import {
  DataTable,
  DataTableColumnHeader,
  type DataTableColumn,
} from '@/components/data-table';
import type { ExportColumn } from '@/lib/export';
import type { ResponseTableRow } from './rows';

/**
 * The responses a form has taken, paged in Postgres (`modules.md` §5.2.1).
 *
 * **Server mode, not client mode.** A response list that filtered in the browser
 * would search only the rows on screen — and this is the table an admin reaches
 * for when somebody says "I registered and got nothing", which is exactly the
 * search that must not silently miss.
 *
 * The Export control here is deliberately *not* the `DataTable`'s own. That one
 * exports the current view, built from the row objects on screen; §8.5 needs
 * every response, with columns built from each response's **pinned schema**. The
 * two answer different questions, so the schema-aware export sits above the
 * table where it cannot be mistaken for "export what I am looking at".
 */

export function ResponsesTable({
  rows,
  rowCount,
  pageIndex,
  pageSize,
  sorting,
  search,
  basePath,
  timeZone,
}: {
  rows: ResponseTableRow[];
  rowCount: number;
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
  search: string;
  basePath: string;
  timeZone: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const columns: DataTableColumn<ResponseTableRow>[] = [
    {
      accessorKey: 'submittedAt',
      meta: { label: 'Submitted' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Submitted" />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.submittedAt}</span>,
    },
    {
      id: 'registrant',
      meta: { label: 'Registrant' },
      enableSorting: false,
      header: () => 'Registrant',
      // Read through the response's own pinned schema, so a form whose
      // registrant block was renamed still shows a name (`queries.ts`).
      cell: ({ row }) =>
        row.original.contactName || row.original.contactEmail ? (
          <div className="flex flex-col">
            <span>{row.original.contactName ?? '—'}</span>
            <span className="text-muted-foreground text-xs">{row.original.contactEmail}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'identityKey',
      meta: { label: 'Identity' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Identity" />,
      cell: ({ row }) =>
        row.original.identityKey ?? <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: 'seats',
      meta: { label: 'Seats asked for' },
      enableSorting: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Seats asked for" />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.seats}</span>,
    },
    {
      id: 'chain',
      meta: { label: 'Edit chain' },
      enableSorting: false,
      header: () => 'Edit chain',
      cell: ({ row }) => (
        <div className="flex gap-1">
          {row.original.isEdit && <Badge variant="outline">an edit</Badge>}
          {/* A superseded row is history, not a duplicate — the registration
              points at the newest and the chain is what an admin reads when
              somebody disputes what they submitted (spec/v2.md §8.3.1). */}
          {row.original.superseded && <Badge variant="secondary">superseded</Badge>}
          {!row.original.isEdit && !row.original.superseded && (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      ),
    },
  ];

  const exportColumns: ExportColumn<ResponseTableRow>[] = [
    { header: 'Response', value: (row) => row.id },
    { header: 'Submitted', value: (row) => row.submittedAt, width: 20 },
    { header: 'Identity', value: (row) => row.identityKey, width: 28 },
    { header: 'Seats asked for', value: (row) => row.seats },
    { header: 'Superseded', value: (row) => row.superseded },
  ];

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
    startTransition(() => router.replace(query ? `${basePath}?${query}` : basePath));
  }

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => String(row.id)}
      searchPlaceholder="Search every answer…"
      server={{ rowCount, pageIndex, pageSize, sorting, search, onChange: apply }}
      isLoading={isPending}
      export={{
        filename: 'form-responses',
        columns: exportColumns,
        timeZone,
        sheetName: 'Responses',
      }}
      emptyTitle="No responses yet"
      emptyDescription="Answers appear here as they arrive."
    />
  );
}
