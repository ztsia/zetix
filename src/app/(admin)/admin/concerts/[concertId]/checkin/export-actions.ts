'use server';

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole } from '@/lib/auth/mask';
import { getScanLog, type ScanLogSort } from '@/lib/checkin/dashboard';
import { listWalkIns } from '@/lib/checkin/walk-ins';
import { idSchema } from '@/lib/commands/selection';
import { EXPORT_INPUT_ERROR, type ExportResult } from '@/lib/export/sorting';

/**
 * One row of the door's export: a scan or a walk-in (spec/v3.md §32.1, §32.2).
 * "The record of the night" is both, so the file carries both, told apart by
 * `kind`, in time order.
 */
export type DoorLogRow = {
  kind: 'Scan' | 'Walk-in';
  at: string;
  name: string;
  ticketCode: string | null;
  headcount: number;
  status: string | null;
  operatorName: string | null;
  deviceId: string | null;
  source: string;
  reason: string | null;
  revertedAt: string | null;
};

const inputSchema = z.object({
  concertId: idSchema,
  showId: idSchema,
  search: z.string().max(200),
  includeReverted: z.boolean(),
});

/**
 * The scan log's export: every matching scan, never the page, and every walk-in
 * of the show. `ADMIN` only; the show is re-checked against the concert so an
 * id from elsewhere exports nothing.
 */
export async function exportDoorLogAction(input: unknown): Promise<ExportResult<DoorLogRow>> {
  const user = await requireRole('ADMIN');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: EXPORT_INPUT_ERROR };
  const { concertId, showId, search, includeReverted } = parsed.data;

  const [show] = await getDb().execute<{ id: string }>(sql`
    select id from shows where id = ${showId} and concert_id = ${concertId}
  `);
  if (!show) return [];

  const [scans, walkIns] = await Promise.all([
    getScanLog({
      showId,
      pageIndex: 0,
      pageSize: null,
      sort: 'scannedAt' satisfies ScanLogSort,
      desc: false,
      search,
      includeReverted,
    }),
    listWalkIns(showId, { includeReverted }),
  ]);

  const term = search.trim().toLowerCase();
  const rows: DoorLogRow[] = [
    ...scans.rows.map((r) => ({
      kind: 'Scan' as const,
      at: r.scannedAt,
      name: r.attendeeName,
      ticketCode: r.ticketCode,
      headcount: 1,
      status: r.status,
      operatorName: r.operatorName,
      deviceId: r.deviceId,
      source: r.source,
      reason: r.overrideReason,
      revertedAt: r.revertedAt,
    })),
    ...walkIns
      // The log's search applies to walk-ins by their note and operator.
      .filter(
        (w) =>
          !term ||
          (w.label ?? '').toLowerCase().includes(term) ||
          (w.operatorName ?? '').toLowerCase().includes(term) ||
          (w.deviceId ?? '').toLowerCase().includes(term),
      )
      .map((w) => ({
        kind: 'Walk-in' as const,
        at: w.admittedAt,
        name: w.label ?? 'Walk-in',
        ticketCode: null,
        headcount: w.headcount,
        status: null,
        operatorName: w.operatorName,
        deviceId: w.deviceId,
        source: 'WALK_IN',
        reason: null,
        revertedAt: w.revertedAt,
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return maskForRole(user.role, rows);
}
