'use client';

import * as React from 'react';
import { AlertTriangle, CircleAlert, Info, Users } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DataTable, DataTableColumnHeader, type DataTableColumn } from '@/components/data-table';
import type { PlanResponse } from './types';

/**
 * Step 5 — the dry run (spec/import.md §9.6).
 *
 * The per-row table is the shared `DataTable`, unextended: the level filter goes
 * in its existing `toolbar` slot and export comes with it (`../modules.md` §4 —
 * nobody forks it).
 *
 * Three things sit *above* the table because a per-row view cannot say them, and
 * they are what an admin actually has to check before an irreversible commit:
 * the grouping the importer derived, the seat outcome against the live pool, and
 * whatever is blocking.
 */

export type ReportRow = {
  rowNumber: number;
  party: string;
  contactName: string;
  attendee: string;
  allocationType: string;
  promoted: boolean;
  level: 'BLOCKING' | 'WARNING' | 'INFO' | 'OK';
  message: string;
};

/** Flattens a plan into one row per sheet row, carrying its worst finding. */
export function toReportRows(plan: PlanResponse): ReportRow[] {
  const worst = new Map<number, { level: ReportRow['level']; message: string }>();
  const rank = { BLOCKING: 3, WARNING: 2, INFO: 1, OK: 0 } as const;

  for (const f of plan.findings) {
    if (f.rowNumber === undefined) continue;
    const current = worst.get(f.rowNumber);
    if (!current || rank[f.level] > rank[current.level]) {
      worst.set(f.rowNumber, { level: f.level, message: f.message });
    }
  }

  const rows: ReportRow[] = [];
  for (const party of plan.parties) {
    for (const seat of party.seats) {
      const finding = worst.get(seat.rowNumber);
      rows.push({
        rowNumber: seat.rowNumber,
        party: party.contactEmail ?? party.contactName,
        contactName: party.contactName,
        attendee: seat.fullName ?? `Guest of ${party.contactName}`,
        allocationType: seat.allocationType,
        promoted: seat.promotedFromBase,
        level: finding?.level ?? (party.blocked ? 'BLOCKING' : 'OK'),
        message: finding?.message ?? (party.blocked ? 'Skipped: this party is blocked.' : ''),
      });
    }
  }
  return rows.sort((a, b) => a.rowNumber - b.rowNumber);
}

const LEVEL_VARIANT = {
  BLOCKING: 'destructive',
  WARNING: 'secondary',
  INFO: 'outline',
  OK: 'outline',
} as const;

const columns: DataTableColumn<ReportRow>[] = [
  {
    accessorKey: 'rowNumber',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Row" />,
    sortFn: 'basic',
    cell: ({ row }) => <span className="tabular-nums">{row.original.rowNumber}</span>,
  },
  {
    accessorKey: 'contactName',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Party" />,
    sortFn: 'text',
  },
  {
    accessorKey: 'attendee',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Attendee" />,
    sortFn: 'text',
  },
  {
    accessorKey: 'allocationType',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Seat" />,
    sortFn: 'text',
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5">
        <Badge variant="outline">{row.original.allocationType}</Badge>
        {row.original.promoted ? (
          <span className="text-muted-foreground text-xs">over quota</span>
        ) : null}
      </span>
    ),
  },
  {
    accessorKey: 'level',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Level" />,
    sortFn: 'text',
    cell: ({ row }) =>
      row.original.level === 'OK' ? (
        <span className="text-muted-foreground text-xs">—</span>
      ) : (
        <Badge variant={LEVEL_VARIANT[row.original.level]}>{row.original.level}</Badge>
      ),
  },
  {
    accessorKey: 'message',
    header: 'Detail',
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs">{row.original.message}</span>
    ),
  },
];

