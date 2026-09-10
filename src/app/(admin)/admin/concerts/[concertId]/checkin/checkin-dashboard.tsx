'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { SortingState } from '@tanstack/react-table';
import { DoorOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { NativeSelect } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { DataTable, DataTableColumnHeader, type DataTableColumn } from '@/components/data-table';
import type { ArrivalBucket, CheckinStats, OperatorCount, ScanLogRow } from '@/lib/checkin/dashboard';
import type { RejectedSync } from '@/lib/checkin/rejected-sync';
import { formatInZone } from '@/lib/export';
import type { ExportColumn } from '@/lib/export';
import { RevertScanButton } from './revert-scan-button';
import { RejectedSyncsAlert } from './rejected-syncs-alert';
import { buildDashboardQuery, type DashboardChange } from './dashboard-url';

type ShowOption = { id: number; name: string; startsAt: string | null };

/**
 * How often the open dashboard re-reads the door, in milliseconds.
 *
 * **Not an operational value** in CLAUDE.md's sense — no capacity, quota,
 * deadline or cap is involved and nothing about the concert changes if it moves.
 * It is a refresh cadence: fast enough that the desk sees a queue building,
 * slow enough that a whole evening of polling is a few hundred requests on a
 * Hobby plan.
 */
const POLL_MS = 15_000;

/**
 * The live check-in dashboard (spec/checkin.md §12.4).
 *
 * Three things at once, in the order the desk needs them: how the night is
 * going, how fast people are arriving, and what exactly was scanned — with the
 * ability to undo a scan that should not have happened.
 */
export function CheckinDashboard({
  concertId,
  concertName,
  timeZone,
  shows,
  showId,
  stats,
  arrivals,
  bucketMinutes,
  operatorCounts,
  rejectedSyncs,
  defaultShowId,
  scanLog,
  pageIndex,
  pageSize,
  sorting,
  search,
  includeReverted,
}: {
  concertId: number;
  concertName: string;
  timeZone: string;
  shows: ShowOption[];
  showId: number | null;
  stats: CheckinStats | null;
  arrivals: ArrivalBucket[];
  bucketMinutes: number;
  operatorCounts: OperatorCount[];
  rejectedSyncs: RejectedSync[];
  /** The id the page defaults to, which the query string therefore omits. */
  defaultShowId: number;
  scanLog: { rows: ScanLogRow[]; total: number };
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
  search: string;
  includeReverted: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (shows.length === 0 || showId === null || stats === null) {
    return (
      <div className="space-y-6">
        <DashboardHeader concertName={concertName} />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DoorOpen />
            </EmptyMedia>
            <EmptyTitle>This concert has no shows yet</EmptyTitle>
            <EmptyDescription>
              Add a show and its segments first — there is no door to watch until then.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  // Bound after the guard above: the narrowing to `number` does not follow
  // `showId` into the closure below, and widening the builder to accept null
  // would let a real "no show selected" bug through the type system.
  const currentShowId = showId;

  /** Table and show state live in the URL, so a narrowed view is a shareable link. */
  function apply(next: DashboardChange) {
    const query = buildDashboardQuery(
      {
        showId: currentShowId,
        defaultShowId,
        pageIndex,
        pageSize,
        sorting,
        search,
        includeReverted,
      },
      next,
    );
    const base = `/admin/concerts/${concertId}/checkin`;
    startTransition(() => router.replace(query ? `${base}?${query}` : base));
  }

  return (
    <div className="space-y-6">
      <DashboardHeader concertName={concertName}>
        <div className="flex items-center gap-2">
          <Label htmlFor="checkin-show" className="text-muted-foreground text-sm">
            Show
          </Label>
          <NativeSelect
            id="checkin-show"
            value={String(showId)}
            onChange={(event) => apply({ show: Number(event.target.value) })}
          >
            {shows.map((show) => (
              <option key={show.id} value={show.id}>
                {show.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </DashboardHeader>

      <LiveRefresh />

      <RejectedSyncsAlert rejected={rejectedSyncs} timeZone={timeZone} />

      <StatCards stats={stats} />

      <div className="grid gap-6 lg:grid-cols-3">
        <ArrivalChart arrivals={arrivals} bucketMinutes={bucketMinutes} timeZone={timeZone} />
        <OperatorCounts counts={operatorCounts} />
      </div>

      <ScanLog
        concertId={concertId}
        showId={showId}
        timeZone={timeZone}
        rows={scanLog.rows}
        total={scanLog.total}
        pageIndex={pageIndex}
        pageSize={pageSize}
        sorting={sorting}
        search={search}
        includeReverted={includeReverted}
        isPending={isPending}
        onApply={apply}
      />
    </div>
  );
}

function DashboardHeader({
  concertName,
  children,
}: {
  concertName: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Check-in</h1>
        <p className="text-muted-foreground text-sm">
          Live arrivals for {concertName}. Counts exclude reverted scans and count each guest
          once, however many times their ticket was scanned.
        </p>
      </div>
      {children}
    </header>
  );
}

/**
 * Re-reads the page on a timer while it is open.
 *
 * `router.refresh()` re-runs the Server Component and swaps the result in
 * without losing scroll position, the open dropdown or the search box — which a
 * `location.reload()` on a table someone is reading would not.
 */
function LiveRefresh() {
  const router = useRouter();
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => router.refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [live, router]);

  return (
    <div className="flex items-center gap-2">
      <Switch id="live" checked={live} onCheckedChange={setLive} />
      <Label htmlFor="live" className="text-muted-foreground text-sm font-normal">
        {live ? `Refreshing every ${POLL_MS / 1000}s` : 'Paused'}
      </Label>
    </div>
  );
}

function StatCards({ stats }: { stats: CheckinStats }) {
  const percent = stats.confirmed === 0 ? 0 : Math.round((stats.checkedIn / stats.confirmed) * 100);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Confirmed" value={stats.confirmed} hint="Seats expected tonight" />
      <StatCard label="Checked in" value={stats.checkedIn} hint={`${percent}% of confirmed`}>
        <Progress value={percent} className="mt-3" />
      </StatCard>
      <StatCard label="Remaining" value={stats.remaining} hint="Still to arrive" />
      <StatCard
        label="Admitted anyway"
        value={stats.admittedUnconfirmed}
        // Never a hard block at the door (§12.1), but the one number worth a
        // second look at the desk rather than burying in the log.
        hint="Cancelled or waitlisted, let in by an usher"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: number;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums">{value}</div>
        <p className="text-muted-foreground mt-1 text-xs">{hint}</p>
        {children}
      </CardContent>
    </Card>
  );
}

const arrivalChartConfig = {
  count: { label: 'Arrivals', color: 'var(--chart-1)' },
} satisfies ChartConfig;

function ArrivalChart({
  arrivals,
  bucketMinutes,
  timeZone,
}: {
  arrivals: ArrivalBucket[];
  bucketMinutes: number;
  timeZone: string;
}) {
  /**
   * Gaps are filled with zeroes here rather than in SQL.
   *
   * A bar chart that simply omits a quiet five minutes draws the busy buckets
   * adjacent to each other and makes a lull look like continuous arrivals —
   * which is the opposite of what the desk is reading this to find out.
   */
  const data = useMemo(() => {
    if (arrivals.length === 0) return [];
    const step = bucketMinutes * 60_000;
    const first = new Date(arrivals[0]!.bucketStart).getTime();
    const last = new Date(arrivals[arrivals.length - 1]!.bucketStart).getTime();
    const counts = new Map(
      arrivals.map((bucket) => [new Date(bucket.bucketStart).getTime(), bucket.count]),
    );

    const filled: { label: string; count: number }[] = [];
    for (let at = first; at <= last; at += step) {
      filled.push({
        // Rendered in the concert's zone, never the viewer's (spec/domain.md §6.1).
        label: formatInZone(new Date(at), timeZone).slice(11),
        count: counts.get(at) ?? 0,
      });
    }
    return filled;
  }, [arrivals, bucketMinutes, timeZone]);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">Arrivals</CardTitle>
        <p className="text-muted-foreground text-sm">
          When people actually reached the door, in {bucketMinutes}-minute buckets — read from
          the scan time on the phone, so a spell offline does not move anyone.
        </p>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            Nobody has been scanned in yet.
          </p>
        ) : (
          <ChartContainer config={arrivalChartConfig} className="h-[220px] w-full">
            <BarChart accessibilityLayer data={data}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function OperatorCounts({ counts }: { counts: OperatorCount[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">By operator</CardTitle>
        <p className="text-muted-foreground text-sm">
          Guests admitted, busiest first. One guest scanned on two phones counts for each
          usher, so these can add up to more than the arrivals above.
        </p>
      </CardHeader>
      <CardContent>
        {counts.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">No scans yet.</p>
        ) : (
          <Table>
            <TableBody>
              {counts.map((row) => (
                <TableRow key={row.operatorId ?? 'unknown'}>
                  <TableCell className="font-medium">
                    {row.operatorName ?? (
                      // The scan happened; the account that made it is gone.
                      <span className="text-muted-foreground">Removed operator</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const SOURCE_LABEL: Record<ScanLogRow['source'], string> = {
  ONLINE: 'Scanned',
  OFFLINE_SYNC: 'Synced later',
  MANUAL: 'Manual',
};

function ScanLog({
  concertId,
  showId,
  timeZone,
  rows,
  total,
  pageIndex,
  pageSize,
  sorting,
  search,
  includeReverted,
  isPending,
  onApply,
}: {
  concertId: number;
  showId: number;
  timeZone: string;
  rows: ScanLogRow[];
  total: number;
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
  search: string;
  includeReverted: boolean;
  isPending: boolean;
  onApply: (next: DashboardChange) => void;
}) {
  const columns: DataTableColumn<ScanLogRow>[] = useMemo(
    () => [
      {
        accessorKey: 'attendeeName',
        meta: { label: 'Attendee' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Attendee" />,
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <div
              className={
                // A reverted scan stays in the log, struck through: the record of
                // the night includes the mistakes and their undoing (decision 7).
                row.original.revertedAt ? 'font-medium line-through opacity-60' : 'font-medium'
              }
            >
              {row.original.attendeeName}
            </div>
            {row.original.ticketCode && (
              <div className="text-muted-foreground font-mono text-xs">
                {row.original.ticketCode}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'scannedAt',
        meta: { label: 'Scanned' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Scanned" />,
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">
            {formatInZone(new Date(row.original.scannedAt), timeZone)}
          </span>
        ),
      },
      {
        accessorKey: 'operatorName',
        meta: { label: 'Operator' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Operator" />,
        cell: ({ row }) =>
          row.original.operatorName ?? (
            <span className="text-muted-foreground">Removed operator</span>
          ),
      },
      {
        accessorKey: 'source',
        meta: { label: 'How' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="How" />,
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="outline">{SOURCE_LABEL[row.original.source]}</Badge>
            {row.original.status !== 'CONFIRMED' && (
              <Badge variant="destructive">{row.original.status.toLowerCase()}</Badge>
            )}
            {row.original.revertedAt && <Badge variant="secondary">reverted</Badge>}
          </div>
        ),
      },
      {
        id: 'reason',
        meta: { label: 'Note' },
        enableSorting: false,
        header: 'Note',
        cell: ({ row }) =>
          row.original.overrideReason ? (
            <span className="text-sm">{row.original.overrideReason}</span>
          ) : row.original.revertedByName ? (
            <span className="text-muted-foreground text-sm">
              Reverted by {row.original.revertedByName}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        enableHiding: false,
        enableSorting: false,
        meta: { label: 'Actions' },
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) =>
          row.original.revertedAt ? null : (
            <RevertScanButton
              checkInId={row.original.id}
              showId={showId}
              concertId={concertId}
              attendeeName={row.original.attendeeName}
            />
          ),
      },
    ],
    [concertId, showId, timeZone],
  );

  const exportColumns: ExportColumn<ScanLogRow>[] = useMemo(
    () => [
      { header: 'Attendee', value: (row) => row.attendeeName, width: 28 },
      { header: 'Ticket code', value: (row) => row.ticketCode },
      { header: 'Status', value: (row) => row.status },
      { header: 'Scanned at', value: (row) => new Date(row.scannedAt) },
      { header: 'Synced at', value: (row) => (row.syncedAt ? new Date(row.syncedAt) : null) },
      { header: 'Operator', value: (row) => row.operatorName },
      { header: 'Device', value: (row) => row.deviceId },
      { header: 'Source', value: (row) => row.source },
      { header: 'Override reason', value: (row) => row.overrideReason },
      { header: 'Reverted at', value: (row) => (row.revertedAt ? new Date(row.revertedAt) : null) },
      { header: 'Reverted by', value: (row) => row.revertedByName },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Scan log</h2>
        <div className="flex items-center gap-2">
          <Switch
            id="show-reverted"
            checked={includeReverted}
            onCheckedChange={(checked: boolean) => onApply({ includeReverted: checked })}
          />
          <Label htmlFor="show-reverted" className="text-muted-foreground text-sm font-normal">
            Show reverted
          </Label>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => String(row.id)}
        searchPlaceholder="Search name, ticket, operator or device…"
        server={{
          rowCount: total,
          pageIndex,
          pageSize,
          sorting,
          search,
          onChange: (next) => onApply(next),
        }}
        isLoading={isPending}
        export={{
          filename: 'scan-log',
          columns: exportColumns,
          timeZone,
          sheetName: 'Scan log',
        }}
        emptyTitle="Nothing scanned yet"
        emptyDescription="Admissions appear here as the door works, including scans that synced late."
      />
    </div>
  );
}

