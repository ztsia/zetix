import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { canAccessShow } from '@/lib/auth/show-access';
import { recordRejectedSync } from '@/lib/checkin/rejected-sync';

/**
 * `POST /api/checkin/scan` — admissions reaching the server
 * (spec/checkin.md §12.3).
 *
 * **One endpoint for both paths, deliberately.** Online, the scanner posts each
 * admission as it happens; offline, the queue drains here on reconnect with the
 * original `scanned_at` preserved and `source = OFFLINE_SYNC`. Splitting them
 * would give the write two authorization paths, and the one that gets used
 * least is the one that rots.
 *
 * **Assignment is re-verified on every write, including a delayed drain.** An
 * assignment revoked mid-event takes effect on the next sync rather than being
 * trusted from a client that may have been offline since before it changed
 * (§12.3). The queue carries no authority of its own.
 *
 * **Handler-only authorization, and that is decision 20b's explicit scope.**
 * The manifest read goes through `manifest_for_show()` because it is the whole
 * attendee roster; a scan write is one row in an append-only, revertible log
 * (decision 7), keyed by a token the operator is physically holding. Its worst
 * failure is a bad row somebody reverts, not the disclosure of four hundred
 * names — so routing a batch drain through PostgREST would buy a second layer
 * on the cheaper of the two risks.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scans accepted in one drain.
 *
 * Not an operational value in CLAUDE.md's sense — no capacity, quota, deadline
 * or cap from `context.md` is involved. It is a request-size bound, sized so a
 * phone that was offline for the entire arrival window still drains in one
 * request at this concert's scale.
 */
const MAX_SCANS_PER_REQUEST = 500;

const scanSchema = z.object({
  /** The digest, never the token: the phone's queue must not hold usable tickets. */
  qrTokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** When the *phone* read it. Preserved verbatim through a delayed sync. */
  scannedAt: z.string().datetime(),
  source: z.enum(['ONLINE', 'OFFLINE_SYNC', 'MANUAL']),
  deviceId: z.string().min(1).max(120),
  /** Why an usher admitted an amber or red result (spec/README.md §2.4). */
  overrideReason: z.string().max(500).nullable().optional(),
});

const bodySchema = z.object({
  showId: z.number().int().positive(),
  scans: z.array(scanSchema).min(1).max(MAX_SCANS_PER_REQUEST),
});

type ScanInput = z.infer<typeof scanSchema>;

