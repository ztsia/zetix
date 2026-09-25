'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MailIcon, XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import type { OutboxBacklog } from '@/lib/email/dispatch';
import { useCanEdit } from '@/components/auth/role';

/**
 * The dispatch loop and its banner (spec/email.md §11.2.1, surfaces.md §15.1).
 *
 * **The loop lives here, in the shell, rather than on the blast screen**, and
 * that is the whole point of this module rather than a tidying-up of it. A full
 * concert is around 130 messages against `email.max_per_dispatch` — six or so
 * dispatch calls and roughly five minutes of continuous sending, which is long
 * enough that an admin will navigate away. A loop in the blast screen's
 * component state dies the moment they do.
 *
 * Nothing is lost when it stops — `ticket_sent_at` and the partial unique index
 * make a resumed run send each message at most once (§11.4). The failure is
 * **silence**: a halted blast is indistinguishable from a finished one, and the
 * admin's next signal is a registrant asking where their ticket is.
 *
 * Two sources, deliberately:
 *
 * - **Is there unfinished work?** `email_outbox`, read by the layout on every
 *   render. That is what survives a reload, a closed tab and a dead laptop —
 *   client state survives none of them.
 * - **How is the current run going?** What each dispatch call returns, exactly
 *   as §11.2 step 3 requires. Never a client-side estimate of what the server
 *   is probably up to.
 */

type Progress = { sent: number; failed: number; total: number };

type Outcome =
  | { kind: 'done'; message: string }
  | { kind: 'capped'; message: string }
  | { kind: 'error'; message: string };

type BlastQueue = {
  /** True while this tab is driving the loop, so Send can disable itself. */
  sending: boolean;
  /** Starts the loop. Safe to call twice — the second call is a no-op. */
  start: () => void;
};

type BlastQueueState = BlastQueue & {
  backlog: OutboxBacklog;
  progress: Progress | null;
  outcome: Outcome | null;
  liveBacklog: OutboxBacklog | null;
  dismissed: boolean;
  dismiss: () => void;
};

const BlastQueueContext = createContext<BlastQueueState | null>(null);

/**
 * Read by the blast screen so **Send** can start the shell's loop instead of
 * owning one of its own (§11.2.1). It throws rather than returning a no-op
 * outside the admin shell: a Send button that silently does nothing is the
 * failure this whole module exists to remove.
 */
export function useBlastQueue(): BlastQueue {
  const context = useContext(BlastQueueContext);
  if (!context) throw new Error('useBlastQueue must be used inside the admin shell.');
  return { sending: context.sending, start: context.start };
}

