'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, Users, Armchair } from 'lucide-react';
import {
  DataTable,
  DataTableColumnHeader,
  DataTableSavedViews,
  filterKeyOf,
  selectionColumn,
  tableStateToQuery,
  useTableSelection,
  useUrlTableState,
  type BuiltInView,
  type DataTableColumn,
  type UrlTableState,
} from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  SEAT_STATUSES,
  TICKET_STATES,
  VIEWS,
  type AudienceFilter,
  type Grain,
} from '@/lib/audience/filter';
import type { Option, Page, PartyRow, SeatRow } from '@/lib/audience/queries';
import {
  ALLOCATION_LABEL,
  FlagBadges,
  SEAT_STATUS_LABEL,
  SOURCE_LABEL,
  StageBadge,
  formatter,
} from './badges';
import { COMMAND_ENTRIES, entry, useRunCommand, type CommandEntry } from './command-host';

/**
 * The Audience table (spec/v3.md §22.1–§22.3): one server-paged table over
 * `party_pipeline`, at the grain of parties or of seats.
 *
 * Everything that decides what is listed is in the URL — grain, view, filters,
 * search, page — so a view is a link (§22.2). Selection is the shared §22.3
 * model: ticked ids, or the filter itself with exclusions, which the command
 * resolves again on the server when it runs.
 */

const TICKET_LABEL: Record<(typeof TICKET_STATES)[number], string> = {
  none: 'No ticket yet',
  issued: 'Issued, not sent',
  delivered: 'Delivered',
  'needs-reissue': 'Needs reissue',
};

/**
 * The commands each view is *for*, shown as buttons beside the selection; the
 * rest stay in the menu. A queue is a filter plus the thing you do to it
 * (§20.1 principle 3).
 */
const VIEW_ACTIONS: Record<string, { parties: string[]; seats: string[] }> = {
  'needs-review': { parties: ['audience.approve', 'audience.grant_extras', 'audience.decline_extras'], seats: [] },
  unverified: { parties: ['audience.release', 'audience.remind_verification'], seats: [] },
  'needs-tickets': { parties: [], seats: ['seats.issue'] },
  waitlisted: { parties: ['audience.promote', 'audience.confirm_seats'], seats: [] },
  cancelled: { parties: ['audience.restore'], seats: [] },
  'suspicious-address': { parties: ['audience.check_address', 'audience.accept_address'], seats: [] },
  'changed-after-send': { parties: [], seats: ['seats.reissue', 'seats.dismiss_reissue'] },
  'unnamed-guests': { parties: [], seats: [] },
  'over-capacity': { parties: ['audience.waitlist'], seats: [] },
};

