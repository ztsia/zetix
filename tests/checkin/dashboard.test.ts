import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ARRIVAL_BUCKET_MINUTES,
  getArrivalBuckets,
  getCheckinStats,
  getDoorStats,
  getOperatorCounts,
  getScanLog,
} from '@/lib/checkin/dashboard';
import { revertCheckIn, RevertError } from '@/lib/checkin/revert';
import { closeDb, resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * The live check-in dashboard and its revert (spec/checkin.md §12.4).
 *
 * Against a **real Postgres**, because every claim this screen makes is SQL: the
 * distinct-attendee counting that makes duplicate offline scans harmless, the
 * `date_bin` bucketing, and the guarded update that makes a double revert safe.
 *
 * The scenario is one show with four confirmed attendees and one cancelled one,
 * built once and reshaped per test.
 */
const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';
const WEI_ID = '00000000-0000-4000-8000-000000000101';
const MEI_ID = '00000000-0000-4000-8000-000000000102';

afterAll(closeDb);

type Fixture = {
  concertId: number;
  showId: number;
  otherShowId: number;
  attendeeIds: number[];
  cancelledId: number;
};

async function arrange(): Promise<Fixture> {
  await resetDb();

  await sql`
    insert into app_users (id, email, display_name, role, is_active) values
      (${ADMIN_ID}, 'admin@example.test', 'Committee', 'ADMIN', true),
      (${WEI_ID}, 'wei@operators.invalid', 'Wei', 'OPERATOR', true),
      (${MEI_ID}, 'mei@operators.invalid', 'Mei', 'OPERATOR', true)
  `;

  const concertId = await createConcert('Dashboard Concert');
  const showId = await createShow(concertId, 300);
  const otherShowId = await createShow(concertId, 300);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  const registrationId = await createRegistration({ showId, segmentId });

  await seedAttendees({
    registrationId,
    showId,
    segmentId,
    count: 4,
    allocationType: 'BASE',
    status: 'CONFIRMED',
  });
  await seedAttendees({
    registrationId,
    showId,
    segmentId,
    count: 1,
    allocationType: 'BASE',
    status: 'CANCELLED',
  });

  // `seedAttendees` does not hand back ids, so they are read here in insert
  // order — the four confirmed ones first, then the cancelled one.
  const rows = await sql<{ id: number; status: string }[]>`
    select id, status from attendees where show_id = ${showId} order by id
  `;
  const attendeeIds = rows.filter((r) => r.status === 'CONFIRMED').map((r) => Number(r.id));
  const cancelledId = Number(rows.find((r) => r.status === 'CANCELLED')!.id);

  return { concertId, showId, otherShowId, attendeeIds, cancelledId };
}

/** A scan straight into the table — the write path is module `G`'s and tested there. */
async function scan(opts: {
  attendeeId: number;
  showId: number;
  operatorId?: string | null;
  scannedAt: string;
  source?: 'ONLINE' | 'OFFLINE_SYNC' | 'MANUAL';
  deviceId?: string;
}): Promise<number> {
  const rows = await sql`
    insert into check_ins (attendee_id, show_id, operator_id, device_id, scanned_at, synced_at, source)
    values (
      ${opts.attendeeId}, ${opts.showId},
      ${'operatorId' in opts ? (opts.operatorId ?? null) : WEI_ID},
      ${opts.deviceId ?? 'phone-1'}, ${opts.scannedAt}, now(), ${opts.source ?? 'ONLINE'}
    )
    returning id
  `;
  return Number(rows[0]!.id);
}

let fx: Fixture;
beforeEach(async () => {
  fx = await arrange();
});

describe('getCheckinStats', () => {
  it('counts confirmed, checked in and remaining', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    await scan({ attendeeId: fx.attendeeIds[1]!, showId: fx.showId, scannedAt: '2026-09-19T11:01:00Z' });

    const stats = await getCheckinStats(fx.showId);
    expect(stats).toMatchObject({ confirmed: 4, checkedIn: 2, remaining: 2 });
  });

  it('counts an attendee once however many times they were scanned', async () => {
    // §12.3 accepts duplicates from two offline devices rather than attempting
    // distributed locking, so counting rows would overstate arrivals by exactly
    // the cases the offline design expects.
    const attendee = fx.attendeeIds[0]!;
    await scan({ attendeeId: attendee, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z', deviceId: 'phone-1' });
    await scan({ attendeeId: attendee, showId: fx.showId, scannedAt: '2026-09-19T11:00:30Z', deviceId: 'phone-2' });

    const stats = await getCheckinStats(fx.showId);
    expect(stats.checkedIn).toBe(1);
    expect(stats.remaining).toBe(3);
  });

  it('excludes reverted scans from every count', async () => {
    const id = await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.showId,
      scannedAt: '2026-09-19T11:00:00Z',
    });
    expect((await getCheckinStats(fx.showId)).checkedIn).toBe(1);

    await revertCheckIn({ checkInId: id, showId: fx.showId, actorId: ADMIN_ID });

    const stats = await getCheckinStats(fx.showId);
    expect(stats.checkedIn).toBe(0);
    expect(stats.remaining).toBe(4);
  });

  it('reports an admitted-anyway cancelled ticket separately, not as checked in', async () => {
    // Amber and red are never hard blocks (§12.1): the usher can admit anyway.
    // Folding that into `checkedIn` would make `confirmed - checkedIn` stop
    // meaning "expected guests still outside".
    await scan({ attendeeId: fx.cancelledId, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z', source: 'MANUAL' });

    const stats = await getCheckinStats(fx.showId);
    expect(stats).toMatchObject({
      confirmed: 4,
      checkedIn: 0,
      remaining: 4,
      admittedUnconfirmed: 1,
    });
  });

  it('does not count another show’s scans', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.otherShowId, scannedAt: '2026-09-19T11:00:00Z' });
    expect((await getCheckinStats(fx.showId)).checkedIn).toBe(0);
  });

  it('never reports negative remaining', async () => {
    for (const id of fx.attendeeIds) {
      await scan({ attendeeId: id, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    }
    await scan({ attendeeId: fx.cancelledId, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });

    const stats = await getCheckinStats(fx.showId);
    expect(stats.remaining).toBe(0);
  });
});

describe('getArrivalBuckets', () => {
  it('buckets arrivals by scanned_at', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    await scan({ attendeeId: fx.attendeeIds[1]!, showId: fx.showId, scannedAt: '2026-09-19T11:03:00Z' });
    await scan({ attendeeId: fx.attendeeIds[2]!, showId: fx.showId, scannedAt: '2026-09-19T11:07:00Z' });

    const buckets = await getArrivalBuckets(fx.showId, 5);
    expect(buckets).toEqual([
      { bucketStart: '2026-09-19T11:00:00Z', count: 2, walkIns: 0 },
      { bucketStart: '2026-09-19T11:05:00Z', count: 1, walkIns: 0 },
    ]);
  });

  it('counts each attendee once, at their first scan', async () => {
    const attendee = fx.attendeeIds[0]!;
    await scan({ attendeeId: attendee, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    await scan({ attendeeId: attendee, showId: fx.showId, scannedAt: '2026-09-19T11:30:00Z' });

    const buckets = await getArrivalBuckets(fx.showId, 5);
    expect(buckets).toEqual([{ bucketStart: '2026-09-19T11:00:00Z', count: 1, walkIns: 0 }]);
  });

  it('buckets on scanned_at, not synced_at, so an offline drain is not a spike', async () => {
    // The whole point of the offline queue is that these differ (§12.3).
    // Charting sync time would draw the network, not the queue.
    await sql`
      insert into check_ins (attendee_id, show_id, operator_id, device_id, scanned_at, synced_at, source)
      values (${fx.attendeeIds[0]!}, ${fx.showId}, ${WEI_ID}, 'phone-1',
              '2026-09-19T11:00:00Z', '2026-09-19T12:30:00Z', 'OFFLINE_SYNC')
    `;

    const buckets = await getArrivalBuckets(fx.showId, 5);
    expect(buckets).toEqual([{ bucketStart: '2026-09-19T11:00:00Z', count: 1, walkIns: 0 }]);
  });

  it('leaves out reverted scans', async () => {
    const id = await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.showId,
      scannedAt: '2026-09-19T11:00:00Z',
    });
    await revertCheckIn({ checkInId: id, showId: fx.showId, actorId: ADMIN_ID });

    expect(await getArrivalBuckets(fx.showId, 5)).toEqual([]);
  });

  it('has a sane default bucket width', () => {
    expect(ARRIVAL_BUCKET_MINUTES).toBeGreaterThan(0);
  });
});