export function BlastQueueProvider({
  backlog,
  children,
}: {
  backlog: OutboxBacklog;
  children: React.ReactNode;
}) {
  const router = useRouter();

  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [dismissed, setDismissed] = useState(false);

  /**
   * The queue as the last dispatch call left it, which is fresher than the
   * server render that started the page. Cleared whenever a new server render
   * arrives and we are not mid-run, so the database always gets the last word.
   */
  const [liveBacklog, setLiveBacklog] = useState<OutboxBacklog | null>(null);

  /**
   * A ref, not the `sending` state, because the guard has to hold **within one
   * render** — two clicks on Send land before React re-renders, and state would
   * let the second one start a second loop.
   */
  const running = useRef(false);
  const backlogRef = useRef(backlog);
  backlogRef.current = backlog;

  useEffect(() => {
    if (!running.current) setLiveBacklog(null);
  }, [backlog]);

  const start = useCallback(() => {
    if (running.current) return;
    running.current = true;

    setSending(true);
    setDismissed(false);
    setOutcome(null);
    setProgress({ sent: 0, failed: 0, total: backlogRef.current.resumable });

    void (async () => {
      let sent = 0;
      let failed = 0;

      try {
        /**
         * One call per batch until the queue drains (§11.2 step 3). Each call
         * is a separate request inside `maxDuration`, so a long blast is many
         * short functions rather than one that times out.
         */
        for (;;) {
          const response = await fetch('/api/outbox/dispatch', { method: 'POST' });
          const result = await response.json().catch(() => ({}));

          if (!response.ok) {
            setOutcome({ kind: 'error', message: result.error ?? 'Dispatch failed.' });
            break;
          }

          sent += result.sent ?? 0;
          failed += result.failed ?? 0;
          const remaining = result.remaining ?? 0;

          /**
           * **The total is recomputed from the server's own count every round**,
           * rather than captured when Send was pressed. A figure captured once
           * is wrong the moment anything else touches the queue — the cron
           * taking a batch, a second prepare, §11.4's added-guest case — and a
           * progress bar that reads 112 of 96 is worse than none. This one
           * cannot disagree with the database for longer than a batch.
           */
          setLiveBacklog(result.backlog ?? null);
          /**
           * The denominator is what is still **sendable**, not every `QUEUED`
           * row. A batch that failed into its retry backoff has done everything
           * this run can do, and counting those rows as outstanding would leave
           * the bar stuck at half over a run that had finished.
           */
          setProgress({
            sent,
            failed,
            total: sent + failed + (result.backlog?.resumable ?? remaining),
          });

          if (result.dailyCapReached) {
            setOutcome({
              kind: 'capped',
              message: `${remaining} message(s) will go out tomorrow.`,
            });
            break;
          }

          // A batch that sent and failed nothing has nothing left it can do;
          // stopping here is what prevents an endless loop against a
          // permanently stuck row.
          if (remaining === 0 || (result.sent === 0 && result.failed === 0)) {
            setOutcome({
              kind: 'done',
              message:
                `${sent} sent` +
                (failed > 0 ? `, ${failed} failed — see Last error in the outbox table` : '') +
                '.',
            });
            break;
          }
        }
      } catch (error) {
        setOutcome({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Dispatch failed.',
        });
      } finally {
        running.current = false;
        setSending(false);
        router.refresh();
      }
    })();
  }, [router]);

  return (
    <BlastQueueContext.Provider
      value={{
        sending,
        start,
        backlog,
        progress,
        outcome,
        liveBacklog,
        dismissed,
        dismiss: () => setDismissed(true),
      }}
    >
      {children}
    </BlastQueueContext.Provider>
  );
}

type Tone = 'sending' | 'capped' | 'error' | 'stalled' | 'retrying' | 'inflight' | 'failed' | 'done';

type View = {
  tone: Tone;
  label: string;
  title: string;
  description: string;
  canResume: boolean;
};

/**
 * The banner, mounted above the content area on every admin route
 * (surfaces.md §15.1).
 *
 * **It is the loop's UI, not a mirror of the blast screen's.** A banner that
 * only reported what the blast screen was doing would still go dark the moment
 * that screen unmounted, which is the bug.
 *
 * **Dismiss hides the banner. It never stops the send** (§11.2.1): a control
 * that silently halts delivery halfway through a blast is worse than no control
 * at all. A Stop, if it is ever wanted, is a separate `AlertDialog`-confirmed
 * action and not this button.
 */
