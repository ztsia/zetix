'use client';

import { useMemo, useState } from 'react';
import { UserPlus, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { DataTable, DataTableColumnHeader, type DataTableColumn } from '@/components/data-table';
import { formatInZone } from '@/lib/export';
import { ActionDialog } from '../../action-dialog';
import { createOperatorAction } from './actions';
import type { IssuedCode, OperatorFormState } from './form-state';
import { AccessCodeDialog } from './access-code-dialog';
import { OperatorRowActions } from './operator-row-actions';

export type ShowOption = { id: number; name: string; startsAt: string | null };

export type OperatorRow = {
  id: string;
  displayName: string;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  assignedShowIds: number[];
  checkInCount: number;
};

/**
 * The operator console (spec/admin.md §14.3 "Provisioning operators").
 *
 * One screen covers the whole lifecycle an usher has: created, given a code,
 * rostered onto shows, and — when they hand the phone back — deactivated. There
 * are about six of them (context.md §6 question 7), so this is a table with row
 * actions rather than a detail page each.
 */
export function OperatorsScreen({
  concertId,
  concertName,
  timeZone,
  shows,
  operators,
}: {
  concertId: number;
  concertName: string;
  timeZone: string;
  shows: ShowOption[];
  operators: OperatorRow[];
}) {
  /**
   * The code just minted, held only long enough to show it once
   * (spec/admin.md §14.3).
   *
   * It is never persisted anywhere readable — the database holds a hash, and it
   * is deliberately kept out of `audit_log`. Closing the dialog is the last time
   * anyone sees it, and the way out is to issue another.
   */
  const [issued, setIssued] = useState<IssuedCode | null>(null);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Operators</h1>
          <p className="text-muted-foreground text-sm">
            One account per usher for {concertName}. They sign in at{' '}
            <code className="text-foreground">/scan</code> with their display name and access
            code, and reach only the shows assigned to them.
          </p>
        </div>

        <ActionDialog
          trigger={
            <Button>
              <UserPlus />
              Add operator
            </Button>
          }
          title="Add an operator"
          description="They will sign in with this name and a code generated for them."
          submitLabel="Create and show code"
          pendingLabel="Creating…"
          action={(formData) => createOperatorAction({ error: null }, formData)}
          // The success carries the one and only copy of the access code, which
          // is exactly why `ActionDialog` grew this callback (module `B`).
          onSuccess={(result) => {
            const code = (result as OperatorFormState).issued;
            if (code) setIssued(code);
          }}
        >
          <FieldGroup>
            <input type="hidden" name="concertId" value={concertId} />
            <Field>
              <FieldLabel htmlFor="displayName">Display name</FieldLabel>
              <Input
                id="displayName"
                name="displayName"
                required
                autoFocus
                maxLength={120}
                autoComplete="off"
                placeholder="Wei Ling"
              />
              <FieldDescription>
                Exactly what the usher types at sign-in, so use the name they will remember. Two
                ushers whose names reduce to the same sign-in name need something to tell them
                apart — a surname or an initial.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </ActionDialog>
      </header>

      {operators.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>No operators yet</EmptyTitle>
            <EmptyDescription>
              Add one per usher working the door. Each gets an access code you show them once,
              and you choose which shows they can scan.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <OperatorsTable
          concertId={concertId}
          timeZone={timeZone}
          shows={shows}
          operators={operators}
          onIssued={setIssued}
        />
      )}

      <AccessCodeDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

/**
 * Which operators the table shows.
 *
 * **Deactivated ushers are hidden by default.** There is no delete on this
 * screen and there deliberately is not one: handing the phone back is a
 * deactivation (spec/admin.md §14.3), and `check_ins.operator_id` is
 * `on delete set null`, so removing the row would anonymise every scan that
 * usher recorded. The consequence is a list that only ever grows — accounts are
 * global, so it accumulates across every concert anyone has worked — and a
 * roster of six live ushers would end up being read past rather than read.
 *
 * Hiding them is a default, not a policy. The filter carries the count of each
 * group so that "are there deactivated accounts?" is answered without switching
 * to find out, and reactivating one is two clicks away rather than hidden.
 */
type StatusFilter = 'active' | 'inactive' | 'all';

function OperatorsTable({
  concertId,
  timeZone,
  shows,
  operators,
  onIssued,
}: {
  concertId: number;
  timeZone: string;
  shows: ShowOption[];
  operators: OperatorRow[];
  onIssued: (issued: IssuedCode) => void;
}) {
  const showsById = useMemo(() => new Map(shows.map((show) => [show.id, show])), [shows]);

  const [status, setStatus] = useState<StatusFilter>('active');

  const counts = useMemo(() => {
    const active = operators.filter((operator) => operator.isActive).length;
    return { active, inactive: operators.length - active, all: operators.length };
  }, [operators]);

  const visible = useMemo(
    () =>
      status === 'all'
        ? operators
        : operators.filter((operator) => operator.isActive === (status === 'active')),
    [operators, status],
  );

  const columns: DataTableColumn<OperatorRow>[] = useMemo(
    () => [
      {
        accessorKey: 'displayName',
        meta: { label: 'Name' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <div className="font-medium">{row.original.displayName}</div>
            {/* The synthetic address is an implementation detail the operator
                never sees or types (spec/checkin.md §12.1) — but the admin needs
                it to find them in Supabase's own user list. */}
            <div className="text-muted-foreground text-xs">{row.original.email}</div>
          </div>
        ),
      },
      {
        accessorKey: 'isActive',
        meta: { label: 'Status' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) =>
          row.original.isActive ? (
            <Badge variant="secondary">Active</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Deactivated
            </Badge>
          ),
      },
      {
        id: 'shows',
        meta: { label: 'Assigned shows' },
        enableSorting: false,
        header: 'Assigned shows',
        cell: ({ row }) => {
          const assigned = row.original.assignedShowIds;
          if (assigned.length === 0) {
            // Not an error state: an account created but not yet rostered is
            // correct, and the operator simply sees an empty show list
            // (spec/domain.md §5.1).
            return <span className="text-muted-foreground text-sm">None yet</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {assigned.map((id) => (
                <Badge key={id} variant="outline">
                  {showsById.get(id)?.name ?? `Show ${id}`}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: 'checkInCount',
        meta: { label: 'Check-ins' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Check-ins" />,
        cell: ({ row }) => <span className="tabular-nums">{row.original.checkInCount}</span>,
      },
      {
        accessorKey: 'lastLoginAt',
        meta: { label: 'Last sign-in' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last sign-in" />,
        cell: ({ row }) =>
          row.original.lastLoginAt ? (
            <span className="text-sm tabular-nums">
              {formatInZone(new Date(row.original.lastLoginAt), timeZone)}
            </span>
          ) : (
            // Worth showing plainly: an usher who has never signed in is the one
            // to chase before the doors open, not after.
            <span className="text-muted-foreground text-sm">Never</span>
          ),
      },
      {
        id: 'actions',
        enableHiding: false,
        enableSorting: false,
        meta: { label: 'Actions' },
        header: '',
        cell: ({ row }) => (
          <OperatorRowActions
            concertId={concertId}
            operator={row.original}
            shows={shows}
            onIssued={onIssued}
          />
        ),
      },
    ],
    [concertId, onIssued, shows, showsById, timeZone],
  );

  /**
   * The empty state has to say which filter emptied it, or "No operators" reads
   * as "you have not created any" on a screen where six of them exist and are
   * simply deactivated. `all` cannot be empty here — the parent renders its own
   * empty card when nobody is provisioned at all.
   */
  const empty =
    status === 'inactive'
      ? {
          title: 'No deactivated operators',
          description: 'Everyone provisioned for this concert is still active.',
        }
      : {
          title: 'No active operators',
          description:
            'Every operator has been deactivated. Switch this filter to All to see them, ' +
            'and reactivate whoever is working the door.',
        };

  return (
    <DataTable
      columns={columns}
      data={visible}
      getRowId={(row) => row.id}
      searchPlaceholder="Search operators…"
      emptyTitle={empty.title}
      emptyDescription={empty.description}
      emptyFilteredDescription="No operator matches this search."
      toolbar={
        <NativeSelect
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
          aria-label="Filter by status"
          className="w-auto"
        >
          <option value="active">Active ({counts.active})</option>
          <option value="inactive">Deactivated ({counts.inactive})</option>
          <option value="all">All ({counts.all})</option>
        </NativeSelect>
      }
    />
  );
}
