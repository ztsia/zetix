'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import {
  DataTable,
  DataTableColumnHeader,
  type DataTableColumn,
} from '@/components/data-table';
import type { ExportColumn } from '@/lib/export';
import { RegistrationFormDialog } from './registration-form-dialog';
import { RegistrationSheet } from './registration-sheet';
import { STATUS_LABEL, STATUS_TONE } from './status';
import type {
  AttendeeRow,
  PlayerOption,
  RegistrationRow,
  SegmentOption,
} from './queries';

/**
 * The registrations table (spec/admin.md §14.1, spec/allocation.md §7.6).
 *
 * One row per party, because a registration **is** a party of N (decision 31):
 * one email, N seats, N tickets. The seats live in the detail sheet a row click
 * opens, which is the admin console's dominant pattern (spec/surfaces.md §15.1)
 * and the only place they can be edited one at a time.
 *
 * Client mode rather than server: this concert is a few hundred parties, so the
 * whole set fits one payload and filtering it is instant. `DataTable` supports
 * server paging for the tables that need it.
 */
export function RegistrationsTable({
  concertId,
  timeZone,
  registrations,
  attendeesByRegistration,
  segments,
  players,
}: {
  concertId: number;
  timeZone: string | null;
  registrations: RegistrationRow[];
  attendeesByRegistration: Record<number, AttendeeRow[]>;
  segments: SegmentOption[];
  players: PlayerOption[];
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [segmentFilter, setSegmentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const rows = useMemo(
    () =>
      registrations.filter(
        (row) =>
          (segmentFilter === 'all' || String(row.segmentId) === segmentFilter) &&
          (statusFilter === 'all' || row.status === statusFilter),
      ),
    [registrations, segmentFilter, statusFilter],
  );

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timeZone ?? 'UTC',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    [timeZone],
  );

  const columns: DataTableColumn<RegistrationRow>[] = [
    {
      accessorKey: 'contactName',
      meta: { label: 'Contact' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Contact" />,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.contactName}</span>
          {row.original.contactEmail && (
            <span className="text-muted-foreground text-xs">
              {row.original.contactEmail}
            </span>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'playerName',
      meta: { label: 'Player' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Player" />,
      cell: ({ row }) =>
        row.original.playerName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: 'segmentName',
      meta: { label: 'Segment' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Segment" />,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span>{row.original.segmentName}</span>
          <span className="text-muted-foreground text-xs">{row.original.showName}</span>
        </div>
      ),
    },
    {
      accessorKey: 'roundLabel',
      meta: { label: 'Round' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Round" />,
      cell: ({ row }) =>
        row.original.roundLabel ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'seats',
      meta: { label: 'Seats' },
      header: 'Seats',
      cell: ({ row }) => {
        const { confirmed, pending, waitlisted } = row.original.seats;
        return (
          <div className="flex flex-wrap gap-1">
            {confirmed > 0 && <Badge>{confirmed} confirmed</Badge>}
            {pending > 0 && <Badge variant="secondary">{pending} in review</Badge>}
            {waitlisted > 0 && <Badge variant="outline">{waitlisted} waiting</Badge>}
            {confirmed + pending + waitlisted === 0 && (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: 'status',
      meta: { label: 'Status' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => (
        <Badge variant={STATUS_TONE[row.original.status]}>
          {STATUS_LABEL[row.original.status]}
        </Badge>
      ),
    },
    {
      accessorKey: 'requestedAt',
      meta: { label: 'Requested' },
      sortFn: 'datetime',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Requested" />,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {dateFormatter.format(row.original.requestedAt)}
        </span>
      ),
    },
    {
      id: 'tickets',
      meta: { label: 'Tickets' },
      header: 'Tickets',
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.ticketsSent > 0 && (
            <Badge variant="secondary">{row.original.ticketsSent} sent</Badge>
          )}
          {row.original.needsReissue > 0 && (
            <Badge variant="destructive">{row.original.needsReissue} reissue</Badge>
          )}
        </div>
      ),
    },
  ];

  const open = registrations.find((row) => row.id === openId) ?? null;

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => String(row.id)}
        searchPlaceholder="Search name, email or player…"
        onRowClick={(row) => setOpenId(row.id)}
        emptyTitle="No registrations yet"
        emptyDescription="Registrations arrive by import, or are created here by hand."
        emptyFilteredDescription="No party matches these filters."
        export={{
          filename: 'registrations',
          columns: exportColumns(timeZone),
          timeZone: timeZone ?? 'UTC',
        }}
        toolbar={
          <>
            <NativeSelect
              value={segmentFilter}
              onChange={(event) => setSegmentFilter(event.target.value)}
              aria-label="Filter by segment"
              className="w-auto"
            >
              <option value="all">All segments</option>
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.label}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="Filter by status"
              className="w-auto"
            >
              <option value="all">Any status</option>
              <option value="CONFIRMED">Confirmed</option>
              <option value="PENDING_REVIEW">In review</option>
              <option value="WAITLIST">Waiting</option>
              <option value="CANCELLED">Cancelled</option>
            </NativeSelect>
            <RegistrationFormDialog
              concertId={concertId}
              timeZone={timeZone}
              segments={segments}
              players={players}
              trigger={
                <Button size="sm">
                  <Plus /> New registration
                </Button>
              }
            />
          </>
        }
      />

      <RegistrationSheet
        concertId={concertId}
        timeZone={timeZone}
        registration={open}
        attendees={open ? (attendeesByRegistration[open.id] ?? []) : []}
        segments={segments}
        players={players}
        open={openId !== null}
        onOpenChange={(next) => setOpenId(next ? openId : null)}
      />
    </>
  );
}

/**
 * The export, in the concert's timezone like everything else on this screen.
 *
 * Seats are three columns rather than one, because a spreadsheet that says
 * "2 confirmed, 1 waiting" in a single cell cannot be summed — and the reason
 * anyone exports this is to add it up.
 */
function exportColumns(timeZone: string | null): ExportColumn<RegistrationRow>[] {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone ?? 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return [
    { header: 'Contact', value: (row) => row.contactName },
    { header: 'Email', value: (row) => row.contactEmail ?? '' },
    { header: 'Phone', value: (row) => row.contactPhone ?? '' },
    { header: 'Player', value: (row) => row.playerName ?? '' },
    { header: 'Show', value: (row) => row.showName },
    { header: 'Segment', value: (row) => row.segmentName },
    { header: 'Round', value: (row) => row.roundLabel ?? '' },
    { header: 'Source', value: (row) => row.source },
    { header: 'Status', value: (row) => STATUS_LABEL[row.status] },
    { header: 'Confirmed', value: (row) => row.seats.confirmed },
    { header: 'In review', value: (row) => row.seats.pending },
    { header: 'Waiting', value: (row) => row.seats.waitlisted },
    { header: 'Tickets sent', value: (row) => row.ticketsSent },
    { header: 'Requested', value: (row) => format.format(row.requestedAt) },
  ];
}
