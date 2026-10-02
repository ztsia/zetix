'use client';

import * as React from 'react';
import Link from 'next/link';
import { Ban, Repeat, RotateCw, Trash2 } from 'lucide-react';
import {
  DataTable,
  DataTableColumnHeader,
  filterKeyOf,
  selectionColumn,
  useTableSelection,
  useUrlTableState,
  type DataTableColumn,
  type UrlTableState,
} from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCanEdit } from '@/components/auth/role';
import type { MessageRow } from '@/lib/delivery/messages';
import {
  MESSAGE_STATUS_LABEL,
  MESSAGE_STATUSES,
  type MessageFilter,
  type MessageStatus,
} from '@/lib/delivery/message-filter';
import { PURPOSE_LABEL, PURPOSES, type Purpose } from '@/lib/delivery/purposes';
import { useRunCommand } from '../command-host';
import { MessageActions } from './message-actions';
import { exportMessagesAction } from './export-actions';

/**
 * The Messages view's table (spec/v3.md §24.4). A tab per status with its
 * count, a purpose filter, and the shared §22.3 selection: the bulk buttons
 * hand the command the filter when every matching row is selected, and the
 * server re-resolves it when the command runs. Each command skips, with the
 * reason, a message whose status has no such exit.
 */

type Page = { rows: MessageRow[]; total: number; counts: Record<MessageStatus, number> };

const STATUS_VARIANT: Record<MessageStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  DRAFT: 'outline',
  QUEUED: 'outline',
  SENDING: 'secondary',
  SENT: 'secondary',
  FAILED: 'destructive',
  BOUNCED: 'destructive',
  CANCELLED: 'outline',
};

const BULK: { command: string; label: string; icon: typeof Ban; when: MessageStatus[] | null }[] = [
  { command: 'messages.retry', label: 'Retry', icon: RotateCw, when: ['FAILED'] },
  { command: 'messages.resend', label: 'Resend', icon: Repeat, when: ['SENT', 'BOUNCED'] },
  { command: 'messages.cancel', label: 'Cancel', icon: Ban, when: ['DRAFT', 'QUEUED', 'FAILED'] },
  { command: 'messages.delete', label: 'Delete', icon: Trash2, when: null },
];

