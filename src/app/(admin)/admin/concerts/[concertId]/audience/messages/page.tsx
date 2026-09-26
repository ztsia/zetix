import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { parseTableState } from '@/components/data-table/url-state';
import { getDb } from '@/db/client';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole, masksContacts } from '@/lib/auth/mask';
import { listMessages } from '@/lib/delivery/messages';
import { MESSAGE_STATUSES, type MessageFilter } from '@/lib/delivery/message-filter';
import { PURPOSES } from '@/lib/delivery/purposes';
import { getConcertHeader } from '../../shows/queries';
import { CommandHost } from '../command-host';
import { MessagesTable } from './messages-table';

export const metadata: Metadata = { title: 'Messages' };

/**
 * `/admin/concerts/{id}/audience/messages` — Audience › Messages
 * (spec/v3.md §24.4): every message the concert has sent or will send, all
 * purposes and all statuses, and the exit each status has.
 *
 * It replaces Email › Delivery and the Email screen's outbox: a failed message
 * is retried or its address fixed here or on the party's record, never with
 * SQL. The state — status tab, purpose, search, page — is in the URL, so a link
 * (the queue banner's "Open failed") opens the same view.
 */
export default async function MessagesPage({
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

  const state = parseTableState(await searchParams, { extraKeys: ['status', 'purpose'] });
  const status = MESSAGE_STATUSES.find((s) => s === state.extra.status);
  const purpose = PURPOSES.find((p) => p === state.extra.purpose);
  if (!status) delete state.extra.status;
  if (!purpose) delete state.extra.purpose;
  const filter: MessageFilter = {
    ...(status ? { status } : {}),
    ...(purpose ? { purpose } : {}),
    ...(state.search ? { search: state.search.slice(0, 200) } : {}),
  };

  const page = await listMessages(getDb(), concertId, filter, {
    offset: state.pageIndex * state.pageSize,
    limit: state.pageSize,
    // A viewer's search never matches an address they see masked (§28).
    searchAddresses: !masksContacts(user.role),
  });

  return (
    <CommandHost concertId={concertId} data={{ segments: [], players: [] }}>
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold">Messages</h1>
          <p className="text-muted-foreground text-sm">
            Every message to this concert’s audience, in every state. Nothing here is stuck: each status
            has its way out.
          </p>
        </div>
        <MessagesTable
          concertId={concertId}
          timeZone={concert.timezone ?? 'UTC'}
          filter={filter}
          state={state}
          page={maskForRole(user.role, page)}
        />
      </div>
    </CommandHost>
  );
}
