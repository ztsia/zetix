import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { dispatchBatch } from '@/lib/email/dispatch';
import { MailNotConfiguredError } from '@/lib/email/config';
import { MissingSettingError } from '@/db/settings';

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

export async function POST(request: Request) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await dispatchBatch();
    return NextResponse.json(result);
  } catch (error) {
    /**
     * Configuration failures are the admin's to fix and are reported as such,
     * rather than as a 500 that reads like the platform broke. A missing
     * `email.*` setting and an absent Gmail password both present identically
     * otherwise — nothing sends, and nothing says why.
     */
    if (error instanceof MailNotConfiguredError || error instanceof MissingSettingError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'dispatch failed' },
      { status: 500 },
    );
  }
}
