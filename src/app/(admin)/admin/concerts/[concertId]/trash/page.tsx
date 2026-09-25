import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/guards';
import { parseTableState } from '@/components/data-table/url-state';
import { listTrash, trashKindSchema } from '@/lib/trash/queries';
import { getConcertHeader } from '../shows/queries';
import { TrashTable } from './trash-table';
import { maskForRole, masksContacts } from '@/lib/auth/mask';

export const metadata: Metadata = { title: 'Trash' };

/**
 * `/admin/concerts/{id}/trash` — every deleted row of this concert
 * (spec/v3.md §23.6, decision 46).
 *
 * One tab per kind, each a server-paged table whose state — kind, search, page
 * — is in the URL, so a link opens the same view (§22.2). Restore and Delete
 * permanently are commands (§23.1): the table hands the dialog a selection, and
 * the dialog previews, runs and reports.
 */
export default async function TrashPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const state = parseTableState(await searchParams, { extraKeys: ['kind'] });
  const kind = trashKindSchema.catch('party').parse(state.extra.kind);
  const page = await listTrash(concertId, kind, {
    search: state.search,
    pageIndex: state.pageIndex,
    pageSize: state.pageSize,
    labelOnly: masksContacts(user.role),
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Trash</h1>
        <p className="text-muted-foreground text-sm">
          Deleted rows stay here until restored or deleted permanently. Restoring puts seats back
          through the capacity check; deleting permanently cannot be undone.
        </p>
      </div>
      <TrashTable
        concertId={concertId}
        timeZone={concert.timezone ?? 'UTC'}
        kind={kind}
        state={{ ...state, extra: { ...state.extra, kind } }}
        page={maskForRole(user.role, page)}
      />
    </div>
  );
}
