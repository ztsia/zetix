import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole, maskPhonesInText, masksContacts } from '@/lib/auth/mask';
import { loadThreadMessages } from '@/lib/inbox/queries';
import { getConcertHeader } from '../../shows/queries';
import { ThreadView } from './thread-view';

export const metadata: Metadata = { title: 'Conversation' };

/**
 * `/admin/concerts/{id}/inbox/{threadId}` — one conversation. A party's is on
 * its record (spec/v3.md §22.4), so this redirects there; a player has no
 * record, so their digest replies are read and answered here.
 */
export default async function ThreadPage({
  params,
}: {
  params: Promise<{ concertId: string; threadId: string }>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const { concertId: rawConcert, threadId: rawThread } = await params;
  const concertId = Number(rawConcert);
  const threadId = Number(rawThread);
  if (!Number.isSafeInteger(concertId) || concertId <= 0) notFound();
  if (!Number.isSafeInteger(threadId) || threadId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const messages = await loadThreadMessages(concertId, threadId);
  if (!messages) notFound();

  const [thread] = await getDb().execute<{ registration_id: string | null; name: string | null }>(sql`
    select t.registration_id, p.full_name as name
      from email_threads t left join players p on p.id = t.player_id
     where t.id = ${threadId}`);
  if (thread?.registration_id) redirect(`/admin/concerts/${concertId}/audience/${thread.registration_id}`);

  const shown = masksContacts(user.role)
    ? messages.map((m) => ({
        ...m,
        subject: m.subject === null ? null : maskPhonesInText(m.subject),
        text: m.text === null ? null : maskPhonesInText(m.text),
      }))
    : messages;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-muted-foreground text-sm">
          <Link href={`/admin/concerts/${concertId}/inbox`} className="hover:underline">
            Inbox
          </Link>{' '}
          › Player
        </p>
        <h1 className="text-xl font-semibold">{thread?.name ?? 'Player'}</h1>
      </div>
      <ThreadView concertId={concertId} timeZone={concert.timezone ?? 'UTC'} messages={maskForRole(user.role, shown)} />
    </div>
  );
}