export function AudienceTable({
  concertId,
  timeZone,
  grain,
  filter,
  state,
  page,
  counts,
  options,
  toolbarExtra,
}: {
  concertId: number;
  timeZone: string;
  grain: Grain;
  filter: AudienceFilter;
  state: UrlTableState;
  page: Page<PartyRow> | Page<SeatRow>;
  counts: { all: number; views: Record<string, number> };
  options: { shows: Option[]; segments: (Option & { showId: number })[]; players: Option[] };
  toolbarExtra?: React.ReactNode;
}) {
  const router = useRouter();
  const runCommand = useRunCommand();
  const { server, setExtra, navigate, isPending } = useUrlTableState(state, page.total);

  const { selection, count, clear, tableProps } = useTableSelection({
    filter,
    filterKey: filterKeyOf(state),
    total: page.total,
    pageIds: page.rows.map((row) => String(row.id)),
  });

  const format = React.useMemo(() => formatter(timeZone), [timeZone]);
  const recordHref = (registrationId: number) =>
    `/admin/concerts/${concertId}/audience/${registrationId}`;

  const noun = grain === 'parties' ? { one: 'party', many: 'parties' } : { one: 'seat', many: 'seats' };

  // Views keep the grain and nothing else: a view is a named filter, and
  // opening one is starting from it (§22.2).
  const base: Record<string, string> = grain === 'seats' ? { grain: 'seats' } : {};
  const viewQuery = (view: string | null) =>
    tableStateToQuery({
      pageIndex: 0,
      pageSize: state.pageSize,
      sorting: [],
      search: '',
      extra: view ? { ...base, view } : base,
    });
  const builtIn: BuiltInView[] = [
    { id: 'all', label: 'All', query: viewQuery(null), count: counts.all },
    ...VIEWS.filter((view) => view.kind === 'stage' || counts.views[view.id] > 0 || view.id === filter.view).map(
      (view) => ({ id: view.id, label: view.label, query: viewQuery(view.id), count: counts.views[view.id] }),
    ),
  ];

  const open = (command: string) => {
    if (!selection) return;
    runCommand({ command, selection, onDone: clear });
  };

  const primary = (filter.view ? VIEW_ACTIONS[filter.view]?.[grain] : undefined) ?? [];
  const menu = COMMAND_ENTRIES.filter((e) => e.grain === grain);
  const groups = [...new Set(menu.map((e) => e.group))];

  const partyColumns: DataTableColumn<PartyRow>[] = [
    selectionColumn<PartyRow>(),
    {
      id: 'contactName',
      accessorKey: 'contactName',
      meta: { label: 'Party' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Party" />,
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          <Link
            href={recordHref(row.original.id)}
            className="truncate font-medium hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {row.original.contactName}
          </Link>
          <span className="text-muted-foreground truncate text-xs">
            {row.original.contactEmail ?? 'No email'}
          </span>
        </div>
      ),
    },
    {
      id: 'segment',
      meta: { label: 'Segment' },
      header: 'Segment',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex flex-col text-sm">
          <span>{row.original.segmentName}</span>
          <span className="text-muted-foreground text-xs">
            {row.original.showName}
            {row.original.playerName ? ` · ${row.original.playerName}` : ''}
          </span>
        </div>
      ),
    },
    {
      id: 'seats',
      meta: { label: 'Seats' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Seats" />,
      cell: ({ row }) => {
        const s = row.original.seats;
        return (
          <div className="flex flex-col text-sm tabular-nums">
            <span>
              {s.confirmed} confirmed
              {s.pending > 0 ? `, ${s.pending} in review` : ''}
              {s.waitlisted > 0 ? `, ${s.waitlisted} waiting` : ''}
            </span>
            {s.confirmed > 0 && (
              <span className="text-muted-foreground text-xs">
                {s.delivered} of {s.confirmed} sent
                {s.admitted > 0 ? ` · ${s.admitted} in` : ''}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: 'stage',
      meta: { label: 'Stage' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Stage" />,
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-1">
          <StageBadge stage={row.original.stage} />
          <FlagBadges flags={row.original.flags} />
        </div>
      ),
    },
    {
      id: 'requestedAt',
      meta: { label: 'Requested' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Requested" />,
      cell: ({ row }) => (
        <div className="flex flex-col text-sm">
          <span className="tabular-nums">{format.format(new Date(row.original.requestedAt))}</span>
          <span className="text-muted-foreground text-xs">
            {SOURCE_LABEL[row.original.source]}
            {row.original.roundLabel ? ` · ${row.original.roundLabel}` : ''}
          </span>
        </div>
      ),
    },
  ];

  const seatColumns: DataTableColumn<SeatRow>[] = [
    selectionColumn<SeatRow>(),
    {
      id: 'fullName',
      accessorKey: 'fullName',
      meta: { label: 'Guest' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Guest" />,
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          <span className={row.original.placeholder ? 'text-muted-foreground italic' : 'font-medium'}>
            {row.original.fullName}
          </span>
          <Link
            href={recordHref(row.original.registrationId)}
            className="text-muted-foreground truncate text-xs hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {row.original.contactName}
          </Link>
        </div>
      ),
    },
    {
      id: 'segment',
      meta: { label: 'Segment' },
      header: 'Segment',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex flex-col text-sm">
          <span>{row.original.segmentName}</span>
          <span className="text-muted-foreground text-xs">{ALLOCATION_LABEL[row.original.allocationType]}</span>
        </div>
      ),
    },
    {
      id: 'status',
      meta: { label: 'Status' },
      header: 'Status',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-1">
          <Badge variant={row.original.status === 'CONFIRMED' ? 'secondary' : 'outline'}>
            {SEAT_STATUS_LABEL[row.original.status]}
          </Badge>
          {row.original.overCapacity && <Badge variant="destructive">Over capacity</Badge>}
        </div>
      ),
    },
    {
      id: 'ticketCode',
      meta: { label: 'Ticket' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Ticket" />,
      cell: ({ row }) => {
        const s = row.original;
        if (!s.ticketCode) return <span className="text-muted-foreground text-sm">—</span>;
        return (
          <div className="flex flex-col text-sm">
            <span className="font-mono">{s.ticketCode}</span>
            <span className="text-muted-foreground text-xs">
              {s.templateName ? `${s.templateName} v${s.templateVersion}` : 'Not pinned'}
            </span>
          </div>
        );
      },
    },
    {
      id: 'delivery',
      meta: { label: 'Delivery' },
      header: 'Delivery',
      enableSorting: false,
      cell: ({ row }) => {
        const s = row.original;
        return (
          <div className="flex flex-col items-start gap-1 text-sm">
            {s.sentAt ? (
              <span className="tabular-nums">
                {s.sentSource === 'MANUAL' ? 'By hand' : 'Emailed'} {format.format(new Date(s.sentAt))}
              </span>
            ) : (
              <span className="text-muted-foreground">Not sent</span>
            )}
            {s.needsReissue && <Badge variant="destructive">Changed after send</Badge>}
          </div>
        );
      },
    },
    {
      id: 'admittedAt',
      meta: { label: 'Door' },
      header: 'Door',
      enableSorting: false,
      cell: ({ row }) =>
        row.original.admittedAt ? (
          <span className="text-sm tabular-nums">In {format.format(new Date(row.original.admittedAt))}</span>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        ),
    },
  ];

  const segmentsShown = filter.showId
    ? options.segments.filter((s) => s.showId === filter.showId)
    : options.segments;

  const toolbar = (
    <>
      <FilterSelect
        label="Show"
        value={filter.showId}
        options={options.shows}
        allLabel="All shows"
        onChange={(value) => {
          const extra = { ...state.extra };
          if (value) extra.show = value;
          else delete extra.show;
          delete extra.segment;
          navigate({ ...state, extra, pageIndex: 0 });
        }}
      />
      <FilterSelect
        label="Segment"
        value={filter.segmentId}
        options={segmentsShown}
        allLabel="All segments"
        onChange={(value) => setExtra('segment', value)}
      />
      {options.players.length > 0 && (
        <FilterSelect
          label="Player"
          value={filter.playerId}
          options={options.players}
          allLabel="Any player"
          onChange={(value) => setExtra('player', value)}
        />
      )}
      <FilterSelect
        label="Source"
        value={filter.source}
        options={[
          { id: 'FORM', label: 'Form' },
          { id: 'IMPORT', label: 'Import' },
          { id: 'ADMIN', label: 'Admin' },
        ]}
        allLabel="Any source"
        onChange={(value) => setExtra('source', value)}
      />
      {grain === 'seats' && (
        <>
          <FilterSelect
            label="Seat status"
            value={filter.seatStatus}
            options={SEAT_STATUSES.map((s) => ({ id: s, label: SEAT_STATUS_LABEL[s] }))}
            allLabel="Any status"
            onChange={(value) => setExtra('status', value)}
          />
          <FilterSelect
            label="Ticket"
            value={filter.ticket}
            options={TICKET_STATES.map((s) => ({ id: s, label: TICKET_LABEL[s] }))}
            allLabel="Any ticket"
            onChange={(value) => setExtra('ticket', value)}
          />
        </>
      )}
    </>
  );

  const actions = (
    <ButtonGroup>
      {primary.map((command) => (
        <ActionButton key={command} entry={entry(command)} count={count} onClick={() => open(command)} />
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" disabled={count === 0}>
              {count > 0 ? `${count} selected` : 'Actions'}
              <ChevronDown data-icon="inline-end" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
          {groups.map((group, index) => (
            <React.Fragment key={group}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{group}</DropdownMenuLabel>
                {menu
                  .filter((e) => e.group === group)
                  .map((e) => (
                    <DropdownMenuItem
                      key={e.command}
                      variant={e.destructive ? 'destructive' : 'default'}
                      onClick={() => open(e.command)}
                    >
                      <e.icon />
                      {e.label}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuGroup>
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          value={[grain]}
          onValueChange={(value) => {
            const next = (value as string[])[0];
            if (next && next !== grain) {
              navigate({ ...state, extra: { ...state.extra, grain: next === 'seats' ? 'seats' : '' }, pageIndex: 0, sorting: [] });
            }
          }}
          variant="outline"
          size="sm"
          aria-label="Show parties or seats"
        >
          <ToggleGroupItem value="parties">
            <Users />
            Parties
          </ToggleGroupItem>
          <ToggleGroupItem value="seats">
            <Armchair />
            Seats
          </ToggleGroupItem>
        </ToggleGroup>
        {actions}
      </div>

      <DataTableSavedViews
        tableId={`audience-${grain}`}
        builtIn={builtIn}
        currentQuery={tableStateToQuery({ ...state, pageIndex: 0 })}
      />

      {toolbarExtra}

      {grain === 'parties' ? (
        <DataTable
          key="parties"
          columns={partyColumns}
          data={page.rows as PartyRow[]}
          server={server}
          getRowId={(row) => String(row.id)}
          enableSelection
          {...tableProps}
          selectAllMatching={{ ...tableProps.selectAllMatching, noun: noun.many }}
          onRowClick={(row) => router.push(recordHref(row.id))}
          isLoading={isPending}
          toolbar={toolbar}
          searchPlaceholder="Search name, email, phone, guest or ticket code…"
          emptyTitle="No parties here"
          emptyDescription="Parties arrive from the forms, from an import, or from New party."
          emptyFilteredDescription="Nothing matches this view and these filters."
          export={{
            filename: 'audience-parties',
            timeZone,
            sheetName: 'Parties',
            columns: [
              { header: 'Contact', value: (r: PartyRow) => r.contactName },
              { header: 'Email', value: (r: PartyRow) => r.contactEmail },
              { header: 'Phone', value: (r: PartyRow) => r.contactPhone },
              { header: 'Show', value: (r: PartyRow) => r.showName },
              { header: 'Segment', value: (r: PartyRow) => r.segmentName },
              { header: 'Player', value: (r: PartyRow) => r.playerName },
              { header: 'Stage', value: (r: PartyRow) => r.stage },
              { header: 'Flags', value: (r: PartyRow) => r.flags.join(', ') },
              { header: 'Confirmed', value: (r: PartyRow) => r.seats.confirmed },
              { header: 'Sent', value: (r: PartyRow) => r.seats.delivered },
              { header: 'Requested', value: (r: PartyRow) => new Date(r.requestedAt) },
            ],
          }}
        />
      ) : (
        <DataTable
          key="seats"
          columns={seatColumns}
          data={page.rows as SeatRow[]}
          server={server}
          getRowId={(row) => String(row.id)}
          enableSelection
          {...tableProps}
          selectAllMatching={{ ...tableProps.selectAllMatching, noun: noun.many }}
          onRowClick={(row) => router.push(recordHref(row.registrationId))}
          isLoading={isPending}
          toolbar={toolbar}
          searchPlaceholder="Search name, email, phone, guest or ticket code…"
          emptyTitle="No seats here"
          emptyDescription="Seats arrive with their parties."
          emptyFilteredDescription="Nothing matches this view and these filters."
          export={{
            filename: 'audience-seats',
            timeZone,
            sheetName: 'Seats',
            columns: [
              { header: 'Guest', value: (r: SeatRow) => r.fullName },
              { header: 'Party', value: (r: SeatRow) => r.contactName },
              { header: 'Segment', value: (r: SeatRow) => r.segmentName },
              { header: 'Type', value: (r: SeatRow) => r.allocationType },
              { header: 'Status', value: (r: SeatRow) => r.status },
              { header: 'Ticket code', value: (r: SeatRow) => r.ticketCode },
              { header: 'Sent', value: (r: SeatRow) => (r.sentAt ? new Date(r.sentAt) : null) },
              { header: 'Admitted', value: (r: SeatRow) => (r.admittedAt ? new Date(r.admittedAt) : null) },
            ],
          }}
        />
      )}
    </div>
  );
}

function ActionButton({ entry: e, count, onClick }: { entry: CommandEntry; count: number; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" disabled={count === 0} onClick={onClick}>
      <e.icon data-icon="inline-start" />
      {e.label}
    </Button>
  );
}

function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
}: {
  label: string;
  value: string | number | undefined;
  options: { id: string | number; label: string }[];
  allLabel: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <NativeSelect
      size="sm"
      aria-label={`Filter by ${label.toLowerCase()}`}
      value={value === undefined ? '' : String(value)}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <NativeSelectOption value="">{allLabel}</NativeSelectOption>
      {options.map((option) => (
        <NativeSelectOption key={option.id} value={String(option.id)}>
          {option.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
