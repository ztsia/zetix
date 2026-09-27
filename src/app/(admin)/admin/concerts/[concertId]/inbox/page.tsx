import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole, maskPhonesInText, masksContacts } from '@/lib/auth/mask';
import { inboxCounts, INBOX_VIEWS, listInboxThreads, mailboxStatus, type InboxThread } from '@/lib/inbox/queries';
import { lastHeartbeat } from '@/lib/scheduler/tick';
import { getConcertHeader } from '../shows/queries';
import { InboxList } from './inbox-list';

export const metadata: Metadata = { title: 'Inbox' };

/**
 * `/admin/concerts/{id}/inbox` — open threads and bounces (spec/v3.md §26.5,
 * §29.1).
 *
 * Only threads the system started are here (§26.1). A party's thread is read
 * and answered on its record; a player's — a reply to the notes digest — has
 * its own page under this one, since a player has no record.
 */
export default async function InboxPage({
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

  const query = await searchParams;
  const view = INBOX_VIEWS.find((v) => v === query.view) ?? 'waiting';

  const [counts, threads, mailbox, heartbeat] = await Promise.all([
    inboxCounts(concertId),
    listInboxThreads(concertId, view),
    mailboxStatus(),
    lastHeartbeat(),
  ]);

  // A reply is free text: its phone numbers are masked here, the addresses by the walk (§28).
  const shown: InboxThread[] = masksContacts(user.role)
    ? threads.map((t) => ({
        ...t,
        last: t.last && { ...t.last, subject: prose(t.last.subject), text: prose(t.last.text) },
      }))
    : threads;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Inbox</h1>
        <p className="text-muted-foreground text-sm">
          Replies to what this concert sent, and the messages that bounced. Mail that answers nothing we
          sent is never stored.
        </p>
      </div>
      <InboxList
        concertId={concertId}
        timeZone={concert.timezone ?? 'UTC'}
        view={view}
        counts={counts}
        threads={maskForRole(user.role, shown)}
        mailbox={maskForRole(user.role, mailbox)}
        heartbeat={maskForRole(user.role, heartbeat)}
      />
    </div>
  );
}

const prose = (value: string | null) => (value === null ? null : maskPhonesInText(value));
