'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  DataTable,
  DataTableSavedViews,
  tableStateToQuery,
  useUrlTableState,
  type DataTableColumn,
  type UrlTableState,
} from '@/components/data-table';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ACTIVITY_VIEWS,
  type ActivityRow,
  type Paged,
  type RunRow,
} from '@/lib/activity/labels';
import { RunDialog } from '../commands/run-dialog';
import { StatusBadge } from '../commands/run-report';

export function ActivityView({
  concertId,
  timeZone,
  state,
  tab,
  changes,
  runs,
}: {
  concertId: number;
  timeZone: string;
  state: UrlTableState;
  tab: 'changes' | 'runs';
  changes: Paged<ActivityRow> | null;
  runs: Paged<RunRow> | null;
}) {
  const pathname = usePathname();
  const total = (tab === 'changes' ? changes?.total : runs?.total) ?? 0;
  const { server, navigate, isPending } = useUrlTableState(state, total);
  const [detail, setDetail] = React.useState<ActivityRow | null>(null);
  const [openRun, setOpenRun] = React.useState<number | null>(null);

  const format = React.useMemo(
    () =>
      new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone }),
    [timeZone],
  );

  const changeColumns = React.useMemo<DataTableColumn<ActivityRow>[]>(
    () => [
      {
        accessorKey: 'at',
        header: 'When',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground whitespace-nowrap tabular-nums">
            {format.format(new Date(row.original.at))}
          </span>
        ),
      },
      {
        accessorKey: 'action',
        header: 'What',
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span>,
      },
      {
        id: 'entity',
        header: 'Record',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.entityType}
            {row.original.entityId ? ` #${row.original.entityId}` : ''}
          </span>
        ),
      },
      {
        accessorKey: 'actor',
        header: 'Who',
        enableSorting: false,
        cell: ({ row }) => row.original.actor ?? <span className="text-muted-foreground">System</span>,
      },
      {
        accessorKey: 'reason',
        header: 'Reason',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.reason ? (
            <span className="line-clamp-2 max-w-xs">{row.original.reason}</span>
          ) : null,
      },
      {
        id: 'run',
        header: 'Run',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.commandRunId ? (
            <Button
              variant="link"
              size="xs"
              onClick={(event) => {
                event.stopPropagation();
                setOpenRun(row.original.commandRunId);
              }}
            >
              #{row.original.commandRunId}
            </Button>
          ) : null,
      },
    ],
    [format],
  );

  const runColumns = React.useMemo<DataTableColumn<RunRow>[]>(
    () => [
      {
        accessorKey: 'startedAt',
        header: 'Started',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground whitespace-nowrap tabular-nums">
            {format.format(new Date(row.original.startedAt))}
          </span>
        ),
      },
      {
        accessorKey: 'command',
        header: 'Command',
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.command}</span>,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'counts',
        header: 'Rows',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.done} done
            {row.original.skipped > 0 && ` · ${row.original.skipped} skipped`}
            {row.original.failed > 0 && (
              <span className="text-destructive"> · {row.original.failed} failed</span>
            )}{' '}
            <span className="text-muted-foreground">of {row.original.total}</span>
          </span>
        ),
      },
      {
        accessorKey: 'actor',
        header: 'Who',
        enableSorting: false,
        cell: ({ row }) => row.original.actor ?? <span className="text-muted-foreground">System</span>,
      },
    ],
    [format],
  );

  const setTab = (next: string) =>
    navigate({ ...state, pageIndex: 0, search: '', extra: next === 'runs' ? { tab: 'runs' } : {} });

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="runs">Command runs</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'changes' && changes && (
        <>
          <DataTableSavedViews
            tableId={`activity:${concertId}`}
            currentQuery={tableStateToQuery(state)}
            builtIn={[
              { id: 'all', label: 'All', query: '' },
              ...ACTIVITY_VIEWS.map((view) => ({
                id: view.id,
                label: view.label,
                query: `?view=${view.id}`,
              })),
            ]}
          />
          {state.extra.run && (
            <p className="text-muted-foreground text-sm">
              Showing the changes made by run #{state.extra.run}.{' '}
              <Link className="text-primary underline-offset-4 hover:underline" href={pathname}>
                Show everything
              </Link>
            </p>
          )}
          <DataTable
            columns={changeColumns}
            data={changes.rows}
            server={server}
            getRowId={(row) => String(row.id)}
            isLoading={isPending}
            searchPlaceholder="Search action, reason or record id…"
            onRowClick={setDetail}
            emptyTitle="Nothing recorded yet"
            emptyDescription="Changes made in this concert appear here."
          />
        </>
      )}

      {tab === 'runs' && runs && (
        <DataTable
          columns={runColumns}
          data={runs.rows}
          server={server}
          getRowId={(row) => String(row.id)}
          isLoading={isPending}
          onRowClick={(row) => setOpenRun(row.id)}
          emptyTitle="No commands run yet"
          emptyDescription="Bulk commands, with their per-row reports, appear here."
        />
      )}

      <RunDialog concertId={concertId} runId={openRun} onClose={() => setOpenRun(null)} />

      <Sheet open={detail !== null} onOpenChange={(open: boolean) => !open && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {detail && (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-sm">{detail.action}</SheetTitle>
                <SheetDescription>
                  {format.format(new Date(detail.at))} · {detail.actor ?? 'System'} ·{' '}
                  {detail.entityType}
                  {detail.entityId ? ` #${detail.entityId}` : ''}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 px-4 pb-4 text-sm">
                {detail.reason && (
                  <p>
                    <span className="text-muted-foreground">Reason: </span>
                    {detail.reason}
                  </p>
                )}
                <JsonBlock title="Before" value={detail.before} />
                <JsonBlock title="After" value={detail.after} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium uppercase">{title}</span>
      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
