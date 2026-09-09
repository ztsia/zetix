'use client';

import { useState } from 'react';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ActionDialog } from '../../../../concerts/action-dialog';
import { markDeliveredAction, resendTicketsAction } from '../actions';
import { RESEND_PHRASE } from '../confirmation';

export type DeliveryRow = {
  id: number;
  fullName: string;
  contactName: string | null;
  contactEmail: string;
  showName: string;
  segmentName: string;
  ticketCode: string | null;
  ticketSentAt: string | null;
  ticketSentSource: 'EMAIL' | 'MANUAL' | null;
};

/**
 * §11.6 "Mark as delivered" and §11.4's explicit resend, which are exact
 * inverses of one another.
 *
 * Both act on the current selection, and both require a reason that lands in
 * `audit_log`. Together they are what makes the pending count on the blast
 * screen "a real, actionable number rather than a residue of edge cases":
 * without marking, a ticket handed over at a rehearsal reappears in every
 * future blast for ever.
 */
export function DeliveryTable({ rows, timezone }: { rows: DeliveryRow[]; timezone: string }) {
  const [selected, setSelected] = useState<DeliveryRow[]>([]);

  const columns: DataTableColumn<DeliveryRow>[] = [
    { accessorKey: 'fullName', header: 'Attendee' },
    {
      accessorKey: 'contactName',
      header: 'Registration',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate">{row.original.contactName ?? '—'}</div>
          <div className="text-muted-foreground truncate text-xs">{row.original.contactEmail}</div>
        </div>
      ),
    },
    { accessorKey: 'showName', header: 'Show' },
    { accessorKey: 'ticketCode', header: 'Ticket', cell: ({ row }) => row.original.ticketCode ?? '—' },
    {
      accessorKey: 'ticketSentAt',
      header: 'Delivered',
      cell: ({ row }) =>
        row.original.ticketSentAt ? (
          <div className="flex items-center gap-2">
            <Badge variant={row.original.ticketSentSource === 'MANUAL' ? 'outline' : 'default'}>
              {row.original.ticketSentSource}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {new Intl.DateTimeFormat('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: timezone,
              }).format(new Date(row.original.ticketSentAt))}
            </span>
          </div>
        ) : (
          <Badge variant="secondary">Pending</Badge>
        ),
    },
  ];

  const ids = JSON.stringify(selected.map((row) => row.id));
  const undelivered = selected.filter((row) => row.ticketSentAt === null).length;
  const delivered = selected.length - undelivered;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ActionDialog
          trigger={<Button disabled={undelivered === 0}>Mark {undelivered} as delivered</Button>}
          title={`Mark ${undelivered} ticket(s) delivered by hand`}
          description="This records a delivery that happened outside the system — a forwarded PDF, a printout at a rehearsal. It sends nothing."
          submitLabel="Mark delivered"
          pendingLabel="Recording…"
          action={markDeliveredAction}
        >
          <input type="hidden" name="attendeeIds" value={ids} />
          <Field>
            <FieldLabel htmlFor="markReason">Reason</FieldLabel>
            <Textarea id="markReason" name="reason" rows={3} required placeholder="Handed over at the Tuesday rehearsal" />
            <FieldDescription>
              Recorded in the audit log. Tickets already delivered by email are left as they are.
            </FieldDescription>
          </Field>
        </ActionDialog>

        <ActionDialog
          trigger={
            <Button variant="destructive" disabled={delivered === 0}>
              Resend {delivered} ticket(s)
            </Button>
          }
          title={`Resend ${delivered} ticket(s)`}
          description="This clears the delivery stamp so the next blast includes these parties again. Used when someone has deleted their email."
          submitLabel="Confirm resend"
          pendingLabel="Clearing…"
          submitVariant="destructive"
          action={resendTicketsAction}
        >
          <input type="hidden" name="attendeeIds" value={ids} />
          <Field>
            <FieldLabel htmlFor="resendReason">Reason</FieldLabel>
            <Textarea id="resendReason" name="reason" rows={3} required placeholder="Registrant deleted the email" />
          </Field>
          <Field>
            <FieldLabel htmlFor="confirmation">
              Type {RESEND_PHRASE} to confirm
            </FieldLabel>
            <Input id="confirmation" name="confirmation" autoComplete="off" required />
            <FieldDescription>
              §11.4 makes this deliberate rather than a default path — a resend re-sends real email.
            </FieldDescription>
          </Field>
        </ActionDialog>

        <span className="text-muted-foreground text-sm">
          {selected.length} selected
        </span>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => String(row.id)}
        enableSelection
        onSelectionChange={setSelected}
        searchPlaceholder="Search attendee or registrant…"
        emptyTitle="No attendees yet"
        emptyDescription="Attendees appear here once registrations exist for this concert."
        emptyFilteredDescription="No attendee matches that search."
        initialPageSize={25}
      />
    </div>
  );
}
