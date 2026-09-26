import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { outboxBacklog } from '@/lib/email/dispatch';
import { QueueScope } from '../../blast-queue';

/**
 * Everything under a concert.
 *
 * The concert is resolved once here so a bogus or deleted id 404s at the shell
 * rather than rendering a full console whose every inner query quietly returns
 * nothing.
 */
export default async function ConcertLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  const id = Number(concertId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const rows = await getDb()
    .select({ id: concerts.id })
    .from(concerts)
    .where(and(eq(concerts.id, id), isNull(concerts.deletedAt)))
    .limit(1);
  if (rows.length === 0) notFound();

  // The shell's queue banner counts this concert's messages, not every
  // concert's (spec/v3.md §24.5, `local.md` §14.1).
  const backlog = await outboxBacklog(id);

  return (
    <>
      <QueueScope concertId={id} backlog={backlog} />
      {children}
    </>
  );
}
