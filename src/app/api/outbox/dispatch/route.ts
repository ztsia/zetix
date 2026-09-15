import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { dispatchBatch } from '@/lib/email/dispatch';
import { MailNotConfiguredError } from '@/lib/email/config';
import { MissingSettingError } from '@/db/settings';
import { autoCompleteShows, type CompletionOutcome } from '@/lib/shows/complete';

/**
 * `POST /api/outbox/dispatch` — send one batch (spec/email.md §11.2).
 *
 * **A Route Handler rather than a Server Action**, because two different
 * callers need a URL: the blast screen, which posts repeatedly until the queue
 * drains, and the daily Vercel cron that acts as a safety net.
 *
 * **It must live under `/api`**, and not only by convention. `next.config.ts`
 * traces `src/assets/fonts/**` into `/api/**` only, and this route renders
 * ticket PDFs — a dispatcher anywhere else would find no fonts and fail in
 * production alone, in the ticket path, on the day tickets go out. Module `D`
 * recorded that trap for exactly this route.
 */
export const runtime = 'nodejs';

/**
 * Vercel Hobby's ceiling, against a 10s default (§11.1). A send costs roughly
 * 1–2s including the SMTP handshake, and `email.max_per_dispatch` is sized
 * against this number — so lowering one without the other silently truncates
 * every batch at the timeout.
 */
export const maxDuration = 60;

/**
 * Two callers, two credentials, and no third way in.
 *
 * `/api` is excluded from the proxy matcher, so this route is unprotected until
 * it checks for itself (modules.md §5.2.1). It sends real email to real people:
 * an unauthenticated POST here would let anyone drain the outbox at a time
 * nobody chose.
 */
async function authorize(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (secret && auth === `Bearer ${secret}`) return true;

  const user = await getSessionUser();
  return user?.role === 'ADMIN';
}

/**
 * **Vercel Cron issues a `GET`.** It does not send `POST`, and a cron pointing
 * at a route with only a `POST` handler gets a `405` every day — silently, since
 * nothing reads the cron's response. That was the state of this route until
 * module `N` hung auto-completion off it and had to check the hook actually
 * fires. The blast screen keeps posting; the daily safety net gets the verb it
 * actually uses.
 *
 * `GET` also runs the show sweep, which `POST` deliberately does not: see
 * {@link runDispatch}.
 */
export async function GET(request: Request) {
  return runDispatch(request, { sweepShows: true });
}

export async function POST(request: Request) {
  /**
   * **The admin's own Send button does not complete shows.** It is pressed to
   * drain a queue, and a status change is not a thing an admin asks for by
   * pressing Send — §13.5.3's manual twin for completion is the show's status
   * dialog, which is where an admin would look for it.
   */
  return runDispatch(request, { sweepShows: false });
}

async function runDispatch(
  request: Request,
  options: { sweepShows: boolean },
): Promise<NextResponse> {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  /**
   * **Shows are swept before the queue is drained**, so a show that became over
   * since the last run has its feedback rows in the outbox before this same call
   * looks for due rows. They will not usually go out in this batch — they are
   * scheduled for `portal.feedback_send_hour` — but the ordering costs nothing
   * and means a show completed at 11pm with a send hour already past today is
   * not waiting an extra day.
   *
   * **A sweep failure never stops the dispatch.** Draining the queue is the
   * safety net this cron exists for (spec/email.md §11.2 step 4); tickets
   * nobody received matter more than a flag nobody looks at.
   */
  let completions: CompletionOutcome[] = [];
  let sweepError: string | null = null;
  if (options.sweepShows) {
    try {
      completions = await autoCompleteShows();
    } catch (error) {
      sweepError = error instanceof Error ? error.message : 'Show sweep failed.';
    }
  }

  try {
    const result = await dispatchBatch();
    return NextResponse.json({ ...result, completions, sweepError });
  } catch (error) {
    /**
     * Configuration failures are the admin's to fix and are reported as such,
     * rather than as a 500 that reads like the platform broke. A missing
     * `email.*` setting and an absent Gmail password both present identically
     * otherwise — nothing sends, and nothing says why.
     */
    if (error instanceof MailNotConfiguredError || error instanceof MissingSettingError) {
      return NextResponse.json({ error: error.message, completions, sweepError }, { status: 503 });
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'dispatch failed',
        completions,
        sweepError,
      },
      { status: 500 },
    );
  }
}
