'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { MailPlusIcon, SendIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { generateFeedbackEmailsAction, sendFeedbackNowAction } from './actions';

/**
 * **Generate feedback emails** — decision 42's manual twin for the queueing step
 * (spec/v2.md §13.5.3).
 *
 * **Shown once the show is `COMPLETED`**, because that is when there is an
 * audience to email. It is not hidden after a first successful run: the second
 * reason to press it is an usher's phone that only drained its scan queue the
 * next morning, and those people are exactly the ones a run today would have
 * missed (§13.5.1). The action skips anyone already emailed, so pressing it
 * again is safe and says what it did.
 *
 * Not an `AlertDialog`: nothing is destroyed and nothing is sent by pressing it.
 * The rows land `QUEUED` and go at `portal.feedback_send_hour`, which is the
 * review window decision 38 traded the `DRAFT` gate for.
 */
export function GenerateFeedbackButton({
  concertId,
  showId,
}: {
  concertId: number;
  showId: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const run = (action: () => Promise<{ error: string | null; message?: string | null }>) =>
    startTransition(async () => {
      const state = await action();
      setResult(state.error ?? state.message ?? null);
      if (!state.error) router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => run(() => generateFeedbackEmailsAction(concertId, showId))}
            />
          }
        >
          {pending ? <Spinner data-icon="inline-start" /> : <MailPlusIcon data-icon="inline-start" />}
          Generate feedback emails
        </TooltipTrigger>
        <TooltipContent>
          Queues one email per party that was admitted, carrying a link for each
          person who came. Safe to press again — anyone already emailed is skipped.
        </TooltipContent>
      </Tooltip>
      {/*
        * **Send now** — decision 42's twin for the timed send. It is separate
        * from the blast screen's Send because that screen is per segment and per
        * template, and a feedback email is addressed per show across both its
        * audiences, scheduled for the send hour rather than due immediately.
        */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => run(() => sendFeedbackNowAction(concertId, showId))}
            />
          }
        >
          <SendIcon data-icon="inline-start" />
          Send now
        </TooltipTrigger>
        <TooltipContent>
          Brings the queued feedback emails forward from the send hour so the next
          dispatch picks them up. Nothing is sent by pressing this.
        </TooltipContent>
      </Tooltip>

      {result ? <span className="text-muted-foreground text-sm">{result}</span> : null}
    </div>
  );
}
