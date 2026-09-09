'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { confirmBatchAction, discardDraftsAction, prepareBlastAction } from './actions';

/**
 * The three buttons of §11.2, in the order the spec puts them:
 * **prepare → review → confirm → send.**
 *
 * Each step is separate on purpose. Preparing renders messages into `DRAFT` and
 * sends nothing; confirming moves them to `QUEUED` and still sends nothing;
 * only Send dispatches. "Nothing leaves the system that a person has not looked
 * at" (§11.5) is a sequence, not a checkbox.
 */
export function BlastControls({
  segmentId,
  templateKey,
  drafts,
  queued,
  pendingRegistrations,
}: {
  segmentId: number;
  templateKey: string;
  drafts: number;
  queued: number;
  pendingRegistrations: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ error: string | null; message?: string | null } | null>(null);

  /**
   * Progress is driven by what the server reports, not by a client-side guess:
   * each call answers with how many rows are still queued, so a batch that
   * fails halfway shows as stopped rather than as complete (§11.2).
   */
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; failed: number; total: number } | null>(null);

  const run = (action: () => Promise<{ error: string | null; message?: string | null }>) =>
    startTransition(async () => {
      setFeedback(await action());
      router.refresh();
    });

  /**
   * The UI calls the dispatcher repeatedly until the queue drains (§11.2).
   * Each call is one function invocation inside `maxDuration`, so a long blast
   * is many short requests rather than one that times out.
   */
  async function send() {
    setSending(true);
    setFeedback(null);
    let sent = 0;
    let failed = 0;
    const total = queued;

    try {
      for (;;) {
        const response = await fetch('/api/outbox/dispatch', { method: 'POST' });
        const result = await response.json();

        if (!response.ok) {
          setFeedback({ error: result.error ?? 'Dispatch failed.' });
          break;
        }

        sent += result.sent ?? 0;
        failed += result.failed ?? 0;
        setProgress({ sent, failed, total });

        if (result.dailyCapReached) {
          setFeedback({
            error: null,
            message: `Daily send limit reached. ${result.remaining} message(s) will go out tomorrow.`,
          });
          break;
        }
        // A batch that sent and failed nothing has nothing left it can do; stopping
        // here is what prevents an endless loop against a permanently stuck row.
        if (result.remaining === 0 || (result.sent === 0 && result.failed === 0)) {
          setFeedback({
            error: null,
            message: `${sent} sent${failed > 0 ? `, ${failed} failed — see Last error in the table` : ''}.`,
          });
          break;
        }
      }
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : 'Dispatch failed.' });
    } finally {
      setSending(false);
      router.refresh();
    }
  }

  const busy = pending || sending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => run(() => prepareBlastAction({ segmentId, templateKey }))}
          disabled={busy || pendingRegistrations === 0}
        >
          {pending ? <Spinner /> : null}
          Prepare {pendingRegistrations} message{pendingRegistrations === 1 ? '' : 's'}
        </Button>

        <Button
          variant="outline"
          onClick={() => run(() => confirmBatchAction({ segmentId, templateKey }))}
          disabled={busy || drafts === 0}
        >
          Confirm {drafts} draft{drafts === 1 ? '' : 's'}
        </Button>

        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button variant="default" disabled={busy || queued === 0}>
                {sending ? <Spinner /> : null}
                Send {queued} queued
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Send {queued} message(s) now?</AlertDialogTitle>
              <AlertDialogDescription>
                This delivers real email to real people and cannot be undone. Pressing Send twice is
                harmless — every message goes out at most once.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={send}>Send now</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {drafts > 0 ? (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="ghost" disabled={busy}>
                  Discard drafts
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Withdraw {drafts} draft(s)?</AlertDialogTitle>
                <AlertDialogDescription>
                  Nothing has been sent, so this only clears the review queue. You can prepare the
                  batch again afterwards.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep them</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => run(() => discardDraftsAction({ segmentId, templateKey }))}
                >
                  Discard
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>

      {sending || progress ? (
        <div className="space-y-1">
          <Progress value={progress && progress.total > 0 ? ((progress.sent + progress.failed) / progress.total) * 100 : 0} />
          <p className="text-muted-foreground text-sm">
            {progress ? `${progress.sent} sent, ${progress.failed} failed of ${progress.total}` : 'Starting…'}
          </p>
        </div>
      ) : null}

      {feedback?.error ? (
        <Alert variant="destructive">
          <AlertTitle className="whitespace-pre-wrap">{feedback.error}</AlertTitle>
        </Alert>
      ) : null}
      {feedback?.message ? (
        <Alert>
          <AlertTitle className="whitespace-pre-wrap">{feedback.message}</AlertTitle>
        </Alert>
      ) : null}
    </div>
  );
}
