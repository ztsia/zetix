import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { resolveSetting } from '@/db/settings';
import { getSessionUser } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/guards';
import { canAccessShow } from '@/lib/auth/show-access';
import { recordRejectedSync } from '@/lib/checkin/rejected-sync';
import { recordWalkIn, type WalkInOutcome } from '@/lib/checkin/walk-ins';

/**
 * `POST /api/checkin/walk-ins` — walk-ins reaching the server
 * (spec/v3.md §32.2, decision 58).
 *
 * Synced in the same loop as scans and **under the same assignment check**,
 * re-verified on every write including a delayed drain: an assignment revoked
 * mid-event takes effect on the next sync, and a refused batch reaches the
 * desk's rejected-sync alert rather than vanishing (§14.3).
 *
 * Row by row, like the scan route: one bad row is refused by itself, with a
 * reason the phone shows under "couldn't sync", and never blocks the rest.
 *
 * **The settings are re-resolved here, not trusted from the phone** (§32.5):
 * walk-ins off refuses the row, and a headcount above
 * `checkin.walk_in_max_headcount` is refused as the typo it most likely is.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A request-size bound, as on the scan route; not an operational value. */
const MAX_PER_REQUEST = 500;

const walkInSchema = z.object({
  clientId: z.string().uuid(),
  // The column's own bound; the operational cap is the setting, checked below.
  headcount: z.number().int().positive().max(2_147_483_647),
  label: z.string().trim().max(200).nullable().optional(),
  segmentId: z.number().int().positive().nullable().optional(),
  admittedAt: z.string().datetime(),
  deviceId: z.string().min(1).max(120),
});

const bodySchema = z.object({
  showId: z.number().int().positive(),
  walkIns: z.array(z.unknown()).min(1).max(MAX_PER_REQUEST),
});

type Receipt = { index: number; clientId: string | null } & WalkInOutcome;

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!hasRole(user, 'ADMIN', 'OPERATOR')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Malformed walk-in batch' }, { status: 400 });
  }
  const { showId } = parsed.data;
  const rows = parsed.data.walkIns.map((raw) => walkInSchema.safeParse(raw));
  const valid = rows.flatMap((row) => (row.success ? [row.data] : []));

  if (!(await canAccessShow(user, showId))) {
    await recordRejectedSync({
      userId: user.id,
      showId,
      deviceId: valid[0]?.deviceId ?? null,
      scannedAts: valid.map((w) => w.admittedAt),
    });
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const [show] = await getDb().execute<{ concert_id: string }>(sql`
    select concert_id from shows where id = ${showId}
  `);
  const scope = { showId, concertId: show ? Number(show.concert_id) : undefined };
  const [enabled, max] = await Promise.all([
    resolveSetting<boolean>('checkin.walk_ins_enabled', scope),
    resolveSetting<number>('checkin.walk_in_max_headcount', scope),
  ]);

  const receipts: Receipt[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.success) {
      const raw = parsed.data.walkIns[index] as { clientId?: unknown } | null;
      const clientId = typeof raw?.clientId === 'string' ? raw.clientId.slice(0, 64) : null;
      receipts.push({ index, clientId, outcome: 'REFUSED', reason: 'The server could not read this walk-in.' });
      continue;
    }
    const w = row.data;
    if (enabled !== true) {
      receipts.push({ index, clientId: w.clientId, outcome: 'REFUSED', reason: 'Walk-ins are turned off for this concert.' });
      continue;
    }
    /**
     * **No cap set means no walk-ins**, never no limit (spec/v3.md §32.5): the
     * setting is seeded, so a null here is a misconfiguration to surface, and
     * an uncapped headcount is how 2147483647 people walked in during QA.
     */
    if (typeof max !== 'number') {
      receipts.push({
        index,
        clientId: w.clientId,
        outcome: 'REFUSED',
        reason: 'No largest walk-in group is set for this concert. Ask the desk to set one.',
      });
      continue;
    }
    if (w.headcount > max) {
      receipts.push({
        index,
        clientId: w.clientId,
        outcome: 'REFUSED',
        reason: `One walk-in may record at most ${max} people. Record a larger group in parts, or ask the desk.`,
      });
      continue;
    }
    const outcome = await recordWalkIn(
      {
        clientId: w.clientId,
        headcount: w.headcount,
        label: w.label || null,
        segmentId: w.segmentId ?? null,
        admittedAt: w.admittedAt,
        deviceId: w.deviceId,
      },
      { showId, operatorId: user.id },
    );
    receipts.push({ index, clientId: w.clientId, ...outcome });
  }

  return NextResponse.json({ receipts }, { headers: { 'Cache-Control': 'no-store' } });
}
