import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { FileSpreadsheet, Plus } from 'lucide-react';
import { getDb } from '@/db/client';
import { players } from '@/db/schema/people';
import { Button } from '@/components/ui/button';
import { getConcertHeader } from '../shows/queries';
import { PlayerImportDialog } from './import-dialog';
import { PlayerFormDialog } from './player-form-dialog';
import { PlayersTable, type PlayerRow } from './players-table';

export const metadata: Metadata = { title: 'Players' };

/**
 * Spreadsheet parsing is a native Node concern — the import Server Actions on
 * this page reach `exceljs` (CLAUDE.md, spec/platform.md §16.1).
 */
export const runtime = 'nodejs';

/**
 * `/admin/concerts/{id}/players` — the performers (spec/admin.md §14.1).
 *
 * Players are scoped to a concert, hold no account, and consume no seat in the
 * player segment of their own show — they are on stage (decision 3). What each
 * one holds is an entitlement to invite guests, which is what the base quota
 * counts and what the §7.4 guard protects.
 */
export default async function PlayersPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const rows: PlayerRow[] = await getDb()
    .select({
      id: players.id,
      fullName: players.fullName,
      email: players.email,
      instrument: players.instrument,
      section: players.section,
      isActive: players.isActive,
      inviteToken: players.inviteToken,
    })
    .from(players)
    .where(and(eq(players.concertId, concertId), isNull(players.deletedAt)))
    .orderBy(asc(players.section), asc(players.fullName));

  const active = rows.filter((row) => row.isActive).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Players</h1>
          <p className="text-muted-foreground text-sm">
            {rows.length === 0
              ? 'Nobody yet.'
              : `${rows.length} player${rows.length === 1 ? '' : 's'}, ${active} active — each active one is entitled to the base quota of every player-invited segment.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <PlayerImportDialog
            concertId={concertId}
            trigger={
              <Button variant="outline">
                <FileSpreadsheet />
                Import CSV
              </Button>
            }
          />
          <PlayerFormDialog
            concertId={concertId}
            trigger={
              <Button>
                <Plus />
                New player
              </Button>
            }
          />
        </div>
      </div>

      <PlayersTable concertId={concertId} players={rows} />
    </div>
  );
}
