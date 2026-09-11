'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { useBlastQueue } from '../../../blast-queue';
import { confirmBatchAction, discardDraftsAction, prepareBlastAction } from './actions';

/**
 * The three buttons of §11.2, in the order the spec puts them:
 * **prepare → review → confirm → send.**
 *
 * Each step is separate on purpose. Preparing renders messages into `DRAFT` and
 * sends nothing; confirming moves them to `QUEUED` and still sends nothing;
 * only Send dispatches. "Nothing leaves the system that a person has not looked
 * at" (§11.5) is a sequence, not a checkbox.
 *
 * **Send starts the shell's dispatch loop; it does not own one** (§11.2.1). A
 * loop in this component's state dies when the admin navigates away, and a
 * blast takes about five minutes. Progress and the result are reported by the
 * shell's queue banner, which is why there is no progress bar here: two bars
 * disagreeing about the same send is worse than one in the place that survives.
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
  const blastQueue = useBlastQueue();

  /**
   * The Send dialog is controlled so pressing **Send now** closes it.
   *
   * `AlertDialogAction` is a plain `Button` — unlike `AlertDialogCancel` it is
   * not a `Close`, so it runs its handler and leaves the modal standing. That
   * matters more here than anywhere else in the console: this dialog is how a
   * blast starts, the modal makes the whole shell inert while it is open, and
   * the entire point of §11.2.1 is that the admin can then go somewhere else.
   * A send that traps them on this screen has a banner reporting a freedom they
   * do not have.
   *
   * Fixed here rather than in `components/ui/alert-dialog.tsx` because that is
   * a shared surface with 25 other call sites and the same latent bug
   * (modules.md §4). This branch unblocks its own flow and reports the rest.
   */
  const [sendOpen, setSendOpen] = useState(false);

  const run = (action: () => Promise<{ error: string | null; message?: string | null }>) =>
    startTransition(async () => {
      setFeedback(await action());
      router.refresh();
    });

  const busy = pending || blastQueue.sending;

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

        <AlertDialog open={sendOpen} onOpenChange={setSendOpen}>
          <AlertDialogTrigger
            render={
              <Button variant="default" disabled={busy || queued === 0}>
                {blastQueue.sending ? <Spinner /> : null}
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
              <AlertDialogAction
                onClick={() => {
                  setSendOpen(false);
                  blastQueue.start();
                }}
              >
                Send now
              </AlertDialogAction>
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