export function MessagesTable({
  concertId,
  timeZone,
  filter,
  state,
  page,
}: {
  concertId: number;
  timeZone: string;
  filter: MessageFilter;
  state: UrlTableState;
  page: Page;
}) {
  const canEdit = useCanEdit();
  const runCommand = useRunCommand();
  const { server, setExtra, isPending } = useUrlTableState(state, page.total);
  const { selection, count, clear, tableProps } = useTableSelection({
    filter,
    filterKey: filterKeyOf(state),
    total: page.total,
    pageIds: page.rows.map((row) => String(row.id)),
  });

  const columns = React.useMemo<DataTableColumn<MessageRow>[]>(() => {
    const format = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone });
    return [
      selectionColumn<MessageRow>(),
      {
        id: 'addressee',
        meta: { label: 'To' },
        header: ({ column }) => <DataTableColumnHeader column={column} title="To" />,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col">
            {row.original.registrationId ? (
              <Link
                href={`/admin/concerts/${concertId}/audience/${row.original.registrationId}`}
                className="truncate font-medium hover:underline"
              >
                {row.original.addressee}
              </Link>
            ) : (
              <span className="truncate font-medium">{row.original.addressee}</span>
            )}
            <span className="text-muted-foreground truncate text-xs">{row.original.toEmail}</span>
          </div>
        ),
      },
      {
        id: 'message',
        meta: { label: 'Message' },
        header: 'Message',
        enableSorting: false,
        cell: ({ row }) => {
          const m = row.original;
          return (
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{m.subject}</span>
              <span className="text-muted-foreground text-xs">
                {PURPOSE_LABEL[m.purpose]}
                {m.templateKey ? ` · ${m.templateKey}` : ''}
                {m.supersededById ? ' · replaced by a later message' : ''}
              </span>
              {m.status === 'FAILED' && m.lastError && (
                <span className="text-destructive line-clamp-2 text-xs">
                  After {m.attempts} attempt{m.attempts === 1 ? '' : 's'}: {m.lastError}
                </span>
              )}
              {m.status === 'BOUNCED' && (m.bounceCode || m.bounceDetail) && (
                <span className="text-destructive line-clamp-2 text-xs">
                  {[m.bounceCode, m.bounceDetail].filter(Boolean).join(' ')}
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: 'status',
        meta: { label: 'Status' },
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={STATUS_VARIANT[row.original.status]}>{MESSAGE_STATUS_LABEL[row.original.status]}</Badge>
        ),
      },
      {
        id: 'when',
        meta: { label: 'When' },
        header: 'When',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm tabular-nums">
            {format.format(new Date(row.original.sentAt ?? row.original.updatedAt))}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => (
          <MessageActions
            concertId={concertId}
            messageId={row.original.id}
            status={row.original.status}
            toParty={row.original.registrationId !== null}
          />
        ),
      },
    ];
  }, [concertId, timeZone]);

  const all = MESSAGE_STATUSES.reduce((n, s) => n + page.counts[s], 0);
  const bulk = BULK.filter((b) => b.when === null || !filter.status || b.when.includes(filter.status));

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={filter.status ?? 'all'} onValueChange={(value: string) => setExtra('status', value === 'all' ? '' : value)}>
        <TabsList variant="line" className="flex-wrap">
          <TabsTrigger value="all">
            All
            <Badge variant="secondary" className="tabular-nums">
              {all}
            </Badge>
          </TabsTrigger>
          {MESSAGE_STATUSES.map((s) => (
            <TabsTrigger key={s} value={s}>
              {MESSAGE_STATUS_LABEL[s]}
              <Badge
                variant={page.counts[s] > 0 && (s === 'FAILED' || s === 'BOUNCED') ? 'destructive' : page.counts[s] > 0 ? 'secondary' : 'outline'}
                className="tabular-nums"
              >
                {page.counts[s]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <DataTable
        columns={columns}
        data={page.rows}
        server={server}
        getRowId={(row) => String(row.id)}
        enableSelection={canEdit}
        {...tableProps}
        selectAllMatching={{ ...tableProps.selectAllMatching, noun: 'messages' }}
        isLoading={isPending}
        searchPlaceholder={canEdit ? 'Search subject, name, address or id…' : 'Search subject, name or id…'}
        emptyTitle="No messages here"
        emptyDescription="Messages appear once tickets, reminders or any other email is queued for this concert."
        export={{
          filename: filter.status ? `messages-${filter.status.toLowerCase()}` : 'messages',
          sheetName: 'Messages',
          timeZone,
          load: () =>
            exportMessagesAction({
              concertId,
              selection: selection ?? { filter, excludedIds: [] },
            }),
          columns: [
            { header: 'To', value: (r: MessageRow) => r.toEmail, width: 30 },
            { header: 'Name', value: (r: MessageRow) => r.addressee, width: 24 },
            { header: 'Purpose', value: (r: MessageRow) => PURPOSE_LABEL[r.purpose] },
            { header: 'Subject', value: (r: MessageRow) => r.subject, width: 40 },
            { header: 'Status', value: (r: MessageRow) => r.status },
            { header: 'Attempts', value: (r: MessageRow) => r.attempts },
            { header: 'Bounce code', value: (r: MessageRow) => r.bounceCode },
            { header: 'Bounce detail', value: (r: MessageRow) => r.bounceDetail, width: 40 },
            { header: 'Last error', value: (r: MessageRow) => r.lastError, width: 40 },
            { header: 'Sent', value: (r: MessageRow) => (r.sentAt ? new Date(r.sentAt) : null) },
            { header: 'Updated', value: (r: MessageRow) => new Date(r.updatedAt) },
          ],
        }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              aria-label="Filter by purpose"
              size="sm"
              value={filter.purpose ?? ''}
              onChange={(event) => setExtra('purpose', event.target.value)}
            >
              <NativeSelectOption value="">Every purpose</NativeSelectOption>
              {PURPOSES.map((p: Purpose) => (
                <NativeSelectOption key={p} value={p}>
                  {PURPOSE_LABEL[p]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {canEdit && (
              <ButtonGroup>
                {bulk.map((b) => (
                  <Button
                    key={b.command}
                    variant="outline"
                    size="sm"
                    disabled={count === 0 || !selection}
                    className={b.command === 'messages.delete' ? 'text-destructive' : undefined}
                    onClick={() => selection && runCommand({ command: b.command, selection, onDone: clear })}
                  >
                    <b.icon data-icon="inline-start" />
                    {b.label}
                    {count > 0 ? ` ${count}` : ''}
                  </Button>
                ))}
              </ButtonGroup>
            )}
          </div>
        }
      />
    </div>
  );
}
