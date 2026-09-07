import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, count, eq, isNull } from 'drizzle-orm';
import { ArrowRight, CalendarDays, UsersRound } from 'lucide-react';
import { getDb } from '@/db/client';
import { players } from '@/db/schema/people';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { formatShowTime } from '../../local-time';
import { getConcertHeader, getShowsForConcert, type ShowView } from '../shows/queries';

export const metadata: Metadata = { title: 'Overview' };

/**
 * `/admin/concerts/{id}/overview` — capacity across all shows, at a glance
 * (spec/admin.md §14.1).
 *
 * The one screen that answers "is this concert configured?" without opening
 * anything. It reads the same queries the shows screen does, so the two cannot
 * disagree about a number, and it leads with the things that silently stop the
 * system later: a hall with no capacity, a segment with none, a concert with no
 * timezone.
 *
 * **Held seats are seats in no segment** (decision 21). There is no
 * `held_seats` column and no soft threshold — if the hall is 400 and the
 * segments total 390, ten seats are held, and this is where that shows up.
 */
export default async function OverviewPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const shows = await getShowsForConcert(concertId);

  const [playerTally] = await getDb()
    .select({ total: count() })
    .from(players)
    .where(
      and(
        eq(players.concertId, concertId),
        eq(players.isActive, true),
        isNull(players.deletedAt),
      ),
    );

  const gaps = findGaps(concert.timezone, shows);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{concert.name}</h1>
        <p className="text-muted-foreground text-sm">
          {shows.length === 0
            ? 'No shows yet.'
            : `${shows.length} show${shows.length === 1 ? '' : 's'} · ${playerTally?.total ?? 0} active player${
                playerTally?.total === 1 ? '' : 's'
              }`}
          {concert.timezone && ` · ${concert.timezone}`}
        </p>
      </div>

      {/* What is still missing, first. Every one of these is an operational
          value with no default anywhere (spec/domain.md §6), so it does not
          fail now — it fails later, at allocation or at a blast. */}
      {gaps.length > 0 && (
        <Alert>
          <AlertTitle>
            {gaps.length} thing{gaps.length === 1 ? '' : 's'} still to configure
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {shows.length === 0 ? (
        <Empty className="border">
          <EmptyTitle>Nothing scheduled</EmptyTitle>
          <EmptyDescription>
            A concert holds shows; a show holds segments. Add the first show to begin.
          </EmptyDescription>
          <Button render={<Link href={`/admin/concerts/${concertId}/shows`} />}>
            Go to shows
            <ArrowRight />
          </Button>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {shows.map((show) => (
            <ShowSummary
              key={show.id}
              concertId={concertId}
              show={show}
              timeZone={concert.timezone}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          render={<Link href={`/admin/concerts/${concertId}/shows`} />}
        >
          <CalendarDays />
          Shows and segments
        </Button>
        <Button
          variant="outline"
          render={<Link href={`/admin/concerts/${concertId}/players`} />}
        >
          <UsersRound />
          Players
        </Button>
      </div>
    </div>
  );
}

function ShowSummary({
  concertId,
  show,
  timeZone,
}: {
  concertId: number;
  show: ShowView;
  timeZone: string | null;
}) {
  const startsAt = formatShowTime(show.startsAt, timeZone);
  const confirmed = show.segments.reduce(
    (total, segment) => total + (segment.pool?.confirmed ?? 0),
    0,
  );

  return (
    <Card>
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href={`/admin/concerts/${concertId}/shows`}
            className="font-semibold underline-offset-4 hover:underline"
          >
            {show.name}
          </Link>
          <Badge variant={show.status === 'OPEN' ? 'default' : 'secondary'}>
            {show.status.toLowerCase()}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">{startsAt ?? 'No date set'}</p>
      </CardHeader>

      <CardContent className="flex flex-col gap-2 text-sm">
        {show.held === null ? (
          <p className="text-muted-foreground">No hall capacity set.</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>
              Hall{' '}
              <span className="font-medium tabular-nums">
                {show.allocated + show.held}
              </span>
            </span>
            <span className="text-muted-foreground">
              allocated <span className="tabular-nums">{show.allocated}</span>
            </span>
            {/* Held seats, named as such — they are not a shortfall. Withholding
                seats for staff or press is done by giving them to no segment. */}
            <span
              className={
                show.held < 0 ? 'text-destructive font-medium' : 'text-muted-foreground'
              }
            >
              {show.held < 0 ? (
                <>
                  <span className="tabular-nums">{-show.held}</span> over
                </>
              ) : (
                <>
                  <span className="tabular-nums">{show.held}</span> held
                </>
              )}
            </span>
            <span className="text-muted-foreground">
              <span className="tabular-nums">{confirmed}</span> confirmed
            </span>
          </div>
        )}

        {show.segments.length === 0 ? (
          <p className="text-muted-foreground">
            No segments — nothing can be allocated in this show yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {show.segments.map((segment) => (
              <li key={segment.id} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{segment.name}</span>
                <Badge variant="outline" className="font-normal">
                  {segment.audienceMode === 'PUBLIC' ? 'public' : 'player invited'}
                </Badge>
                {segment.pool === null ? (
                  <span className="text-muted-foreground">no capacity set</span>
                ) : (
                  <span className="text-muted-foreground tabular-nums">
                    {segment.pool.confirmed}/{segment.pool.sellable}
                    {segment.pool.over > 0 && (
                      <span className="text-destructive"> · {segment.pool.over} over</span>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The configuration that is missing, in the order it will bite.
 *
 * Deliberately a list of specific sentences rather than a completeness
 * percentage: "82% configured" tells an organiser nothing they can act on at
 * 9pm the night before.
 */
function findGaps(timezone: string | null, shows: ShowView[]): string[] {
  const gaps: string[] = [];

  if (!timezone) {
    gaps.push('This concert has no timezone, so no show time can be stored or shown.');
  }

  for (const show of shows) {
    if (show.held === null) {
      gaps.push(`“${show.name}” has no hall capacity.`);
    } else if (show.held < 0) {
      gaps.push(
        `“${show.name}” has ${-show.held} more seats in segments than the hall holds.`,
      );
    }

    if (show.segments.length === 0) {
      gaps.push(`“${show.name}” has no segments, so nothing can be registered for it.`);
    }

    for (const segment of show.segments) {
      if (segment.pool === null) {
        gaps.push(`“${segment.name}” in “${show.name}” has no capacity.`);
      }
      if (
        segment.audienceMode === 'PLAYER_INVITED' &&
        segment.resolved['allocation.base_quota']?.origin === 'unset'
      ) {
        gaps.push(
          `“${segment.name}” in “${show.name}” has no base quota, so players are promised nothing.`,
        );
      }
    }

    if (!show.startsAt) gaps.push(`“${show.name}” has no start time.`);
  }

  return gaps;
}
