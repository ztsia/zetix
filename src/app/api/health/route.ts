import { NextResponse } from 'next/server';
import { sql } from '@/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Keep-alive endpoint (spec.md §17.1).
 *
 * Supabase free projects pause after 7 days of inactivity and do NOT wake on
 * an incoming query — they need a manual restore. Two independent crons hit
 * this route daily: Vercel Cron and a GitHub Action, because the failure mode
 * is silent and would most likely surface a month before a concert.
 *
 * It returns the time straight from Postgres, so a 200 proves the database
 * answered rather than just that Next.js is up.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    const [row] = await sql<{ now: Date }[]>`select now() as now`;
    return NextResponse.json({ ok: true, db: row.now });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'unknown' },
      { status: 503 },
    );
  }
}
