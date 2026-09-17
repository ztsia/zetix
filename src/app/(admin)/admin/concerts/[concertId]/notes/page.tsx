import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/guards';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NotesBoard } from './notes-board';
import { PlayerGroups } from './player-groups';
import { loadNotesScreen } from './queries';

export const metadata: Metadata = { title: 'Notes' };

/**
 * `/admin/concerts/{id}/notes` — §14.2's "primary post-concert artefact".
 *
 * **Two views of one table, because they are two jobs.** *All notes* is triage:
 * read what came in, approve or hide it, and decide what goes on the wall.
 * *By player* is preparation: what does each player get told the audience said,
 * and queue it. Tabs rather than two screens — an admin moves between them
 * constantly, and the second is only meaningful once the first has been done.
 *
 * **The grouped view is admin-only, always** (decision 6). It is here, behind
 * `requireAdmin`, and nowhere under `(portal)`; no value of
 * `portal.public_wall_visibility` reveals it, because there is no code path
 * that could.
 */
export default async function NotesPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  await requireAdmin();

  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const screen = await loadNotesScreen(concertId);
  if (!screen) notFound();

  const waiting = screen.notes.filter((n) => n.moderationStatus === 'PENDING').length;

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
        <p className="text-sm text-muted-foreground">
          What the audience wrote, and what goes back to the players.{' '}
          {waiting > 0
            ? `${waiting} ${waiting === 1 ? 'note is' : 'notes are'} waiting to be reviewed.`
            : 'Nothing is waiting to be reviewed.'}
        </p>
      </header>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All notes</TabsTrigger>
          <TabsTrigger value="players">By player</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="pt-4">
          <NotesBoard
            concertId={concertId}
            notes={screen.notes}
            shows={screen.shows}
            players={screen.players}
          />
        </TabsContent>

        <TabsContent value="players" className="pt-4">
          <PlayerGroups concertId={concertId} groups={screen.groups} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