type ScanReceipt = {
  qrTokenSha256: string;
  outcome: 'RECORDED' | 'ALREADY_SYNCED' | 'WRONG_SHOW' | 'NOT_FOUND';
  attendeeId?: number;
  /** The earliest surviving scan, when this attendee had already been through. */
  firstScan?: { at: string; operatorName: string | null } | null;
  /** How many live rows this attendee now has. Above one is the multi-scan flag. */
  scanCount?: number;
  /** Named when the ticket turned out to belong to another show. */
  showName?: string | null;
};

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Malformed scan batch' }, { status: 400 });
  }
  const { showId, scans } = parsed.data;

  // 404 rather than 403, for the same reason as the manifest: probing ids must
  // not distinguish "not yours" from "not there" (modules.md §5.2.1).
  if (!(await canAccessShow(user, showId))) {
    /**
     * Refused, and the admin is told (spec/admin.md §14.3, module `H`).
     *
     * §14.3 requires both halves of this: a revoked assignment's queued scans
     * are "rejected on sync **and surfaced to the admin rather than silently
     * dropped**". The people in that batch were physically admitted by an usher
     * whose phone still believed it was rostered — they are in the hall and, on
     * the rejection alone, nowhere in the database.
     *
     * The response below is unchanged, so the caller still learns nothing. Only
     * the desk finds out.
     */
    await recordRejectedSync({
      userId: user.id,
      showId,
      deviceId: scans[0]?.deviceId ?? null,
      scannedAts: scans.map((scan) => scan.scannedAt),
    });
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = getDb();
  const receipts: ScanReceipt[] = [];

  /**
   * One transaction for the whole drain.
   *
   * Not for locking — there is deliberately none here. §12.3: duplicates across
   * two offline devices resolve only on sync, the server accepts both and flags
   * the attendee as multi-scanned, and distributed locking is explicitly not
   * attempted. A phone that admitted somebody has already admitted them; the
   * database's job is to record it, not to relitigate it.
   *
   * The transaction is so a drain either lands or does not, leaving the queue
   * with an unambiguous thing to retry.
   */
  await db.transaction(async (tx) => {
    for (const scan of scans) {
      receipts.push(await recordScan(tx, { scan, showId, operatorId: user.id }));
    }
  });

  return NextResponse.json({ receipts }, { headers: { 'Cache-Control': 'no-store' } });
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function recordScan(
  tx: Tx,
  { scan, showId, operatorId }: { scan: ScanInput; showId: number; operatorId: string },
): Promise<ScanReceipt> {
  /**
   * Resolve the digest to an attendee **within this show**.
   *
   * The hash is computed over the column rather than stored, so there is no
   * index to hit — but the `show_id` predicate uses `attendees_show_status_idx`
   * first, which reduces this to a few hundred rows at this concert's scale.
   * If a future concert makes that untrue, the fix is a generated column and a
   * schema PR against `main` (modules.md §4), not a raw token on the phone.
   */
  const found = await tx.execute<{ id: number; status: string }>(sql`
    select id, status
    from attendees
    where show_id = ${showId}
      and deleted_at is null
      and qr_token is not null
      and encode(sha256(convert_to(qr_token, 'UTF8')), 'hex') = ${scan.qrTokenSha256}
    limit 1
  `);

  const attendee = found[0];
  if (!attendee) {
    /**
     * Not in this show. Before calling it invalid, ask whether it is simply the
     * wrong show — the phone cannot know, because it holds one roster, and
     * §12.1's result table wants that named where it can be. Only reached on a
     * miss, so the unindexed scan across shows costs nothing in the common case.
     */
    const elsewhere = await tx.execute<{ show_name: string }>(sql`
      select s.name as show_name
      from attendees a
      join shows s on s.id = a.show_id
      where a.deleted_at is null
        and a.qr_token is not null
        and encode(sha256(convert_to(a.qr_token, 'UTF8')), 'hex') = ${scan.qrTokenSha256}
      limit 1
    `);

    return elsewhere[0]
      ? {
          qrTokenSha256: scan.qrTokenSha256,
          outcome: 'WRONG_SHOW',
          showName: elsewhere[0].show_name,
        }
      : { qrTokenSha256: scan.qrTokenSha256, outcome: 'NOT_FOUND' };
  }

  /**
   * **Idempotent by construction, because a drain will be retried.**
   *
   * A flaky venue network is the entire premise of the offline queue, so the
   * same batch reaching the server twice is expected rather than exceptional.
   * `(attendee_id, operator_id, scanned_at)` is the natural key: `scanned_at`
   * comes from the device at millisecond precision, and one operator scanning
   * one ticket twice in the same millisecond is not a real event. Two genuinely
   * separate scans differ in it and both land, which is what §12.3 asks for.
   *
   * `check_ins` carries no unique constraint to lean on and the schema is
   * frozen (modules.md §4), so this is a guarded insert rather than an
   * `on conflict` — the same shape the outbox uses for the same reason
   * (decision 16).
   */
  const inserted = await tx.execute<{ id: number }>(sql`
    insert into check_ins (attendee_id, show_id, operator_id, device_id, scanned_at, synced_at, source, override_reason)
    select ${attendee.id}, ${showId}, ${operatorId}, ${scan.deviceId},
           ${scan.scannedAt}::timestamptz, now(), ${scan.source}::check_in_source,
           ${scan.overrideReason ?? null}
    where not exists (
      select 1 from check_ins
      where attendee_id = ${attendee.id}
        and operator_id = ${operatorId}
        and scanned_at = ${scan.scannedAt}::timestamptz
    )
    returning id
  `);

  /**
   * What the door still needs to know: was this attendee already through, and
   * by whom. Reverted rows are excluded — a revert is the admin dashboard
   * undoing a mistake (module `H`), and a reverted scan must not make the next
   * genuine one read as a duplicate.
   */
  const live = await tx.execute<{
    scan_count: number;
    first_at: string | null;
    first_operator: string | null;
  }>(sql`
    select
      count(*)::int as scan_count,
      min(c.scanned_at)::text as first_at,
      (array_agg(u.display_name order by c.scanned_at))[1] as first_operator
    from check_ins c
    left join app_users u on u.id = c.operator_id
    where c.attendee_id = ${attendee.id}
      and c.reverted_at is null
  `);

  const stats = live[0];
  const priorCount = (stats?.scan_count ?? 1) - (inserted.length > 0 ? 1 : 0);

  return {
    qrTokenSha256: scan.qrTokenSha256,
    outcome: inserted.length > 0 ? 'RECORDED' : 'ALREADY_SYNCED',
    attendeeId: attendee.id,
    scanCount: stats?.scan_count ?? 1,
    firstScan:
      priorCount > 0 && stats?.first_at
        ? { at: new Date(stats.first_at).toISOString(), operatorName: stats.first_operator }
        : null,
  };
}
