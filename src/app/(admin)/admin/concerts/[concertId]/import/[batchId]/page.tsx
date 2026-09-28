import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Button } from '@/components/ui/button';
import { parseTableState } from '@/components/data-table/url-state';
import { getDb } from '@/db/client';
import { players } from '@/db/schema/people';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole, masksContacts } from '@/lib/auth/mask';
import { batchSummary, listStagedRows, STAGING_VIEWS, type StagingView } from '@/lib/import/staging-queries';
import { getConcertHeader } from '../../shows/queries';
import { StagingGrid } from './staging-grid';

export const metadata: Metadata = { title: 'Import staging' };

/**
 * `/admin/concerts/{id}/import/{batchId}` — the staging grid (spec/v3.md
 * §25.7): an uploaded file as editable rows, one per seat, committed a party
 * at a time as each becomes ready.
 */
export default async function StagingPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string; batchId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const { concertId: rawConcert, batchId: rawBatch } = await params;
  const concertId = Number(rawConcert);
  const batchId = Number(rawBatch);
  if (!Number.isSafeInteger(concertId) || concertId <= 0 || !Number.isSafeInteger(batchId) || batchId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();
  const summary = await batchSummary(concertId, batchId);
  if (!summary) notFound();

  const state = parseTableState(await searchParams, { extraKeys: ['view'] });
  const view: StagingView = (STAGING_VIEWS as readonly string[]).includes(state.extra.view ?? '')
    ? (state.extra.view as StagingView)
    : summary.counts['needs-fixing'] > 0 && summary.status === 'STAGED'
      ? 'needs-fixing'
      : 'all';
  const page = await listStagedRows(batchId, {
    view,
    search: state.search,
    pageIndex: state.pageIndex,
    pageSize: state.pageSize,
    namesOnly: masksContacts(user.role),
  });

  const roster =
    summary.audienceMode === 'PLAYER_INVITED'
      ? await getDb()
          .select({ id: players.id, name: players.fullName })
          .from(players)
          .where(and(eq(players.concertId, concertId), eq(players.isActive, true), isNull(players.deletedAt)))
          .orderBy(asc(players.fullName))
      : [];

  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 self-start"
        nativeButton={false}
        render={<Link href={`/admin/concerts/${concertId}/import`} />}
      >
        <ArrowLeft data-icon="inline-start" />
        Import
      </Button>
      <StagingGrid
        concertId={concertId}
        timeZone={concert.timezone ?? 'UTC'}
        summary={summary}
        view={view}
        state={{ ...state, extra: { ...state.extra, view } }}
        page={maskForRole(user.role, page)}
        roster={roster}
      />
    </div>
  );
}
