'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { AlertTriangle, Download, Eye, Palette, RefreshCw, Ticket } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DataTable,
  DataTableColumnHeader,
  selectionColumn,
  type DataTableColumn,
} from '@/components/data-table';
import { formatInZone, type ExportColumn } from '@/lib/export';
import {
  dismissReissueAction,
  issueTicketsAction,
  matchingTicketIdsAction,
  reissueTicketsAction,
} from './actions';
import {
  BOOKING_STATUSES,
  TICKET_STATES,
  TICKET_STATE_LABELS,
  ticketSearchParams,
  type TicketFilters,
} from './filters';
import { AdminOnly } from '@/components/auth/role';

export type TicketRow = {
  id: number;
  fullName: string;
  showId: number;
  showName: string;
  segmentId: number;
  segmentName: string;
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  ticketCode: string | null;
  /** Has both a token and a pinned template — i.e. renderable. */
  issued: boolean;
  templateVersion: number | null;
  ticketIssuedAt: string | null;
  ticketSentAt: string | null;
  needsReissue: boolean;
  contactName: string | null;
};

function ticketUrl(id: number, download = false) {
  return `/api/tickets/${id}/pdf${download ? '?download=1' : ''}`;
}

function columnsFor(timeZone: string): DataTableColumn<TicketRow>[] {
  return [
    selectionColumn<TicketRow>(),
    {
      accessorKey: 'fullName',
      meta: { label: 'Attendee' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Attendee" />,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.fullName}</span>
          {row.original.contactName && row.original.contactName !== row.original.fullName && (
            <span className="text-muted-foreground text-xs">
              booked by {row.original.contactName}
            </span>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'showName',
      meta: { label: 'Show' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Show" />,
    },
    {
      accessorKey: 'segmentName',
      meta: { label: 'Segment' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Segment" />,
      cell: ({ row }) => (
        // Segments, not shows, own audience mode (CLAUDE.md), so this is the
        // column that says which block a seat came out of — and one show here
        // genuinely holds both a public and a player-invited segment.
        <span className="text-xs">{row.original.segmentName}</span>
      ),
    },
    {
      accessorKey: 'ticketCode',
      meta: { label: 'Code' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Code" />,
      cell: ({ row }) =>
        row.original.ticketCode ? (
          <span className="font-mono text-xs">{row.original.ticketCode}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'state',
      meta: { label: 'Ticket' },
      header: 'Ticket',
      cell: ({ row }) => {
        const t = row.original;
        if (t.status !== 'CONFIRMED') {
          return <Badge variant="outline">{t.status.toLowerCase().replace('_', ' ')}</Badge>;
        }
        if (!t.issued) return <Badge variant="secondary">not issued</Badge>;
        if (t.needsReissue) {
          return (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="size-3" aria-hidden />
              needs reissue
            </Badge>
          );
        }
        if (t.ticketSentAt) return <Badge>sent</Badge>;
        return <Badge variant="secondary">issued</Badge>;
      },
    },
    {
      accessorKey: 'templateVersion',
      meta: { label: 'Template' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Template" />,
      cell: ({ row }) =>
        row.original.templateVersion === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          // The pinned version, not the concert's current one (§10.5). Shown
          // because "why does this ticket look different" is otherwise
          // unanswerable from the screen.
          <span className="tabular-nums text-xs">v{row.original.templateVersion}</span>
        ),
    },
    {
      accessorKey: 'ticketSentAt',
      meta: { label: 'Sent' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Sent" />,
      cell: ({ row }) =>
        row.original.ticketSentAt ? (
          <span className="tabular-nums text-xs">
            {formatInZone(new Date(row.original.ticketSentAt), timeZone)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'actions',
      meta: { label: 'Actions' },
      header: '',
      cell: ({ row }) => {
        const t = row.original;
        if (!t.issued) return null;
        // Anchors rather than buttons: this project's `Button` has no `asChild`,
        // and a real link is what makes "open in a new tab" and "save as" work
        // the way an admin expects from a PDF.
        const linkClass = buttonVariants({ variant: 'ghost', size: 'icon' });
        return (
          <AdminOnly>
            <div className="flex justify-end gap-1">
              <a
                className={linkClass}
                href={ticketUrl(t.id)}
                target="_blank"
                rel="noreferrer"
                title="Preview"
                onClick={(event) => event.stopPropagation()}
              >
                <Eye className="size-4" aria-hidden />
                <span className="sr-only">Preview {t.fullName}&rsquo;s ticket</span>
              </a>
              <a
                className={linkClass}
                href={ticketUrl(t.id, true)}
                title="Download"
                onClick={(event) => event.stopPropagation()}
              >
                <Download className="size-4" aria-hidden />
                <span className="sr-only">Download {t.fullName}&rsquo;s ticket</span>
              </a>
            </div>
          </AdminOnly>
        );
      },
    },
  ];
}

const exportColumns: ExportColumn<TicketRow>[] = [
  { header: 'Attendee', value: (row) => row.fullName, width: 28 },
  { header: 'Show', value: (row) => row.showName, width: 24 },
  { header: 'Segment', value: (row) => row.segmentName, width: 18 },
  { header: 'Booked by', value: (row) => row.contactName },
  { header: 'Status', value: (row) => row.status },
  { header: 'Ticket code', value: (row) => row.ticketCode },
  { header: 'Issued', value: (row) => (row.ticketIssuedAt ? new Date(row.ticketIssuedAt) : null) },
  { header: 'Template version', value: (row) => row.templateVersion },
  { header: 'Sent', value: (row) => (row.ticketSentAt ? new Date(row.ticketSentAt) : null) },
  { header: 'Needs reissue', value: (row) => (row.needsReissue ? 'yes' : 'no') },
];

export function TicketsTable({
  concertId,
  concertName,
  timeZone,
  shows,
  segments,
  filters,
  rows,
  rowCount,
  needsReissueCount,
  pageIndex,
  pageSize,
  sorting,
}: {
  concertId: number;
  concertName: string;
  timeZone: string;
  shows: { id: number; name: string }[];
  segments: { id: number; name: string; showId: number; showName: string }[];
  filters: TicketFilters;
  rows: TicketRow[];
  rowCount: number;
  needsReissueCount: number;
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<TicketRow[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /**
   * The wider selection, resolved on the server (§10.5).
   *
   * Held as ids rather than as a flag, so both mutations keep taking the one
   * `attendeeIds` scope they already take — "all that match" and "these four I
   * ticked" reach `issueTickets()` as the same shape, and there is no second
   * code path where a filter could be applied differently.
   */
  const [allMatching, setAllMatching] = useState<number[] | null>(null);
  const [resolving, setResolving] = useState(false);

  function go(
    next: Partial<TicketFilters>,
    page: { pageIndex: number; pageSize: number; sorting: SortingState } = {
      pageIndex: 0,
      pageSize,
      sorting,
    },
  ) {
    const merged = { ...filters, ...next };
    const params = ticketSearchParams(merged, {
      page: page.pageIndex,
      size: page.pageSize,
      sort: page.sorting[0]?.id,
      dir: page.sorting[0]?.desc ? 'desc' : undefined,
    });
    const query = params.toString();
    // A different result set is a different "all that match", so the wider
    // selection cannot survive a filter change.
    setAllMatching(null);
    startTransition(() =>
      router.replace(`/admin/concerts/${concertId}/tickets${query ? `?${query}` : ''}`),
    );
  }

  function apply(next: {
    pageIndex: number;
    pageSize: number;
    sorting: SortingState;
    search: string;
  }) {
    go({ search: next.search }, next);
  }

  /**
   * Anything other than a fully ticked page drops the wider selection: the
   * operator has started curating, and silently acting on 244 rows when 243 are
   * ticked is the failure this banner exists to prevent.
   */
  function onSelectionChange(next: TicketRow[]) {
    setSelected(next);
    if (next.length !== rows.length || rows.length === 0) setAllMatching(null);
  }

  function selectAllMatching() {
    setResolving(true);
    startTransition(async () => {
      const result = await matchingTicketIdsAction({ concertId, ...filters });
      setResolving(false);
      if (!result.ok) {
        setNotice({ ok: false, text: result.error });
        return;
      }
      setAllMatching(result.ids);
    });
  }

  /** What the buttons will actually touch, for the label and the confirm. */
  const targetCount = allMatching?.length ?? selected.length;

  const visibleSegments = filters.showId
    ? segments.filter((segment) => segment.showId === filters.showId)
    : segments;

  /**
   * Both mutations follow the selection when there is one, and the show filter
   * otherwise. Never the whole concert implicitly: "reissue" resends email to
   * everyone it touches, so its blast radius has to be something the admin
   * chose rather than something the page defaulted to.
   */
  function scope() {
    if (allMatching) return { concertId, attendeeIds: allMatching };
    if (selected.length > 0) return { concertId, attendeeIds: selected.map((r) => r.id) };
    if (filters.segmentId) return { concertId, segmentId: filters.segmentId };
    if (filters.showId) return { concertId, showId: filters.showId };
    return null;
  }

  function run(
    action: typeof issueTicketsAction,
    verb: string,
    confirmText?: string,
  ) {
    const target = scope();
    if (!target) {
      setNotice({
        ok: false,
        text: `Choose a show or segment, or tick the attendees you want to ${verb}.`,
      });
      return;
    }
    /**
     * Reissue asks first, because it is the one action here that reaches
     * outside the system: clearing `ticket_sent_at` puts every ticket it
     * touches back in the queue for another email. Issue does not — it only
     * fills in identifiers that were missing — so it stays a single click.
     */
    if (confirmText && !window.confirm(confirmText)) return;
    startTransition(async () => {
      const result = await action(target);
      setNotice(
        result.ok ? { ok: true, text: result.message } : { ok: false, text: result.error },
      );
      // The rows it just changed may no longer match the filters, so a list
      // captured before the mutation is not a selection any more.
      if (result.ok) setAllMatching(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
          <p className="text-muted-foreground text-sm">
            {concertName} · {rowCount} attendee{rowCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Module E's editor. The design lives one level down rather than in
              a tab here: this screen is four hundred attendees, that one is
              three designs. */}
          <Button
            variant="outline"
            // A Button rendering an anchor is not a native <button>, and Base
            // UI logs an accessibility error on every load unless told so.
            nativeButton={false}
            render={<Link href={`/admin/concerts/${concertId}/tickets/templates`} />}
          >
            <Palette />
            Templates
          </Button>
          <AdminOnly>
            <Button onClick={() => run(issueTicketsAction, 'issue')} disabled={isPending}>
              <Ticket className="size-4" aria-hidden />
              {targetCount > 0
                ? `Issue ${targetCount} ticket${targetCount === 1 ? '' : 's'}`
                : 'Issue tickets'}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                run(
                  reissueTicketsAction,
                  'reissue',
                  `Reissue ${
                    targetCount > 0 ? `${targetCount} selected ticket(s)` : 'this show'
                  } against the current template?\n\nEvery ticket this touches will be ` +
                    're-rendered and queued to be emailed again.',
                )
              }
              disabled={isPending}
            >
              <RefreshCw className="size-4" aria-hidden />
              Reissue with current template
            </Button>
          </AdminOnly>
        </div>
      </header>

      {needsReissueCount > 0 && (
        // §10.6: the admin sees a count and resolves it deliberately.
        <div
          role="status"
          className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            {needsReissueCount} ticket{needsReissueCount === 1 ? '' : 's'} need
            {needsReissueCount === 1 ? 's' : ''} reissuing — a printed field changed
            after the ticket was sent.
          </span>
          {/*
            §10.6 gives two ways out — "reissue and resend, or dismiss as
            cosmetic". With only the first, a corrected spelling costs a whole
            show a second email, and the count stands until people stop reading
            it.
          */}
          <AdminOnly>
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() =>
                run(
                  dismissReissueAction,
                  'dismiss',
                  'Dismiss these as cosmetic?\n\nNothing is re-rendered and nobody ' +
                    'is emailed. The tickets people hold stay exactly as sent.',
                )
              }
            >
              Dismiss as cosmetic
            </Button>
          </AdminOnly>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={
            notice.ok
              ? 'rounded-md border px-3 py-2 text-sm'
              : 'border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm'
          }
        >
          {notice.text}
        </div>
      )}

      <DataTable
        columns={columnsFor(timeZone)}
        data={rows}
        getRowId={(row) => String(row.id)}
        searchPlaceholder="Search name or ticket code…"
        enableSelection
        onSelectionChange={onSelectionChange}
        toolbar={
          <>
            <FilterSelect
              label="Show"
              value={filters.showId ?? ''}
              onChange={(value) =>
                // A segment belongs to exactly one show, so a segment chosen
                // under a different show would filter to nothing.
                go({ showId: value ? Number(value) : null, segmentId: null })
              }
              options={shows.map((show) => ({ value: show.id, label: show.name }))}
              allLabel="All shows"
            />
            <FilterSelect
              label="Segment"
              value={filters.segmentId ?? ''}
              onChange={(value) => go({ segmentId: value ? Number(value) : null })}
              options={visibleSegments.map((segment) => ({
                value: segment.id,
                // Qualified only when the show filter is not already doing it.
                label: filters.showId
                  ? segment.name
                  : `${segment.name} · ${segment.showName}`,
              }))}
              allLabel="All segments"
            />
            <FilterSelect
              label="Status"
              value={filters.status ?? ''}
              onChange={(value) =>
                go({ status: (value || null) as TicketFilters['status'] })
              }
              options={BOOKING_STATUSES.map((status) => ({
                value: status,
                label: status.toLowerCase().replace('_', ' '),
              }))}
              allLabel="Any status"
            />
            <FilterSelect
              label="Ticket"
              value={filters.ticketState ?? ''}
              onChange={(value) =>
                go({ ticketState: (value || null) as TicketFilters['ticketState'] })
              }
              options={TICKET_STATES.map((state) => ({
                value: state,
                label: TICKET_STATE_LABELS[state],
              }))}
              allLabel="Any ticket state"
            />
          </>
        }
        selectAllMatching={{
          selected: allMatching !== null,
          total: rowCount,
          onSelect: selectAllMatching,
          onClear: () => setAllMatching(null),
          noun: 'tickets',
          busy: resolving,
        }}
        server={{
          rowCount,
          pageIndex,
          pageSize,
          sorting,
          search: filters.search,
          onChange: apply,
        }}
        isLoading={isPending}
        export={{
          filename: 'tickets',
          columns: exportColumns,
          timeZone,
          sheetName: 'Tickets',
        }}
        emptyTitle="No attendees yet"
        emptyDescription="Attendees arrive from the spreadsheet import (module C) or manual registration (module B)."
      />
    </div>
  );
}

/**
 * A plain native `<select>`, matching the one this screen already used for
 * shows. Four of them sit in the table toolbar rather than the page header, so
 * they read as "what narrows this table" alongside the search box, and so the
 * header keeps only the buttons that change something.
 */
function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  options: { value: string | number; label: string }[];
  allLabel: string;
}) {
  return (
    <select
      className="border-input bg-background h-8 rounded-md border px-2 text-sm capitalize"
      value={value}
      aria-label={`Filter by ${label.toLowerCase()}`}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
