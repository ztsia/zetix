'use client';

import * as React from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import {
  DataTable,
  DataTableColumnHeader,
  filterKeyOf,
  selectionColumn,
  useTableSelection,
  useUrlTableState,
  type DataTableColumn,
  type UrlTableState,
} from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KIND_LABEL, TRASH_KINDS, type TrashKind, type TrashPage, type TrashRow } from '@/lib/trash/labels';
import { CommandDialog } from '../commands/command-dialog';

/**
 * The Trash's table (spec/v3.md §23.6).
 *
 * Selection is the shared §22.3 model: tick rows, or select every row matching
 * the search on every page — in which case the dialog is handed the search, not
 * a list of ids, and the server resolves it when the command runs.
 */
export function TrashTable({
  concertId,
  timeZone,
  kind,
  state,
  page,
}: {
  concertId: number;
  timeZone: string;
  kind: TrashKind;
  state: UrlTableState;
  page: TrashPage;
}) {
  const { server, setExtra, isPending } = useUrlTableState(state, page.total);
  const label = KIND_LABEL[kind];

  const { selection, count, clear, tableProps } = useTableSelection({
    filter: { search: state.search },
    filterKey: filterKeyOf(state),
    total: page.total,
    pageIds: page.rows.map((row) => String(row.id)),
  });

  const columns = React.useMemo<DataTableColumn<TrashRow>[]>(() => {
    const format = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    });
    return [
      selectionColumn<TrashRow>(),
      {
        accessorKey: 'label',
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.original.label}</span>
            {row.original.detail && (
              <span className="text-muted-foreground text-xs">{row.original.detail}</span>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'deletedAt',
        header: ({ column }) => <DataTableColumnHeader column={column} title="Deleted" />,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground tabular-nums">
            {format.format(new Date(row.original.deletedAt))}
          </span>
        ),
      },
    ];
  }, [timeZone]);

  const noun = count === 1 ? label.one : label.many;

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={kind} onValueChange={(value: string) => setExtra('kind', value)}>
        <TabsList variant="line">
          {TRASH_KINDS.map((k) => (
            <TabsTrigger key={k} value={k}>
              {KIND_LABEL[k].title}
              <Badge variant={page.counts[k] > 0 ? 'secondary' : 'outline'} className="tabular-nums">
                {page.counts[k]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <DataTable
        key={kind}
        columns={columns}
        data={page.rows}
        server={server}
        getRowId={(row) => String(row.id)}
        enableSelection
        {...tableProps}
        selectAllMatching={{ ...tableProps.selectAllMatching, noun: label.many }}
        isLoading={isPending}
        searchPlaceholder={`Search deleted ${label.many}…`}
        emptyTitle={`No deleted ${label.many}`}
        emptyDescription={`Deleted ${label.many} land here and can be restored.`}
        // Always mounted, only disabled: a dialog unmounted by the refresh
        // that follows its own run (the rows it restored leave the table)
        // would take the report with it.
        toolbar={
          <ButtonGroup>
            <CommandDialog
              concertId={concertId}
              command={`trash.restore.${kind}`}
              selection={selection}
              onDone={clear}
              trigger={
                <Button variant="outline" size="sm" disabled={count === 0}>
                  <RotateCcw data-icon="inline-start" />
                  {count > 0 ? `Restore ${count} ${noun}` : 'Restore'}
                </Button>
              }
            />
            <CommandDialog
              concertId={concertId}
              command={`trash.purge.${kind}`}
              selection={selection}
              onDone={clear}
              trigger={
                <Button variant="outline" size="sm" className="text-destructive" disabled={count === 0}>
                  <Trash2 data-icon="inline-start" />
                  Delete permanently
                </Button>
              }
            />
          </ButtonGroup>
        }
      />
    </div>
  );
}
