'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, Info, TriangleAlert, Undo2, Upload } from 'lucide-react';
import { useCanEdit } from '@/components/auth/role';
import {
  DataTable,
  filterKeyOf,
  selectionColumn,
  useTableSelection,
  useUrlTableState,
  type DataTableColumn,
  type UrlTableState,
} from '@/components/data-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { RowIssue, StagedField } from '@/lib/import/staging';
import type { BatchSummary, StagedRow, StagingView } from '@/lib/import/staging-queries';
import { CommandDialog } from '../../commands/command-dialog';
import { setExistingActionAction, updateStagedCellAction } from './actions';

const VIEW_LABEL: Record<StagingView, string> = {
  all: 'All rows',
  ready: 'Ready',
  'needs-fixing': 'Needs fixing',
  committed: 'Committed',
  skipped: 'Skipped',
};

const LEVEL_ICON = { BLOCKING: CircleAlert, WARNING: TriangleAlert, INFO: Info } as const;
const LEVEL_CLASS = {
  BLOCKING: 'text-destructive',
  WARNING: 'text-amber-600 dark:text-amber-400',
  INFO: 'text-muted-foreground',
} as const;

/**
 * The staging grid (spec/v3.md §25.7): the file as rows, one per seat,
 * grouped by party. Issues sit on their cell and in the Issues column; a
 * staged row's cells are edited in place, which re-validates the batch. The
 * ready parties commit — all of them, or the ones ticked — and what needs
 * fixing stays for another pass.
 */
