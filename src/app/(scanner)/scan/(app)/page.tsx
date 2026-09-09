import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { CalendarDays, ChevronRight, ScanLine, ShieldQuestion } from 'lucide-react';
import { getDb } from '@/db/client';
import { shows } from '@/db/schema/shows';
import { concerts } from '@/db/schema/concerts';
import { operatorShowAssignments } from '@/db/schema/people';
import { requireScannerUser } from '@/lib/auth/guards';
import { signOutOperator } from '@/lib/auth/actions';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';

/**
 * The show picker (spec/checkin.md §12.1).
 *
 * **It lists only the operator's assigned shows**, and that filter is the
 * authorization boundary, not a convenience: the manifest behind each show is
 * the full attendee roster (decision 20). `ADMIN` ignores assignments and sees
 * every show.
 *
 * An operator with no assignments sees an empty list. That is correct behaviour
 * for a provisioned-but-not-rostered account, not an error — so it says who to
 * ask rather than showing a failure.
 *
 * **One assignment skips the picker entirely** (§12.1). That is the common case,
 * and choosing from a list of one is where the single most damaging setup
 * mistake happens: an usher admitting against the wrong show. An `ADMIN` is
 * never redirected — they legitimately move between shows.
 */
export default async function ScannerHomePage() {
  const user = await requireScannerUser();
  const db = getDb();

  const base = db
    .select({
      id: shows.id,
      name: shows.name,
      startsAt: shows.startsAt,
      venueName: shows.venueName,
      concertName: concerts.name,
      timezone: concerts.timezone,
    })
    .from(shows)
    .innerJoin(concerts, eq(concerts.id, shows.concertId));

  const assigned =
    user.role === 'ADMIN'
      ? await base.where(isNull(shows.deletedAt)).orderBy(asc(shows.startsAt))
      : await base
          .innerJoin(
            operatorShowAssignments,
            eq(operatorShowAssignments.showId, shows.id),
          )
          .where(and(eq(operatorShowAssignments.userId, user.id), isNull(shows.deletedAt)))
          .orderBy(asc(shows.startsAt));

  // §12.1: with exactly one assignment it is auto-selected. Only for an
  // OPERATOR — an admin with one show in the concert has not been *rostered* to
  // it, and would find themselves unable to reach the list at all.
  if (user.role === 'OPERATOR' && assigned.length === 1) {
    redirect(`/scan/${assigned[0].id}`);
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Choose a show</h1>
          <p className="text-muted-foreground text-sm">
            Signed in as {user.displayName ?? user.email}
          </p>
        </div>
        <form action={signOutOperator}>
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </header>

      {assigned.length === 0 ? (
        <Empty className="border-border flex-1 rounded-lg border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldQuestion />
            </EmptyMedia>
            <EmptyTitle>No shows assigned yet</EmptyTitle>
            <EmptyDescription>
              Your account works. An admin still needs to assign you to a show
              before you can scan — ask them to add you from the operators screen.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {assigned.map((show) => (
            <li key={show.id}>
              <Item
                variant="outline"
                render={<Link href={`/scan/${show.id}`} />}
                className="min-h-16"
              >
                <ItemContent>
                  <ItemTitle className="text-base">{show.name}</ItemTitle>
                  <ItemDescription>
                    <span className="flex items-center gap-1.5">
                      <CalendarDays className="size-3.5" />
                      {show.concertName}
                      {show.venueName ? ` · ${show.venueName}` : ''}
                    </span>
                  </ItemDescription>
                </ItemContent>
                <ChevronRight className="text-muted-foreground size-5" />
              </Item>
            </li>
          ))}
        </ul>
      )}

      {/* Setup, not door-time: the ushers run this once on their own phone so
          we know which handsets vibrate, which can be heard, and which fell
          back to memory storage — none of which any test we can run answers
          (local.md §5f). Kept out of the way rather than prominent, since it is
          irrelevant once the queue starts moving. */}
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground mt-auto"
        render={<Link href="/scan/diagnostics" />}
      >
        <ScanLine className="size-3.5" />
        Check this phone
      </Button>
    </main>
  );
}