describe('getOperatorCounts', () => {
  it('counts per operator, busiest first', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.showId, operatorId: WEI_ID, scannedAt: '2026-09-19T11:00:00Z' });
    await scan({ attendeeId: fx.attendeeIds[1]!, showId: fx.showId, operatorId: WEI_ID, scannedAt: '2026-09-19T11:01:00Z' });
    await scan({ attendeeId: fx.attendeeIds[2]!, showId: fx.showId, operatorId: MEI_ID, scannedAt: '2026-09-19T11:02:00Z' });

    const counts = await getOperatorCounts(fx.showId);
    expect(counts).toEqual([
      { operatorId: WEI_ID, operatorName: 'Wei', count: 2, walkIns: 0 },
      { operatorId: MEI_ID, operatorName: 'Mei', count: 1, walkIns: 0 },
    ]);
  });

  it('keeps a scan whose operator row is gone', async () => {
    await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.showId,
      operatorId: null,
      scannedAt: '2026-09-19T11:00:00Z',
    });

    const counts = await getOperatorCounts(fx.showId);
    expect(counts).toEqual([{ operatorId: null, operatorName: null, count: 1, walkIns: 0 }]);
  });
});

describe('walk-ins (spec/v3.md §32.2)', () => {
  async function walkIn(over: { headcount: number; operatorId?: string | null; at?: string; reverted?: boolean }) {
    await sql`
      insert into walk_ins (client_id, show_id, headcount, operator_id, admitted_at, reverted_at)
      values (gen_random_uuid(), ${fx.showId}, ${over.headcount}, ${over.operatorId ?? WEI_ID},
              ${over.at ?? '2026-09-19T11:02:00Z'}, ${over.reverted ? sql`now()` : null})
    `;
  }

  it('count in the hall by headcount, and a reverted one does not', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    await walkIn({ headcount: 3 });
    await walkIn({ headcount: 5, reverted: true });

    const stats = await getCheckinStats(fx.showId);
    expect(stats.walkIns).toBe(3);
    expect(stats.inHall).toBe(stats.checkedIn + stats.admittedUnconfirmed + 3);
    // Walk-ins are not expected guests: "remaining" is about the roster only.
    expect(stats.remaining).toBe(stats.confirmed - stats.checkedIn);
    expect(stats.capacity).not.toBeNull();
  });

  it('stack beside ticketed arrivals in the chart', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    await walkIn({ headcount: 2, at: '2026-09-19T11:01:00Z' });
    expect(await getArrivalBuckets(fx.showId, 5)).toEqual([
      { bucketStart: '2026-09-19T11:00:00Z', count: 1, walkIns: 2 },
    ]);
  });

  it('count for the operator who recorded them', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.showId, operatorId: MEI_ID, scannedAt: '2026-09-19T11:00:00Z' });
    await walkIn({ headcount: 4, operatorId: WEI_ID });
    expect(await getOperatorCounts(fx.showId)).toEqual([
      { operatorId: WEI_ID, operatorName: 'Wei', count: 0, walkIns: 4 },
      { operatorId: MEI_ID, operatorName: 'Mei', count: 1, walkIns: 0 },
    ]);
  });

  it('give the door the house and this operator`s share of it', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.showId, operatorId: WEI_ID, scannedAt: '2026-09-19T11:00:00Z' });
    await scan({ attendeeId: fx.attendeeIds[1]!, showId: fx.showId, operatorId: MEI_ID, scannedAt: '2026-09-19T11:00:00Z' });
    await walkIn({ headcount: 2, operatorId: WEI_ID });

    const stats = await getDoorStats(fx.showId, WEI_ID);
    expect(stats.inHall).toBe(4);
    expect(stats.byYou).toEqual({ admitted: 1, walkIns: 2 });
    expect(Number.isNaN(Date.parse(stats.asOf))).toBe(false);
  });
});

