'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, KeyRound, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DataTable,
  DataTableColumnHeader,
  selectionColumn,
  type DataTableColumn,
} from '@/components/data-table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ExportColumn } from '@/lib/export';
import { DeleteButton } from '../shows/delete-button';
import { PlayerFormDialog } from './player-form-dialog';
import {
  deletePlayerAction,
  rotateInviteTokenAction,
  setPlayerActiveAction,
} from './actions';

export type PlayerRow = {
  id: number;
  fullName: string;
  email: string | null;
  instrument: string | null;
  section: string | null;
  isActive: boolean;
  inviteToken: string;
};

/**
 * The player list (spec/admin.md §14.1).
 *
 * Client mode, not server mode: `context.md` puts this concert at ~80 players
 * and not more than 100, so the whole list fits in one page and sorting or
 * filtering it in the browser is instant. Registrations and the scan log are the
 * tables that need server paging (modules.md §5.2.1) — this one would pay a
 * round trip per keystroke for nothing.
 */
export function PlayersTable({
  concertId,
  players,
  appUrl,
}: {
  concertId: number;
  players: PlayerRow[];
  /** Null when APP_URL is unset — the copy button is hidden rather than broken. */
  appUrl: string | null;
}) {
  const columns: DataTableColumn<PlayerRow>[] = [
    selectionColumn<PlayerRow>(),
    {
      accessorKey: 'fullName',
      meta: { label: 'Name' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => <span className="font-medium">{row.original.fullName}</span>,
    },
    {
      accessorKey: 'email',
      meta: { label: 'Email' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
      cell: ({ row }) =>
        row.original.email ?? <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: 'instrument',
      meta: { label: 'Instrument' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Instrument" />,
      cell: ({ row }) =>
        row.original.instrument ?? <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: 'section',
      meta: { label: 'Section' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Section" />,
      cell: ({ row }) =>
        row.original.section ?? <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: 'isActive',
      meta: { label: 'Status' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => (
        <Badge variant={row.original.isActive ? 'default' : 'outline'}>
          {row.original.isActive ? 'active' : 'inactive'}
        </Badge>
      ),
    },
    {
      id: 'actions',
      enableHiding: false,
      enableSorting: false,
      meta: { label: 'Actions' },
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <PlayerRowActions concertId={concertId} player={row.original} appUrl={appUrl} />
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={players}
      getRowId={(row) => String(row.id)}
      searchPlaceholder="Search players…"
      enableSelection
      export={{
        filename: 'players',
        columns: exportColumns,
        // The concert's zone would matter if this table carried a timestamp.
        // It carries none, so nothing here is zone-dependent.
        timeZone: 'UTC',
        sheetName: 'Players',
      }}
      emptyTitle="No players yet"
      emptyDescription="Add them one at a time, or import the section list as a CSV."
    />
  );
}

/**
 * The invite token is deliberately **not** an export column.
 *
 * It is a live credential: anyone holding the URL can claim that player's
 * seats. A spreadsheet of eighty of them is the kind of file that gets emailed
 * around, and there is no reason a roster export needs to carry it.
 */
const exportColumns: ExportColumn<PlayerRow>[] = [
  { header: 'Name', value: (row) => row.fullName, width: 28 },
  { header: 'Email', value: (row) => row.email, width: 28 },
  { header: 'Instrument', value: (row) => row.instrument },
  { header: 'Section', value: (row) => row.section },
  { header: 'Active', value: (row) => (row.isActive ? 'yes' : 'no') },
];

function PlayerRowActions({
  concertId,
  player,
  appUrl,
}: {
  concertId: number;
  player: PlayerRow;
  appUrl: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const inviteUrl = appUrl
    ? `${appUrl.replace(/\/+$/, '')}/invite/${player.inviteToken}`
    : null;

  function run(action: () => Promise<{ error: string | null }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard write can be refused outright (no permission, an insecure
      // origin). Saying so beats a button that silently does nothing.
      setError('Could not reach the clipboard. Copy the link from the player’s form.');
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {error && (
        <Alert variant="destructive" role="alert" className="mr-2 max-w-md py-1.5">
          <AlertTitle className="text-xs leading-relaxed font-normal whitespace-pre-wrap">
            {error}
          </AlertTitle>
        </Alert>
      )}

      {inviteUrl && (
        <Button
          variant="ghost"
          size="icon"
          onClick={copyInvite}
          aria-label={`Copy invite link for ${player.fullName}`}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Actions for ${player.fullName}`}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() =>
              run(() => setPlayerActiveAction(concertId, player.id, !player.isActive))
            }
            disabled={isPending}
          >
            {player.isActive ? <X /> : <Check />}
            {player.isActive ? 'Deactivate' : 'Reactivate'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => run(() => rotateInviteTokenAction(concertId, player.id))}
            disabled={isPending}
          >
            <KeyRound />
            Rotate invite link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PlayerFormDialog
        concertId={concertId}
        player={player}
        trigger={
          <Button variant="ghost" size="icon" aria-label={`Edit ${player.fullName}`}>
            <Pencil />
          </Button>
        }
      />

      <DeleteButton
        trigger={
          <Button variant="ghost" size="icon" aria-label={`Remove ${player.fullName}`}>
            <Trash2 />
          </Button>
        }
        title={`Remove ${player.fullName}?`}
        description="Their entitlement to invite guests goes with them. Registrations already made in their name are kept."
        confirmLabel="Remove player"
        action={() => deletePlayerAction(concertId, player.id)}
      />
    </div>
  );
}
