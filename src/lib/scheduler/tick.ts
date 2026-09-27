import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { resolveSetting } from '@/db/settings';
import { continueRegisteredRuns } from '@/lib/commands/registry';
import type { ContinueSummary } from '@/lib/commands/runner';
import { dispatchBatch, MAX_DISPATCH_SECONDS, type DispatchResult } from '@/lib/email/dispatch';
import { runInboxSync, type InboxRunResult } from '@/lib/inbox/run';
import type { MailInbox } from '@/lib/mail/inbox';
import type { MailTransport } from '@/lib/mail/transport';
import { autoCompleteShows, type CompletionOutcome } from '@/lib/shows/complete';

/**
 * The scheduler tick (spec/v3.md §27.1): one pass of everything that happens
 * without a person pressing a button, in a fixed order, inside one function
 * invocation.
 *
 * 1. **Complete shows** that are over, which queues their feedback.
 * 2. **Send what is due**: receipts past their hold, queued messages, due
 *    feedback — every `QUEUED` row whose `scheduled_for` has come.
 * 3. **Continue unfinished command runs** (§23.1).
 * 4. **Sync the inbox** (§26.3).
 *
 * Each step reports rather than throws, so one failing step — a mailbox that
 * will not answer, a missing setting — never stops the ones after it. The
 * whole pass is recorded in `scheduler_heartbeat`, which Home reads to warn
 * when the scheduler has gone quiet (§27.2).
 */

export const TICK_SOURCES = ['pg_cron', 'vercel_cron', 'manual'] as const;
export type TickSource = (typeof TICK_SOURCES)[number] | 'unknown';

/**
 * The tick's whole time budget, in ms: four fifths of the function's
 * `maxDuration`, leaving the rest for the heartbeat write and the response.
 * Mirrors {@link MAX_DISPATCH_SECONDS}, the same runtime ceiling; not an
 * operational value.
 */
export const TICK_BUDGET_MS = MAX_DISPATCH_SECONDS * 1000 * 0.8;

type Step<T> = { ok: true; result: T; ms: number } | { ok: false; error: string; ms: number };

export type TickReport = {
  source: TickSource;
  completions: Step<CompletionOutcome[]>;
  dispatch: Step<Omit<DispatchResult, 'backlog'>>;
  runs: Step<ContinueSummary>;
  inbox: Step<InboxRunResult>;
  trimmed: number;
};

async function step<T>(work: () => Promise<T>): Promise<Step<T>> {
  const started = Date.now();
  try {
    return { ok: true, result: await work(), ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

export type TickOptions = {
  source: TickSource;
  /** Injected by tests. */
  transport?: MailTransport;
  inbox?: MailInbox;
  mailbox?: string;
  /** Overrides {@link TICK_BUDGET_MS}; tests cannot spend 48 seconds proving a deadline. */
  budgetMs?: number;
};

/** The one-line summary stored in `scheduler_heartbeat.error` when any step failed. */
function failures(report: Omit<TickReport, 'trimmed'>): string | null {
  const failed: string[] = [];
  if (!report.completions.ok) failed.push(`complete shows: ${report.completions.error}`);
  if (!report.dispatch.ok) failed.push(`send: ${report.dispatch.error}`);
  if (!report.runs.ok) failed.push(`command runs: ${report.runs.error}`);
  if (!report.inbox.ok) failed.push(`inbox: ${report.inbox.error}`);
  else if (report.inbox.result.status === 'failed') failed.push(`inbox: ${report.inbox.result.error}`);
  return failed.length > 0 ? failed.join('; ').slice(0, 2000) : null;
}

export async function runTick(options: TickOptions): Promise<TickReport & { heartbeatId: number }> {
  const startedAt = Date.now();
  const end = startedAt + (options.budgetMs ?? TICK_BUDGET_MS);
  const db = getDb();

  const [beat] = await db.execute<{ id: string }>(sql`
    insert into scheduler_heartbeat (source, started_at) values (${options.source}, now()) returning id`);
  const heartbeatId = Number(beat.id);

  /**
   * The inbox's share is reserved first, from `inbox.sync_budget_seconds`, so
   * a long send never starves it; sending then gets half of what remains
   * before it, and command runs the rest. Sending's window bounds when a
   * message may *start*, so an overrun comes out of the runs' share, never
   * out of the inbox's.
   */
  const syncSeconds = Number((await resolveSetting<number>('inbox.sync_budget_seconds').catch(() => null)) ?? 0);
  const syncReserve = Math.min(Math.max(0, syncSeconds * 1000), (end - startedAt) / 2);
  const beforeSync = end - syncReserve;

  const completions = await step(() => autoCompleteShows());

  const dispatch = await step(async () => {
    const sendWindowMs = Math.max(0, (beforeSync - Date.now()) / 2);
    // No window left means no message may start; skip rather than send one anyway.
    if (sendWindowMs <= 0) return { sent: 0, failed: 0, deferred: 0, remaining: 0, dailyCapReached: false, warnings: [], reclaimed: 0 };
    const result: Partial<DispatchResult> = await dispatchBatch({ transport: options.transport, sendWindowMs });
    // The banner's backlog is for a screen, not for the heartbeat.
    delete result.backlog;
    return result as Omit<DispatchResult, 'backlog'>;
  });

  const runs = await step(() => continueRegisteredRuns(beforeSync));

  const inbox = await step(() =>
    runInboxSync({ deadline: end, inbox: options.inbox, mailbox: options.mailbox }),
  );

  const partial = { source: options.source, completions, dispatch, runs, inbox };

  // History is bounded like pg_cron's own (`scheduler.history_days`, §27.2).
  const historyDays = await resolveSetting<number>('scheduler.history_days').catch(() => null);
  let trimmed = 0;
  if (typeof historyDays === 'number' && historyDays >= 1) {
    const removed = await db.execute<{ id: string }>(sql`
      delete from scheduler_heartbeat
       where started_at < now() - (interval '1 day' * ${historyDays})
       returning id`);
    trimmed = removed.length;
  }

  const report: TickReport = { ...partial, trimmed };
  await db.execute(sql`
    update scheduler_heartbeat
       set finished_at = now(), report = ${JSON.stringify(report)}::jsonb, error = ${failures(partial)}
     where id = ${heartbeatId}`);
  return { ...report, heartbeatId };
}

export type Heartbeat = {
  source: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

/** The newest tick, for Home and the Inbox (§27.2). Null when the scheduler has never run. */
export async function lastHeartbeat(): Promise<Heartbeat | null> {
  const [row] = await getDb().execute<{
    source: string;
    started_at: string;
    finished_at: string | null;
    error: string | null;
  }>(sql`
    select source, to_json(started_at) #>> '{}' as started_at, to_json(finished_at) #>> '{}' as finished_at, error
      from scheduler_heartbeat
     order by started_at desc, id desc
     limit 1`);
  return row
    ? { source: row.source, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error }
    : null;
}