export function BlastQueueBanner() {
  const context = useContext(BlastQueueContext);
  const canEdit = useCanEdit();
  if (!context) return null;

  const { backlog, sending, progress, outcome, liveBacklog, dismissed, dismiss, start } = context;
  // A viewer sees the queue's state but cannot drive it (spec/v3.md §28): the
  // dispatch route refuses them, so Resume would be a button that fails.

  const live = liveBacklog ?? backlog;
  const queued = live.resumable;
  const retrying = live.retrying;
  const permanentlyFailed = live.failed;
  /**
   * While this tab is sending, rows sit in `SENDING` because *we* put them
   * there; reporting them as stranded would be alarming and wrong.
   */
  const inFlight = sending ? 0 : live.inFlight;

  const counts = progress
    ? `${progress.sent} sent, ${progress.failed} failed of ${progress.total}`
    : null;
  const failed = progress?.failed ?? 0;

  const view = ((): View | null => {
    if (sending) {
      return {
        tone: 'sending',
        label: 'Sending',
        title: 'Blast in progress',
        description: counts ?? 'Starting…',
        canResume: false,
      };
    }

    /**
     * The daily cap gets its own state rather than looking like a stall
     * (`email.max_per_day`). Offering Resume here would offer a button that
     * cannot do anything until tomorrow, and a control that does nothing reads
     * as a broken one.
     */
    if (outcome?.kind === 'capped') {
      return {
        tone: 'capped',
        label: 'Paused',
        title: 'Daily send limit reached',
        description: `${outcome.message} The nightly dispatch picks them up on its own.`,
        canResume: false,
      };
    }

    if (outcome?.kind === 'error') {
      return {
        tone: 'error',
        label: 'Stopped',
        title: 'Blast stopped',
        description: counts ? `${outcome.message} ${counts}.` : outcome.message,
        canResume: queued > 0,
      };
    }

    // Queued rows with nothing sending is exactly what a stopped blast leaves
    // behind, and the state §11.2.1 requires Resume to be offered for.
    if (queued > 0) {
      return {
        tone: 'stalled',
        label: 'Waiting',
        title: 'Unfinished blast',
        description: outcome
          ? `${outcome.message} ${queued} message(s) still queued.`
          : `${queued} message(s) are queued and nothing is sending them.`,
        canResume: true,
      };
    }

    /**
     * A failed message goes back to `QUEUED` with `scheduled_for` in the future
     * (§11.2), and `claimBatch()` will not take it until then. It is still
     * unfinished work and still belongs on the banner — but offering Resume for
     * it would be the daily cap's mistake in another costume: a button that
     * cannot do the thing it names.
     */
    if (retrying > 0) {
      return {
        tone: 'retrying',
        label: 'Retrying',
        title: 'Messages waiting to retry',
        description: outcome
          ? `${outcome.message} ${retrying} message(s) will be retried automatically.`
          : `${retrying} message(s) failed and will be retried automatically.`,
        canResume: false,
      };
    }

    /**
     * Rows stranded in `SENDING` by a dispatch that died mid-batch, but too
     * recent for `reclaimStranded()` to take back yet. Resume cannot reach them
     * and must not pretend otherwise — they return to the queue on their own.
     */
    if (inFlight > 0) {
      return {
        tone: 'inflight',
        label: 'In flight',
        title: 'Messages mid-send',
        description: `${inFlight} message(s) are being sent. If that send has stopped they return to the queue automatically.`,
        canResume: false,
      };
    }

    /**
     * The finished state keeps the **full counts**, not just the total sent.
     * "4 sent" and "4 sent, 0 failed of 4" answer different questions, and the
     * second is the one an admin closing the console needs: it says what the
     * run set out to do as well as what it managed.
     */
    /**
     * Out of attempts. Nothing will retry these and Resume cannot reach them,
     * but they are tickets nobody received — clearing the banner over them
     * would be exactly the silence §11.2.1 exists to end. They go when someone
     * resends them or marks them delivered by hand (§11.6).
     */
    if (permanentlyFailed > 0) {
      return {
        tone: 'failed',
        label: 'Not delivered',
        title: 'Messages that failed for good',
        description:
          `${permanentlyFailed} message(s) ran out of attempts and were never delivered. ` +
          'Read Last error in the outbox table, then resend them.',
        canResume: false,
      };
    }

    if (outcome?.kind === 'done') {
      return {
        tone: 'done',
        label: failed > 0 ? 'Finished with failures' : 'Sent',
        title: 'Blast finished',
        description: counts
          ? `${counts}.${failed > 0 ? ' See Last error in the outbox table.' : ''}`
          : outcome.message,
        canResume: false,
      };
    }

    return null;
  })();

  if (!view || dismissed) return null;

  const destructive =
    view.tone === 'error' || view.tone === 'retrying' || view.tone === 'failed' || failed > 0;
  const pct =
    progress && progress.total > 0
      ? Math.min(100, ((progress.sent + progress.failed) / progress.total) * 100)
      : 0;

  return (
    <Item variant="outline" size="sm" className="mx-4 mt-4 md:mx-6">
      <ItemMedia variant="icon">
        <MailIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {view.title}
          <Badge variant={destructive ? 'destructive' : 'secondary'}>
            {view.tone === 'sending' ? <Spinner data-icon="inline-start" /> : null}
            {view.label}
          </Badge>
        </ItemTitle>
        <ItemDescription aria-live="polite">{view.description}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {view.canResume && canEdit ? (
          <Button variant="outline" onClick={start}>
            Resume
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" aria-label="Hide this banner" onClick={dismiss}>
          <XIcon />
        </Button>
      </ItemActions>
      {progress ? (
        <ItemFooter>
          {/* `Progress`'s root is a bare flex box, so without a width it
              collapses to nothing inside the footer's own flex row. */}
          <Progress value={pct} className="w-full" />
        </ItemFooter>
      ) : null}
    </Item>
  );
}
