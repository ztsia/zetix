'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { ThreadMessage } from '@/lib/inbox/queries';
import { formatter } from '../../audience/badges';
import { ReplyControls } from '../reply-controls';

/** A stored thread, oldest first, with the reply controls on each guest message. */
export function ThreadView({
  concertId,
  timeZone,
  messages,
}: {
  concertId: number;
  timeZone: string;
  messages: ThreadMessage[];
}) {
  const format = useMemo(() => formatter(timeZone), [timeZone]);
  return (
    <ol className="flex flex-col gap-2">
      {messages.map((m) => (
        <li
          key={m.id}
          className={
            m.direction === 'INBOUND'
              ? 'bg-muted/50 ml-8 flex flex-col gap-1 rounded-lg border p-3'
              : 'mr-8 flex flex-col gap-1 rounded-lg border p-3'
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={m.isBounce ? 'destructive' : m.direction === 'INBOUND' ? 'default' : 'outline'}>
              {m.isBounce ? 'Bounce' : m.direction === 'INBOUND' ? 'Reply' : 'Our reply'}
            </Badge>
            <span className="text-muted-foreground">
              {m.direction === 'INBOUND' ? `from ${m.fromEmail ?? 'unknown'}` : `to ${m.toEmail ?? 'unknown'}`}
            </span>
            {m.direction === 'INBOUND' && !m.isBounce && !m.handledAt && <Badge variant="destructive">Waiting</Badge>}
            <span className="text-muted-foreground ml-auto tabular-nums">{format.format(new Date(m.at))}</span>
          </div>
          <p className="font-medium">{m.subject}</p>
          {m.text && <p className="text-muted-foreground text-sm whitespace-pre-wrap">{m.text}</p>}
          {m.direction === 'INBOUND' && !m.isBounce && (
            <ReplyControls concertId={concertId} messageId={m.id} waiting={!m.handledAt} />
          )}
        </li>
      ))}
    </ol>
  );
}
