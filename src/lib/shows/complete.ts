import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import { queueFeedbackBlast } from '@/lib/email/feedback-blast';
import { SHOW_IS_OVER } from '@/lib/portal/phase';

/**
 * Show auto-completion, and what completion sets off (spec/v2.md §13.5.2,
 * §13.5.3).
 *
 * **It runs on the existing daily dispatch cron, not on a job of its own.**
 * Vercel Hobby allows two crons and both are spent (spec/platform.md §17.1) —
 * and the precision buys nothing now that the portal phase comes off the clock
 * (decision 40). The only thing waiting on this flag is an email that is not
 * being sent until `portal.feedback_send_hour` anyway.
 *
 * **Nothing here is the portal's source of truth.** A guest's page reads
 * `SHOW_IS_OVER` directly and is correct the instant it is true; this moves a
 * flag nobody looks at and queues a message nobody reads until noon. If this
 * function never ran, the portal would still be right — which is the property
 * that let the cron stay daily.
 */

export type CompletionOutcome = {
  showId: number;
  showName: string;
  queued: number;
  /** Set when the show completed but its email could not be queued. */
  error?: string;
};

/**
 * Move every eligible show `OPEN` → `COMPLETED` and queue its feedback email.
 *
 * **`OPEN` → `COMPLETED` only.** It never touches `DRAFT` — a show nobody has
 * opened has had no audience — never touches `CLOSED`, which is an admin's
 * deliberate "we are done here", and never reopens anything. With `ends_at`
 * null it does nothing at all (decision 41).
 *
 * **Idempotent in the ordinary way rather than by a lock.** The `update` filters
 * on `status = 'OPEN'` and returns only the rows it changed, so a second run
 * finds nothing to complete and queues nothing. Two concurrent runs race on the
 * same rows and exactly one wins each; the loser's `returning` is empty, which
 * is the correct answer for it.
 */
export async function autoCompleteShows(): Promise<CompletionOutcome[]> {
  const completed = await getDb().execute<{ id: string; name: string }>(sql`
    update shows s
       set status = 'COMPLETED', updated_at = now()
     where s.status = 'OPEN'
       and s.deleted_at is null
       and ${SHOW_IS_OVER}
    returning s.id, s.name
  `);

  const outcomes: CompletionOutcome[] = [];
  for (const row of completed) {
    const showId = Number(row.id);

    await writeAuditLog({
      action: 'show.auto_completed',
      entityType: 'shows',
      entityId: showId,
      after: { status: 'COMPLETED' },
      /**
       * The cron has no session. `writeAuditLog` would otherwise resolve the
       * actor with its own query — both wrong, since no admin did this, and a
       * second connection this path does not need.
       */
      actorId: null,
    });

    /**
     * **Queued per show, and a failure on one does not stop the rest.** A
     * concert with no timezone cannot have a send hour, and that is a real
     * refusal (spec/README.md §2.1) — but it is one show's configuration
     * problem, and letting it abort the sweep would leave every later show
     * uncompleted and silently blame the cron.
     *
     * The flag is already committed by then, which is the right way round: the
     * show *is* over, and **Generate feedback emails** is the manual twin that
     * fixes the email once the timezone is set (decision 42).
     */
    try {
      const result = await queueFeedbackBlast({ showId });
      outcomes.push({ showId, showName: row.name, queued: result.queued });
    } catch (error) {
      outcomes.push({
        showId,
        showName: row.name,
        queued: 0,
        error: error instanceof Error ? error.message : 'Could not queue feedback email.',
      });
    }
  }

  return outcomes;
}
