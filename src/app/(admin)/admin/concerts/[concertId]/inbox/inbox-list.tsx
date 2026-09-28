'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { AlertTriangle, CornerDownLeft, MailWarning, MessageSquare } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { InboxCounts, InboxThread, InboxView, MailboxStatus } from '@/lib/inbox/queries';
import type { Heartbeat } from '@/lib/scheduler/tick';
import { formatter } from '../audience/badges';
import { CheckNowButton } from './reply-controls';

const VIEW_LABEL: Record<InboxView, string> = { waiting: 'Waiting for a reply', bounces: 'Bounced', all: 'All' };

const EMPTY: Record<InboxView, { title: string; description: string }> = {
  waiting: { title: 'Nobody is waiting', description: 'Every reply has been answered or marked handled.' },
  bounces: { title: 'No bounces', description: 'Nothing sent to a party’s current address has bounced.' },
  all: { title: 'No conversations yet', description: 'Replies and bounces appear here once the mailbox has been read.' },
};

export function InboxList({
  concertId,
  timeZone,
  view,
  counts,
  threads,
  mailbox,
  heartbeat,
}: {
  concertId: number;
  timeZone: string;
  view: InboxView;
  counts: InboxCounts;
  threads: InboxThread[];
  mailbox: MailboxStatus;
  heartbeat: Heartbeat | null;
}) {
  const router = useRouter();
  const format = useMemo(() => formatter(timeZone), [timeZone]);
  const lastRead = mailbox.folders
    .map((f) => f.lastSyncedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  const failing = mailbox.folders.filter((f) => f.lastError);

  const hrefFor = (t: InboxThread) =>
    t.kind === 'registration'
      ? `/admin/concerts/${concertId}/audience/${t.addresseeId}`
      : `/admin/concerts/${concertId}/inbox/${t.threadId}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {lastRead ? `Mailbox last read ${format.format(new Date(lastRead))}.` : 'The mailbox has not been read yet.'}{' '}
          {heartbeat
            ? `Scheduler last ran ${format.format(new Date(heartbeat.startedAt))}.`
            : 'The scheduler has not run yet.'}
        </p>
        <CheckNowButton concertId={concertId} />
      </div>

      {heartbeat?.error && (
        // A login the mailbox refused never reaches a folder, so it is only here.
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>The last scheduler run had a problem</AlertTitle>
          <AlertDescription>
            <span className="block break-words [overflow-wrap:anywhere]">{heartbeat.error}</span>
          </AlertDescription>
        </Alert>
      )}

      {failing.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>The mailbox could not be read</AlertTitle>
          <AlertDescription>
            {failing.map((f) => (
              <span key={f.folder} className="block break-words [overflow-wrap:anywhere]">
                {f.folder}: {f.lastError}
              </span>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <Tabs
        value={view}
        onValueChange={(value: string) =>
          router.push(`/admin/concerts/${concertId}/inbox${value === 'waiting' ? '' : `?view=${value}`}`)
        }
      >
        <TabsList variant="line">
          {(['waiting', 'bounces', 'all'] as const).map((v) => (
            <TabsTrigger key={v} value={v}>
              {VIEW_LABEL[v]}
              <Badge variant="secondary" className="tabular-nums">
                {counts[v]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {threads.length === 0 ? (
        <Empty className="border-border rounded-lg border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{EMPTY[view].title}</EmptyTitle>
            <EmptyDescription>{EMPTY[view].description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {threads.map((t) => (
            <Item key={t.threadId} variant="outline" render={<Link href={hrefFor(t)} />}>
              <ItemMedia variant="icon">
                {t.bounced ? <MailWarning className="text-destructive" /> : t.waiting > 0 ? <MessageSquare /> : <CornerDownLeft />}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {t.name ?? 'Unnamed'}
                  {t.kind === 'player' && <Badge variant="outline">Player</Badge>}
                  {t.waiting > 0 && <Badge variant="destructive">{t.waiting} waiting</Badge>}
                  {t.bounced && <Badge variant="destructive">Bounced</Badge>}
                </ItemTitle>
                <ItemDescription>
                  {t.last
                    ? `${t.last.isBounce ? 'Bounce' : t.last.direction === 'INBOUND' ? 'Them' : 'Us'}: ${t.last.subject ?? ''}${
                        t.last.text ? ` — ${t.last.text}` : ''
                      }`
                    : t.email}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="text-muted-foreground text-sm tabular-nums">
                {t.lastMessageAt ? format.format(new Date(t.lastMessageAt)) : null}
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
