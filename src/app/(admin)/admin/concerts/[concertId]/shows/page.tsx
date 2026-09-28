import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { ShowCard } from './show-card';
import { ShowFormDialog } from './show-form-dialog';
import { getConcertHeader, getShowsForConcert } from './queries';
import { formFunnels } from '@/lib/intake/funnel';

export const metadata: Metadata = { title: 'Shows' };

/**
 * `/admin/concerts/{id}/shows` — shows and their segments (spec/admin.md §14.1).
 *
 * The show owns the hall and the door; its segments own the audience, the
 * capacity slice, the quota and the policy. That split is the screen's whole
 * shape, and it is why `audience_mode` appears on the segment form and nowhere
 * on the show's (decision 5).
 *
 * A Server Component: every number here is read live, including the pools, so
 * the page reflects what the allocation engine currently counts rather than a
 * cached view of it.
 */
export default async function ShowsPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const [shows, funnels] = await Promise.all([getShowsForConcert(concertId), formFunnels(concertId)]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Shows</h1>
          <p className="text-muted-foreground text-sm">
            Each show is a hall on a night. Its segments slice that capacity by
            audience.
          </p>
        </div>
        <ShowFormDialog
          concertId={concertId}
          timeZone={concert.timezone}
          trigger={
            <Button>
              <Plus />
              New show
            </Button>
          }
        />
      </div>

      {/* Without a zone nothing here can render a time correctly, and every
          show time would be stored against a guess (spec/domain.md §6.1). It is
          worth saying once, loudly, rather than as a disabled field on a form
          the admin has to open to discover the problem. */}
      {!concert.timezone && (
        <Alert variant="destructive">
          <AlertTitle>{concert.name} has no timezone</AlertTitle>
          <AlertDescription>
            Show times are stored in UTC and shown at the venue&rsquo;s clock, so a
            zone is needed before any time can be entered. Set one on the concert
            first.
          </AlertDescription>
        </Alert>
      )}

      {shows.length === 0 ? (
        <Empty className="border">
          <EmptyTitle>No shows yet</EmptyTitle>
          <EmptyDescription>
            Add the first one, then give it a segment for each audience — a show can
            hold a public block and a player-invited block at the same time.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {shows.map((show) => (
            <ShowCard
              key={show.id}
              concertId={concertId}
              show={show}
              timeZone={concert.timezone}
              forms={funnels.filter((form) => form.showId === show.id)}
              appUrl={process.env.APP_URL ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