export function DryRunReport({ plan, timeZone }: { plan: PlanResponse; timeZone: string }) {
  const [level, setLevel] = React.useState<string>('ALL');
  const all = React.useMemo(() => toReportRows(plan), [plan]);
  const rows = React.useMemo(
    () => (level === 'ALL' ? all : all.filter((r) => r.level === level)),
    [all, level],
  );

  const fileLevel = plan.findings.filter((f) => f.rowNumber === undefined);
  const partySizes = plan.parties.filter((p) => !p.blocked).map((p) => p.seats.length);
  const seatsConsumed = plan.extrasPolicy === 'REVIEW' ? plan.counts.baseSeats : plan.counts.seats;

  return (
    <div className="space-y-6">
      {plan.counts.blocking > 0 ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>
            {plan.counts.blocking} blocking {plan.counts.blocking === 1 ? 'issue' : 'issues'}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {fileLevel.map((f, i) => (
                <li key={`file-${i}`}>{f.message}</li>
              ))}
              {plan.parties.some((p) => p.blocked) ? (
                <li>
                  {plan.parties.filter((p) => p.blocked).length} of {plan.counts.parties} parties
                  will be skipped. Fix them in the sheet and dry run again, or commit without them.
                </li>
              ) : null}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {/*
        The grouping check. This is what makes decision 33 safe: the reshaping
        happened outside the system, so the only place a mis-grouping is visible
        before commit is right here.
      */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Users className="size-4" />
            Grouping
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {plan.counts.rows} rows &rarr; {plan.counts.parties}{' '}
            {plan.counts.parties === 1 ? 'registration' : 'registrations'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            Largest party {plan.largestParty}
            {partySizes.length > 0 ? ` · sizes ${summarise(partySizes)}` : ''}
            {plan.counts.ungrouped > 0
              ? ` · ${plan.counts.ungrouped} row${plan.counts.ungrouped === 1 ? '' : 's'} with no email, each its own registration`
              : ''}
          </p>
        </div>

        <div className="rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Info className="size-4" />
            Seats
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {plan.counts.seats} <span className="text-muted-foreground text-base">seats</span>
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {plan.counts.baseSeats} base · {plan.counts.extraSeats} extra
            {plan.counts.promotedToExtra > 0
              ? ` (${plan.counts.promotedToExtra} over quota)`
              : ''}{' '}
            · {seatsConsumed} of {plan.openSeats} open seats used
            {plan.extrasPolicy === 'REVIEW' ? ', extras held for review' : ''}
          </p>
        </div>
      </div>

      {plan.counts.placeholderNames > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>
            {plan.counts.placeholderNames} attendees have no name
          </AlertTitle>
          <AlertDescription>
            They will ticket as &ldquo;Guest of {'{'}contact name{'}'}&rdquo;. This is not an error
            — you can fill the names in before the blast.
          </AlertDescription>
        </Alert>
      ) : null}

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.rowNumber)}
        searchPlaceholder="Search rows, names, messages"
        initialPageSize={25}
        emptyTitle="Nothing to show"
        emptyDescription="This file produced no rows."
        emptyFilteredDescription="No rows at this level."
        toolbar={
          // Base UI's ToggleGroup is always multi-value, so single-select is
          // expressed by keeping one entry and defaulting an empty set back to
          // "ALL" — a filter that can be toggled into showing nothing is a
          // filter that looks broken.
          <ToggleGroup
            value={[level]}
            onValueChange={(v) => setLevel((v as string[])[0] ?? 'ALL')}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="ALL">All {all.length}</ToggleGroupItem>
            <ToggleGroupItem value="BLOCKING">Blocking {plan.counts.blocking}</ToggleGroupItem>
            <ToggleGroupItem value="WARNING">Warning {plan.counts.warning}</ToggleGroupItem>
            <ToggleGroupItem value="INFO">Info {plan.counts.info}</ToggleGroupItem>
          </ToggleGroup>
        }
        export={{
          filename: 'import-dry-run',
          // The concert's zone, never the viewer's (`CLAUDE.md`).
          timeZone,
          columns: [
            { header: 'Row', value: (r) => r.rowNumber },
            { header: 'Party', value: (r) => r.contactName },
            { header: 'Attendee', value: (r) => r.attendee },
            { header: 'Seat', value: (r) => r.allocationType },
            { header: 'Level', value: (r) => r.level },
            { header: 'Detail', value: (r) => r.message },
          ],
        }}
      />
    </div>
  );
}

/** "1x2, 2x3, 1x4" — the party-size breakdown §9.6 asks for. */
function summarise(sizes: number[]): string {
  const counts = new Map<number, number>();
  for (const s of sizes) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([size, n]) => `${n}x${size}`)
    .join(', ');
}
