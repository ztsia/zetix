'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Check, RefreshCw, Reply, Send } from 'lucide-react';
import { AdminOnly, useCanEdit } from '@/components/auth/role';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { markHandledAction, sendReplyAction, syncInboxAction } from './actions';

/**
 * The controls on a guest's reply (spec/v3.md §26.5–§26.6), shared by the
 * party record's Conversation and a player's thread in the Inbox: answer it,
 * or mark it handled. Admins only; a viewer sees the thread and nothing to press.
 */
export function ReplyControls({
  concertId,
  messageId,
  waiting,
}: {
  concertId: number;
  messageId: number;
  /** Unhandled: offer "Mark handled" as well as a reply. */
  waiting: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const send = () =>
    start(async () => {
      setStatus(null);
      const result = await sendReplyAction(concertId, messageId, body);
      if (!result.ok) {
        setStatus({ tone: 'error', text: result.error });
        return;
      }
      setBody('');
      setOpen(false);
      setStatus(
        result.value.sent
          ? { tone: 'ok', text: 'Reply sent.' }
          : { tone: 'error', text: result.value.note ?? 'Queued; it will be sent on the next run.' },
      );
      router.refresh();
    });

  const handled = () =>
    start(async () => {
      setStatus(null);
      const result = await markHandledAction(concertId, messageId);
      if (!result.ok) setStatus({ tone: 'error', text: result.error });
      router.refresh();
    });

  return (
    <AdminOnly>
      <div className="flex flex-col gap-2 pt-1">
        {open ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your reply. It goes to the party’s current address, threaded under their message."
              rows={5}
              aria-label="Reply"
              disabled={pending}
              autoFocus
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={send} disabled={pending || body.trim().length === 0}>
                <Send data-icon="inline-start" /> {pending ? 'Sending…' : 'Send reply'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={pending}>
              <Reply data-icon="inline-start" /> Reply
            </Button>
            {waiting && (
              <Button size="sm" variant="ghost" onClick={handled} disabled={pending}>
                <Check data-icon="inline-start" /> Mark handled
              </Button>
            )}
          </div>
        )}
        {status && (
          <p role="status" className={status.tone === 'error' ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
            {status.text}
          </p>
        )}
      </div>
    </AdminOnly>
  );
}

/**
 * Reads the mailbox from the console (spec/v3.md §26.3: "while the admin
 * console is open, and when a party record is opened"). Refreshes the page only
 * when something new was stored. Silent for a viewer, who cannot write.
 *
 * - `immediately`: once on mount — a record being opened.
 * - `everyMinutes`: on a timer, skipping the mount — the console shell, so
 *   opening a record does not start two syncs at once.
 */
export function InboxAutoSync({
  concertId,
  immediately = false,
  everyMinutes,
}: {
  concertId: number;
  immediately?: boolean;
  everyMinutes?: number | null;
}) {
  const router = useRouter();
  const canEdit = useCanEdit();
  const running = useRef(false);

  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    const run = async () => {
      if (running.current || document.visibilityState === 'hidden') return;
      running.current = true;
      try {
        const result = await syncInboxAction(concertId);
        if (!cancelled && result.ok && result.value.stored > 0) router.refresh();
      } catch {
        // A background read that fails is the tick's to retry; nothing to tell anyone here.
      } finally {
        running.current = false;
      }
    };
    if (immediately) void run();
    const timer =
      everyMinutes && everyMinutes > 0 ? window.setInterval(run, everyMinutes * 60_000) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [canEdit, concertId, immediately, everyMinutes, router]);

  return null;
}

/** "Check now": one sync, with its outcome said in words. */
export function CheckNowButton({ concertId }: { concertId: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <AdminOnly>
      <div className="flex items-center gap-2">
        {message && <span className="text-muted-foreground text-sm">{message}</span>}
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await syncInboxAction(concertId);
              if (!result.ok) setMessage(result.error);
              else if (result.value.status === 'not_configured') setMessage('The mailbox is not configured here.');
              else if (result.value.status === 'failed') setMessage(`Could not read the mailbox: ${result.value.message}`);
              else setMessage(result.value.stored > 0 ? `${result.value.stored} new.` : 'Nothing new.');
              router.refresh();
            })
          }
        >
          <RefreshCw data-icon="inline-start" className={pending ? 'animate-spin' : undefined} /> Check now
        </Button>
      </div>
    </AdminOnly>
  );
}