export function StagingGrid({
  concertId,
  timeZone,
  summary,
  view,
  state,
  page,
  roster,
}: {
  concertId: number;
  timeZone: string;
  summary: BatchSummary;
  view: StagingView;
  state: UrlTableState;
  page: { rows: StagedRow[]; total: number };
  roster: { id: number; name: string }[];
}) {
  const router = useRouter();
  const canEdit = useCanEdit();
  const { server, setExtra, isPending } = useUrlTableState(state, page.total);
  const [error, setError] = React.useState<string | null>(null);
  const open = summary.status === 'STAGED';
  const players = summary.audienceMode === 'PLAYER_INVITED' && roster.length > 0;

  const { selection, count, clear, tableProps } = useTableSelection({
    filter: { batchId: summary.id },
    filterKey: filterKeyOf(state),
    total: page.total,
    pageIds: page.rows.map((row) => String(row.id)),
  });

  const save = React.useCallback(
    async (row: StagedRow, field: StagedField, value: string | null) => {
      setError(null);
      const result = await updateStagedCellAction({ concertId, batchId: summary.id, rowId: row.id, field, value });
      if (!result.ok) setError(result.error);
      router.refresh();
    },
    [concertId, summary.id, router],
  );

  const format = React.useMemo(
    () => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }),
    [timeZone],
  );

  const columns = React.useMemo<DataTableColumn<StagedRow>[]>(() => {
    const editable = (row: StagedRow) => canEdit && open && row.status === 'STAGED';
    const cell = (row: StagedRow, field: StagedField, value: string | null, placeholder: string) => (
      <EditableCell
        value={value}
        placeholder={placeholder}
        invalid={issueOn(row.issues, field)}
        disabled={!editable(row)}
        onSave={(next) => save(row, field, next)}
      />
    );
    return [
      selectionColumn<StagedRow>(),
      {
        id: 'row',
        header: 'Row',
        cell: ({ row }) => (
          <span className="text-muted-foreground tabular-nums">
            {row.original.rowNumber}
            {row.original.seatIndex > 0 ? `.${row.original.seatIndex}` : ''}
          </span>
        ),
      },
      {
        id: 'contact',
        header: 'Contact',
        cell: ({ row }) => (
          <div className="flex min-w-48 flex-col gap-1">
            {cell(row.original, 'contactName', row.original.fields.contactName, 'Contact name')}
            {cell(row.original, 'contactEmail', row.original.fields.contactEmail, 'Email')}
          </div>
        ),
      },
      {
        id: 'requested',
        header: 'Requested',
        cell: ({ row }) => {
          const f = row.original.fields;
          return (
            <EditableCell
              value={f.requestedAt ? format.format(new Date(f.requestedAt)) : f.requestedAtRaw}
              editValue={f.requestedAt ?? f.requestedAtRaw}
              placeholder="File order"
              invalid={issueOn(row.original.issues, 'requestedAt')}
              disabled={!editable(row.original)}
              onSave={(next) => save(row.original, 'requestedAt', next)}
            />
          );
        },
      },
      {
        id: 'guest',
        header: 'Guest',
        cell: ({ row }) => (
          <div className="flex min-w-44 flex-col gap-1">
            {cell(row.original, 'attendeeName', row.original.fields.attendeeName, 'Unnamed')}
            {cell(row.original, 'attendeeEmail', row.original.fields.attendeeEmail, 'No email')}
          </div>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }) => {
          const f = row.original.fields;
          return (
            <NativeSelect
              size="sm"
              aria-label="Seat type"
              aria-invalid={issueOn(row.original.issues, 'allocationType') || undefined}
              value={f.allocationType ?? ''}
              disabled={!editable(row.original)}
              onChange={(event) => save(row.original, 'allocationType', event.target.value || null)}
            >
              {!f.allocationType && <NativeSelectOption value="">{f.allocationRaw ?? 'Choose'}</NativeSelectOption>}
              <NativeSelectOption value="BASE">Base</NativeSelectOption>
              <NativeSelectOption value="EXTRA">Extra</NativeSelectOption>
            </NativeSelect>
          );
        },
      },
      ...(players
        ? [
            {
              id: 'player',
              header: 'Player',
              cell: ({ row }: { row: { original: StagedRow } }) => {
                const r = row.original;
                if (!r.isHead) return <span className="text-muted-foreground text-xs">with party</span>;
                return (
                  <NativeSelect
                    size="sm"
                    aria-label="Inviting player"
                    aria-invalid={issueOn(r.issues, 'player') || undefined}
                    value={r.fields.playerId !== null && r.fields.playerConfirmed ? String(r.fields.playerId) : ''}
                    disabled={!editable(r)}
                    onChange={(event) => event.target.value && save(r, 'player', event.target.value)}
                  >
                    <NativeSelectOption value="">
                      {r.fields.playerId !== null && !r.fields.playerConfirmed
                        ? `${r.fields.playerName}? (confirm)`
                        : (r.fields.playerNeedle ?? 'Choose a player')}
                    </NativeSelectOption>
                    {roster.map((player) => (
                      <NativeSelectOption key={player.id} value={String(player.id)}>
                        {player.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                );
              },
            } satisfies DataTableColumn<StagedRow>,
          ]
        : []),
      {
        id: 'party',
        header: 'Party',
        cell: ({ row }) => {
          const r = row.original;
          if (!r.isHead) return null;
          return (
            <div className="flex min-w-40 flex-col gap-1 text-xs">
              <span className="text-muted-foreground">
                {r.partySize} seat{r.partySize === 1 ? '' : 's'}
              </span>
              {r.existing && r.status === 'STAGED' ? (
                <NativeSelect
                  size="sm"
                  aria-label={`What to do with ${r.existing.name}'s party`}
                  value={r.existingAction ?? 'ADD_SEATS'}
                  disabled={!editable(r)}
                  onChange={async (event) => {
                    setError(null);
                    const result = await setExistingActionAction({
                      concertId,
                      batchId: summary.id,
                      partyKey: r.partyKey,
                      action: event.target.value as 'ADD_SEATS' | 'SKIP' | 'SEPARATE',
                    });
                    if (!result.ok) setError(result.error);
                    router.refresh();
                  }}
                >
                  <NativeSelectOption value="ADD_SEATS">Add seats to {r.existing.name}</NativeSelectOption>
                  <NativeSelectOption value="SKIP">Skip</NativeSelectOption>
                  <NativeSelectOption value="SEPARATE">Keep separate</NativeSelectOption>
                </NativeSelect>
              ) : null}
              {r.registrationId ? (
                <Link
                  className="underline underline-offset-4"
                  href={`/admin/concerts/${concertId}/audience/${r.registrationId}`}
                >
                  Open party
                </Link>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'issues',
        header: 'Issues',
        cell: ({ row }) => <Issues row={row.original} />,
      },
    ];
  }, [canEdit, open, players, roster, save, format, concertId, summary.id, router]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{summary.filename}</h1>
          <p className="text-muted-foreground text-sm">
            Into {summary.segmentLabel} · staged {format.format(new Date(summary.createdAt))}
            {summary.queueReceipts ? ' · receipts on' : ''}
            {summary.status === 'UNDONE' ? ' · undone' : ''}
          </p>
        </div>
        {canEdit && summary.status !== 'UNDONE' && (
          <ButtonGroup>
            {open && (
              <CommandDialog
                concertId={concertId}
                command="intake.commit_rows"
                selection={{ filter: { batchId: summary.id }, excludedIds: [] }}
                onDone={clear}
                trigger={
                  <Button size="sm" disabled={summary.counts.readyParties === 0}>
                    <Upload data-icon="inline-start" />
                    Commit {summary.counts.readyParties} ready part{summary.counts.readyParties === 1 ? 'y' : 'ies'}
                  </Button>
                }
              />
            )}
            {summary.counts.committed > 0 && (
              <CommandDialog
                concertId={concertId}
                command="intake.undo_import"
                selection={{ ids: [summary.id] }}
                trigger={
                  <Button size="sm" variant="outline" className="text-destructive">
                    <Undo2 data-icon="inline-start" />
                    Undo import
                  </Button>
                }
              />
            )}
          </ButtonGroup>
        )}
      </div>

      {open && summary.counts.blockedParties > 0 ? (
        <Alert>
          <CircleAlert />
          <AlertTitle>
            {summary.counts.blockedParties} part{summary.counts.blockedParties === 1 ? 'y needs' : 'ies need'} fixing
          </AlertTitle>
          <AlertDescription>
            Edit the highlighted cells. The ready parties can be committed now; these stay staged until they are ready.
          </AlertDescription>
        </Alert>
      ) : open && summary.counts.readyParties > 0 ? (
        <Alert>
          <CircleCheck />
          <AlertTitle>Every staged party is ready</AlertTitle>
          <AlertDescription>Committing claims their seats first come first served, and they land in review.</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={view} onValueChange={(value: string) => setExtra('view', value)}>
        <TabsList variant="line">
          {(Object.keys(VIEW_LABEL) as StagingView[]).map((key) => (
            <TabsTrigger key={key} value={key}>
              {VIEW_LABEL[key]}
              <Badge variant={summary.counts[key] > 0 ? 'secondary' : 'outline'} className="tabular-nums">
                {summary.counts[key]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <DataTable
        key={view}
        columns={columns}
        data={page.rows}
        server={server}
        getRowId={(row) => String(row.id)}
        enableSelection={canEdit && open}
        {...tableProps}
        selectAllMatching={{ ...tableProps.selectAllMatching, noun: 'rows' }}
        isLoading={isPending}
        searchPlaceholder="Search names…"
        emptyTitle="Nothing here"
        emptyDescription={view === 'needs-fixing' ? 'No row needs fixing.' : 'No rows in this view.'}
        toolbar={
          canEdit && open ? (
            <CommandDialog
              concertId={concertId}
              command="intake.commit_rows"
              selection={selection}
              onDone={clear}
              trigger={
                <Button variant="outline" size="sm" disabled={count === 0}>
                  Commit the parties of {count > 0 ? count : ''} selected row{count === 1 ? '' : 's'}
                </Button>
              }
            />
          ) : null
        }
      />
    </div>
  );
}

function issueOn(issues: RowIssue[], field: StagedField): boolean {
  return issues.some((issue) => issue.field === field && issue.level !== 'INFO');
}

function Issues({ row }: { row: StagedRow }) {
  if (row.status === 'COMMITTED') return <Badge variant="secondary">Committed</Badge>;
  if (row.status === 'SKIPPED') return <Badge variant="outline">Skipped</Badge>;
  if (row.issues.length === 0) {
    return row.partyBlocked ? (
      <span className="text-muted-foreground text-xs">Waits for its party</span>
    ) : (
      <Badge variant="outline">Ready</Badge>
    );
  }
  return (
    <ul className="flex min-w-56 flex-col gap-1 text-xs">
      {row.issues.map((issue, index) => {
        const Icon = LEVEL_ICON[issue.level];
        return (
          <li key={index} className={cn('flex gap-1.5', LEVEL_CLASS[issue.level])}>
            <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{issue.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A cell that is text until clicked, then an input. Enter or leaving the
 * field saves; Escape puts it back. The save re-validates the batch, so the
 * row's issues redraw with the page.
 */
function EditableCell({
  value,
  editValue,
  placeholder,
  invalid,
  disabled,
  onSave,
}: {
  value: string | null;
  /** What the input starts with, when it differs from what is shown. */
  editValue?: string | null;
  placeholder?: string;
  invalid: boolean;
  disabled: boolean;
  onSave: (next: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const start = editValue === undefined ? value : editValue;

  if (editing) {
    return (
      <Input
        autoFocus
        className="h-7 text-sm"
        value={draft}
        disabled={busy}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(false);
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        onBlur={async () => {
          if (draft === (start ?? '')) return setEditing(false);
          setBusy(true);
          await onSave(draft === '' ? null : draft);
          setBusy(false);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setDraft(start ?? '');
        setEditing(true);
      }}
      className={cn(
        'rounded-sm px-1 py-0.5 text-left text-sm',
        !disabled && 'hover:bg-muted cursor-text',
        invalid && 'ring-destructive ring-1',
        value ? '' : 'text-muted-foreground italic',
      )}
    >
      {value ?? placeholder ?? '—'}
    </button>
  );
}
