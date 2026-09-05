import { notFound } from 'next/navigation';
import Link from 'next/link';
import { and, eq, isNull } from 'drizzle-orm';
import { Camera, ChevronLeft } from 'lucide-react';
import { getDb } from '@/db/client';
import { shows } from '@/db/schema/shows';
import { requireScannerUser } from '@/lib/auth/guards';
import { canAccessShow } from '@/lib/auth/show-access';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Badge } from '@/components/ui/badge';

/**
 * One show, at the door. Module `G` builds the Scan / Search / Stats tabs here.
 *
 * **The assignment check is F2's and it is enforced here, before anything is
 * rendered.** Reaching a show by typing its id must fail exactly as reaching it
 * from the list would — an operator who is not rostered on this show gets a 404,
 * not a scanner (decision 20, spec/checkin.md §12.3).
 *
 * A 404 rather than a 403 on purpose: "you may not see this show" and "this show
 * does not exist" should be indistinguishable to someone probing ids.
 */
export default async function ScannerShowPage({
  params,
}: {
  params: Promise<{ showId: string }>;
}) {
  const user = await requireScannerUser();
  const { showId } = await params;
  const id = Number(showId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const db = getDb();
  const rows = await db
    .select({ id: shows.id, name: shows.name, venueName: shows.venueName })
    .from(shows)
    .where(and(eq(shows.id, id), isNull(shows.deletedAt)))
    .limit(1);
  const show = rows[0];
  if (!show) notFound();

  if (!(await canAccessShow(user, id))) notFound();

  return (
    <main className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" render={<Link href="/scan" />}>
          <ChevronLeft />
          <span className="sr-only">Back to shows</span>
        </Button>
        <div className="flex-1">
          <h1 className="font-semibold">{show.name}</h1>
          {show.venueName && (
            <p className="text-muted-foreground text-xs">{show.venueName}</p>
          )}
        </div>
        <Badge variant="secondary">Admitting</Badge>
      </div>

      <Empty className="border-border flex-1 rounded-lg border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Camera />
          </EmptyMedia>
          <EmptyTitle>Scanner not built yet</EmptyTitle>
          <EmptyDescription>
            Camera scanning, name search and live stats are module G. You are
            signed in and assigned to this show, so it will work here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
}
