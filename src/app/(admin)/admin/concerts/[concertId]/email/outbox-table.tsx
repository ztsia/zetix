'use client';

import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ActionDialog } from '../../../concerts/action-dialog';
import { editMessageAction } from './actions';

export type OutboxRow = {
  id: number;
  toEmail: string;
  toName: string | null;
  subject: string;
  bodyMd: string;
  status: 'DRAFT' | 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
};

const TONE: Record<OutboxRow['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  QUEUED: 'secondary',
  SENDING: 'secondary',
  SENT: 'default',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

/**
 * The review list of §11.5 — "the admin then sees the actual messages, not a
 * template and a promise".
 *
 * Rendered from `subject` and `body_md` on the row itself, which is what the
 * dispatcher will send verbatim. Showing a re-render of the template here would
 * defeat the point: the whole guarantee is that what is reviewed is what goes
 * out.
 */
export function OutboxTable({ rows, timezone }: { rows: OutboxRow[]; timezone: string }) {
  const columns: DataTableColumn<OutboxRow>[] = [
    {
      accessorKey: 'toName',
      header: 'To',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.original.toName ?? '—'}</div>
          <div className="text-muted-foreground truncate text-xs">{row.original.toEmail}</div>
        </div>
      ),
    },
    {
      accessorKey: 'subject',
      header: 'Subject',
      cell: ({ row }) => <span className="line-clamp-2">{row.original.subject}</span>,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant={TONE[row.original.status]}>{row.original.status}</Badge>,
    },
    {
      accessorKey: 'sentAt',
      header: 'Sent',
      cell: ({ row }) =>
        row.original.sentAt
          ? new Intl.DateTimeFormat('en-GB', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: timezone,
            }).format(new Date(row.original.sentAt))
          : '—',
    },
    {
      accessorKey: 'lastError',
      header: 'Last error',
      cell: ({ row }) =>
        row.original.lastError ? (
          // Rendered whole rather than truncated: a send failure names the
          // reason and the reason is the actionable part.
          <span className="text-destructive text-xs whitespace-pre-wrap">
            {row.original.lastError}
            {row.original.attempts > 0 ? ` (attempt ${row.original.attempts})` : ''}
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => <EditMessageDialog row={row.original} />,
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => String(row.id)}
      searchPlaceholder="Search recipient or subject…"
      emptyTitle="No messages yet"
      emptyDescription="Prepare a blast above and the drafted messages appear here for review."
      emptyFilteredDescription="No message matches that search."
      initialPageSize={25}
    />
  );
}

/**
 * One dialog per row rather than a single controlled one.
 *
 * `ActionDialog` is trigger-driven and has no controlled `open`. Giving it one
 * would be an edit to a component owned by module `A`, which modules.md §4 asks
 * for a reason for — and a table of twenty-five rows is not one. Modules `A`
 * and `B` compose it this way too.
 */
function EditMessageDialog({ row }: { row: OutboxRow }) {
  /**
   * Only a DRAFT can be edited. Once a batch is QUEUED the dispatcher owns it,
   * and editing underneath would send something other than what was confirmed
   * (§11.5). The action re-checks this; the disabled button is the courtesy.
   */
  if (row.status !== 'DRAFT') {
    return (
      <Button variant="ghost" size="sm" disabled>
        Read / edit
      </Button>
    );
  }

  return (
    <ActionDialog
      trigger={
        <Button variant="ghost" size="sm">
          Read / edit
        </Button>
      }
      title={`Message to ${row.toName ?? row.toEmail}`}
      description="Editing one message affects only this recipient, and it is then left alone by a later template re-render (§11.5)."
      submitLabel="Save message"
      pendingLabel="Saving…"
      action={editMessageAction}
    >
      <input type="hidden" name="outboxId" value={row.id} />
      <Field>
        <FieldLabel htmlFor={`subject-${row.id}`}>Subject</FieldLabel>
        <Input id={`subject-${row.id}`} name="subject" defaultValue={row.subject} required />
      </Field>
      <Field>
        <FieldLabel htmlFor={`body-${row.id}`}>Body (Markdown)</FieldLabel>
        <Textarea id={`body-${row.id}`} name="bodyMd" defaultValue={row.bodyMd} rows={16} required />
      </Field>
    </ActionDialog>
  );
}
