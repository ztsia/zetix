import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { getConcertHeader } from '../shows/queries';
import { listReviewSegments, loadReviewBoard } from './queries';
import { ReviewBoard } from './review-board';

export const metadata: Metadata = { title: 'Extras review' };

/**
 * `/admin/concerts/{id}/extras-review` — the batch grant screen of
 * spec/allocation.md §7.5.
 *
 * **Scoped to one segment**, because allocation is computed per segment (§7.1):
 * a screen spanning two would show one pool while spending another. The segment
 * is in the query string so the choice survives a refresh and can be linked to.
 *
 * The queue is ordered by `requested_at` — the FCFS key of §7.4, never
 * `created_at` — and the preselection that arrives with it is the strict greedy
 * walk. It is a recommendation: the admin edits it freely, and only a commit
 * past the segment's or the hall's capacity asks for anything more.
 */
export default async function ExtrasReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<{ segment?: string }>;
}) {
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const segments = await listReviewSegments(concertId);
  if (segments.length === 0) {
    return (
      <Empty className="border-border min-h-[60vh] rounded-lg border border-dashed">
        <EmptyHeader>
          <EmptyTitle>No segments yet</EmptyTitle>
          <EmptyDescription>
            Extras are reviewed per segment. Add a show and a segment first, on the
            Shows screen.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const { segment: requested } = await searchParams;
  const asked = Number(requested);
  const selected = segments.find((option) => option.id === asked);

  /**
   * **The segment is always in the URL.** Landing without one picks the queue
   * that has people waiting — which is what an admin opening this screen is
   * almost always here for — and then redirects so the choice is explicit.
   *
   * The redirect is the point, not a nicety. Without it the fallback re-runs on
   * every render, so committing a queue empties it and the next render silently
   * moves to a different segment while still showing the message about the one
   * just committed: the header's figures would describe a segment the admin
   * never chose. It also makes the screen linkable.
   */
  if (!selected) {
    const fallback = segments.find((option) => option.pending > 0) ?? segments[0];
    redirect(`/admin/concerts/${concertId}/extras-review?segment=${fallback.id}`);
  }

  const data = await loadReviewBoard(selected.id);

  return (
    <ReviewBoard
      concertId={concertId}
      data={data}
      segments={segments}
      timeZone={concert.timezone}
    />
  );
}
