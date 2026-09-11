'use client';

import * as React from 'react';
import { AlertTriangle, Check, CircleAlert, Info, UserSearch, Users } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DataTable, DataTableColumnHeader, type DataTableColumn } from '@/components/data-table';
import type { PlanResponse, RosterPlayer } from './types';

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
  player: string;
  attendee: string;
  allocationType: string;
  promoted: boolean;
  level: 'BLOCKING' | 'WARNING' | 'INFO' | 'OK';
  /** Every finding for this row, worst first — not only the worst one. */
  message: string;
};

/**
 * Flattens a plan into one row per sheet row.
 *
 * **Every finding for a row, not only its worst.** Keeping the worst alone hid
 * the §9.5 promotion notice behind any warning on the same row — so a seat
 * silently moved from BASE to EXTRA showed a party-size warning and nothing
 * about the seat that changed, which is the one thing the admin needed to see.
 */
export function toReportRows(plan: PlanResponse): ReportRow[] {
  const rank = { BLOCKING: 3, WARNING: 2, INFO: 1, OK: 0 } as const;
  const byRow = new Map<number, { level: ReportRow['level']; message: string }>();

  for (const f of plan.findings) {
    if (f.rowNumber === undefined) continue;
    const current = byRow.get(f.rowNumber);
    byRow.set(f.rowNumber, {
      level: !current || rank[f.level] > rank[current.level] ? f.level : current.level,
      message: current ? `${current.message} ${f.message}` : f.message,
    });
  }
  const worst = byRow;

  const rows: ReportRow[] = [];
  for (const party of plan.parties) {
    for (const seat of party.seats) {
      const finding = worst.get(seat.rowNumber);
      rows.push({
        rowNumber: seat.rowNumber,
        party: party.contactEmail ?? party.contactName,
        contactName: party.contactName,
        player: party.playerName ?? (party.playerId == null ? '' : `#${party.playerId}`),
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
    // Which player a party matched to is the whole point of the player-invited
    // path, and the report had no way to show it went to the right one.
    accessorKey: 'player',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Player" />,
    sortFn: 'text',
    cell: ({ row }) =>
      row.original.player ? (
        row.original.player
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      ),
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

/**
 * The player decisions this plan is waiting on (spec/import.md §9.3).
 *
 * §9.3 says an unmatched or under-threshold player is "confirmed or corrected",
 * and until now there was nowhere to do either: both codes are BLOCKING, the
 * report offered only "fix them in the sheet and dry run again", and correcting
 * a name in the sheet means editing the responses after they were collected. So
 * a 39% match — which is what an annotated roster entry like
 * "HARUTO LIM (only 19/9)" scores against the name someone actually types — was
 * a dead end.
 *
 * One row per distinct cell value rather than per party: the decision is about
 * the name, and two parties that wrote the same thing have the same answer.
 */
function decisions(plan: PlanResponse) {
  const out = new Map<
    string,
    {
      needle: string;
      playerId?: number;
      playerName?: string;
      confidence?: number;
      parties: number;
    }
  >();
  for (const f of plan.findings) {
    if (f.code !== 'PLAYER_MATCH_UNCONFIRMED' && f.code !== 'PLAYER_NOT_MATCHED') continue;
    if (!f.match) continue;
    const current = out.get(f.match.needle);
    if (current) current.parties += 1;
    else out.set(f.match.needle, { ...f.match, parties: 1 });
  }
  return [...out.values()];
}

function DecisionPanel({
  plan,
  roster,
  overrides,
  onOverride,
  onRerun,
  busy,
}: {
  plan: PlanResponse;
  roster: RosterPlayer[];
  overrides: Record<string, number>;
  onOverride: (needle: string, playerId: number | null) => void;
  onRerun: () => void;
  busy: boolean;
}) {
  const pending = React.useMemo(() => decisions(plan), [plan]);
  const rosterById = React.useMemo(() => new Map(roster.map((p) => [p.id, p.fullName])), [roster]);

  /*
   * Choices taken but not yet re-planned. The plan on screen was computed
   * without them, so it still shows these parties as skipped — the panel says
   * how many are waiting rather than letting the counts above look final.
   */
  const decided = pending.filter((d) => overrides[d.needle] != null).length;

  if (pending.length === 0) return null;

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserSearch className="size-4" />
            {pending.length} {pending.length === 1 ? 'name needs' : 'names need'} a decision
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Confirm the suggestion or choose the right player. Nothing is written until you commit,
            and every choice is re-checked against the roster then.
          </p>
        </div>
        <Button onClick={onRerun} disabled={busy || decided === 0}>
          {busy ? <Spinner /> : null}
          Apply {decided > 0 ? `${decided} ` : ''}and dry run again
        </Button>
      </div>

      <ul className="divide-y">
        {pending.map((d) => {
          const chosen = overrides[d.needle];
          return (
            <li key={d.needle} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-56 flex-1">
                <div className="font-medium">{d.needle}</div>
                <p className="text-muted-foreground text-sm">
                  {d.playerName ? (
                    <>
                      Closest is {d.playerName}
                      {d.confidence == null ? null : (
                        <>
                          {' at '}
                          {/*
                            A weak suggestion is coloured rather than withheld.
                            `NAME_FUZZY` always returns a best match, so a name
                            nobody on the roster resembles still arrives with one
                            — 13% here means "no", while the 39% an annotated
                            roster entry scores against a real name means "yes".
                            No cutoff separates those two honestly, so the number
                            is made loud instead of a threshold being invented.
                          */}
                          <span
                            className={
                              d.confidence < 0.4 ? 'text-destructive font-medium' : 'font-medium'
                            }
                          >
                            {(d.confidence * 100).toFixed(0)}%
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    'Nothing on the roster matched'
                  )}
                  {d.parties > 1 ? ` · ${d.parties} parties` : ''}
                </p>
              </div>

              {chosen != null ? (
                <div className="flex items-center gap-2">
                  <Badge>
                    <Check className="size-3" />
                    {rosterById.get(chosen) ?? `#${chosen}`}
                  </Badge>
                  <Button variant="ghost" size="sm" onClick={() => onOverride(d.needle, null)}>
                    Undo
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {/*
                    Only offered when there is a suggestion to accept. For a name
                    nothing matched, "confirm" would be confirming nothing.
                  */}
                  {d.playerId != null ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onOverride(d.needle, d.playerId as number)}
                    >
                      <Check />
                      Confirm {d.playerName}
                    </Button>
                  ) : null}
                  <Select value={null} onValueChange={(v) => v && onOverride(d.needle, Number(v))}>
                    <SelectTrigger size="sm" className="w-56">
                      <SelectValue placeholder="Choose a player…" />
                    </SelectTrigger>
                    <SelectContent>
                      {roster.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.fullName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DryRunReport({
  plan,
  timeZone,
  roster,
  overrides,
  onOverride,
  onRerun,
  busy,
}: {
  plan: PlanResponse;
  timeZone: string;
  roster: RosterPlayer[];
  overrides: Record<string, number>;
  onOverride: (needle: string, playerId: number | null) => void;
  onRerun: () => void;
  busy: boolean;
}) {
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
                  will be skipped. Settle any player decisions below, fix the rest in the sheet and
                  dry run again, or commit without them.
                </li>
              ) : null}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <DecisionPanel
        plan={plan}
        roster={roster}
        overrides={overrides}
        onOverride={onOverride}
        onRerun={onRerun}
        busy={busy}
      />

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
          {/*
            §9.2: stated on its own line rather than folded into the tail below,
            because re-uploading a cumulative export is the normal round 2
            workflow and "12 registrations" over a file that writes none of them
            reads as success. The number that matters is how many are new.
          */}
          {plan.counts.skippedParties > 0 ? (
            <p className="mt-1 text-sm font-medium tabular-nums">
              {plan.counts.skippedParties} already imported ·{' '}
              {plan.counts.parties - plan.counts.skippedParties} new
            </p>
          ) : null}
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
            · {seatsConsumed} of {plan.openSeats} open seats, extras pool{' '}
            {plan.extrasPool}
          </p>
          {/*
            What the engine is predicted to do — the line that distinguishes "the
            file fits" from "the file will be granted". Without it a clean dry run
            can be followed by an entirely waitlisted party under a success banner.
          */}
          <p className="mt-2 text-sm">
            <span className="font-medium">{plan.counts.predictedConfirmed} confirm</span>
            {plan.counts.predictedPending > 0
              ? ` · ${plan.counts.predictedPending} held for review`
              : ''}
            {plan.counts.predictedWaitlisted > 0 ? (
              <span className="text-destructive">
                {' '}
                · {plan.counts.predictedWaitlisted} waitlist
              </span>
            ) : null}
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
            { header: 'Player', value: (r) => r.player },
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