describe('getScanLog', () => {
  const base = { pageIndex: 0, pageSize: 25, sort: null, desc: true, includeReverted: false };

  it('returns the show’s scans, newest first, with the operator named', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    await scan({ attendeeId: fx.attendeeIds[1]!, showId: fx.showId, operatorId: MEI_ID, scannedAt: '2026-09-19T11:05:00Z' });

    const { rows, total } = await getScanLog({ ...base, showId: fx.showId, search: '' });
    expect(total).toBe(2);
    expect(rows[0]!.operatorName).toBe('Mei');
    expect(rows[1]!.operatorName).toBe('Wei');
  });

  it('searches by attendee name across the whole log, not just the page', async () => {
    await sql`update attendees set full_name = 'Alice Tan' where id = ${fx.attendeeIds[0]!}`;
    for (const id of fx.attendeeIds) {
      await scan({ attendeeId: id, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    }

    // Page size 1 with a match that is not on the first page: a table filtering
    // in the browser would find nothing here.
    const { rows, total } = await getScanLog({
      ...base,
      showId: fx.showId,
      pageSize: 1,
      search: 'alice',
    });
    expect(total).toBe(1);
    expect(rows[0]!.attendeeName).toBe('Alice Tan');
  });

  it('pages without dropping or repeating a row when scans share a second', async () => {
    for (const id of fx.attendeeIds) {
      await scan({ attendeeId: id, showId: fx.showId, scannedAt: '2026-09-19T11:00:00Z' });
    }

    const first = await getScanLog({ ...base, showId: fx.showId, pageSize: 2, search: '' });
    const second = await getScanLog({
      ...base,
      showId: fx.showId,
      pageIndex: 1,
      pageSize: 2,
      search: '',
    });

    expect(first.total).toBe(4);
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('hides reverted rows by default and shows them on request', async () => {
    const id = await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.showId,
      scannedAt: '2026-09-19T11:00:00Z',
    });
    await revertCheckIn({ checkInId: id, showId: fx.showId, actorId: ADMIN_ID, reason: 'Wrong ticket' });

    expect((await getScanLog({ ...base, showId: fx.showId, search: '' })).total).toBe(0);

    const withReverted = await getScanLog({
      ...base,
      showId: fx.showId,
      search: '',
      includeReverted: true,
    });
    expect(withReverted.total).toBe(1);
    expect(withReverted.rows[0]!.revertedAt).not.toBeNull();
    expect(withReverted.rows[0]!.revertedByName).toBe('Committee');
  });

  it('does not leak another show’s scans', async () => {
    await scan({ attendeeId: fx.attendeeIds[0]!, showId: fx.otherShowId, scannedAt: '2026-09-19T11:00:00Z' });
    expect((await getScanLog({ ...base, showId: fx.showId, search: '' })).total).toBe(0);
  });
});

describe('revertCheckIn', () => {
  it('stamps reverted_at and reverted_by, and never deletes the row', async () => {
    const id = await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.showId,
      scannedAt: '2026-09-19T11:00:00Z',
    });

    await revertCheckIn({ checkInId: id, showId: fx.showId, actorId: ADMIN_ID });

    const rows = await sql`select reverted_at, reverted_by from check_ins where id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reverted_at).not.toBeNull();
    expect(rows[0]!.reverted_by).toBe(ADMIN_ID);
  });

  it('lets the attendee be admitted again afterwards', async () => {
    // This is the whole point: the scanner excludes reverted rows, so the next
    // genuine scan reads as a fresh admission rather than a duplicate.
    const id = await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.showId,
      scannedAt: '2026-09-19T11:00:00Z',
    });
    await revertCheckIn({ checkInId: id, showId: fx.showId, actorId: ADMIN_ID });

    const live = await sql`
      select count(*)::int as n from check_ins
       where attendee_id = ${fx.attendeeIds[0]!} and reverted_at is null
    `;
    expect(live[0]!.n).toBe(0);
  });

  it('refuses a second revert rather than reattributing the first', async () => {
    const id = await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.showId,
      scannedAt: '2026-09-19T11:00:00Z',
    });
    await revertCheckIn({ checkInId: id, showId: fx.showId, actorId: ADMIN_ID });

    await expect(
      revertCheckIn({ checkInId: id, showId: fx.showId, actorId: WEI_ID }),
    ).rejects.toBeInstanceOf(RevertError);

    const rows = await sql`select reverted_by from check_ins where id = ${id}`;
    expect(rows[0]!.reverted_by).toBe(ADMIN_ID);
  });

  it('refuses a scan belonging to another show', async () => {
    const id = await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.otherShowId,
      scannedAt: '2026-09-19T11:00:00Z',
    });

    await expect(
      revertCheckIn({ checkInId: id, showId: fx.showId, actorId: ADMIN_ID }),
    ).rejects.toBeInstanceOf(RevertError);

    const rows = await sql`select reverted_at from check_ins where id = ${id}`;
    expect(rows[0]!.reverted_at).toBeNull();
  });

  it('writes an audit row carrying the reason', async () => {
    const id = await scan({
      attendeeId: fx.attendeeIds[0]!,
      showId: fx.showId,
      scannedAt: '2026-09-19T11:00:00Z',
    });
    await revertCheckIn({
      checkInId: id,
      showId: fx.showId,
      actorId: ADMIN_ID,
      reason: 'Scanned the wrong person',
    });

    const rows = await sql`select * from audit_log where action = 'checkin.reverted'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('Scanned the wrong person');
    expect(rows[0]!.actor_id).toBe(ADMIN_ID);
  });
});
