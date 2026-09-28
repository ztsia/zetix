import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runTick, TICK_SOURCES, type TickSource } from '@/lib/scheduler/tick';

/**
 * `/api/scheduler/tick` — the scheduler's one route (spec/v3.md §27).
 *
 * Called every `scheduler.tick_minutes` by Supabase `pg_cron` + `pg_net`
 * (`POST`, body `{"source":"pg_cron"}`), and daily by Vercel Cron as the
 * fallback (`GET` — Vercel Cron only ever issues `GET`; `/api/outbox/dispatch`
 * learned that the hard way).
 *
 * **Under `/api`, `nodejs`, 60 seconds**, for the same reasons as the dispatch
 * route: it sends email and renders ticket PDFs, `next.config.ts` traces the
 * fonts into `/api/**` only, and the tick's budget is sized against Vercel
 * Hobby's ceiling.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * **A bearer secret and nothing else** (§27.1): `CRON_SECRET`, which is also
 * the Vault secret `zetix_scheduler_secret` that `pg_cron` sends. No session is
 * accepted — the console has its own loops and needs no way in here — and an
 * unset secret refuses everyone rather than admitting everyone: this route
 * sends real email.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || !auth) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(auth);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function sourceOf(value: unknown): TickSource {
  return (TICK_SOURCES as readonly unknown[]).includes(value) ? (value as TickSource) : 'unknown';
}

async function tick(source: TickSource): Promise<NextResponse> {
  try {
    const report = await runTick({ source });
    return NextResponse.json(report);
  } catch (error) {
    // Only the heartbeat write itself can land here: every step reports its own
    // failure. The reason stays in the server log, not in the body — pg_net keeps
    // every response in `net._http_response`, and an error can quote guest data.
    console.error('scheduler tick failed', error);
    return NextResponse.json({ error: 'tick failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return tick('vercel_cron');
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { source?: unknown } | null;
  return tick(sourceOf(body?.source));
}
