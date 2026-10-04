import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashQrToken } from '@/lib/checkin/manifest';
import { closeDb, resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * `/api/checkin/scan` — admissions reaching the server (spec/checkin.md §12.3).
 *
 * Against a **real Postgres**, because everything worth asserting here is SQL:
 * the idempotent guarded insert a retried drain depends on, the append-only log
 * that never overwrites, and the wrong-show lookup. A mock would confirm the
 * shape of the call and nothing about the behaviour.
 */
const getSessionUser = vi.fn();
const canAccessShow = vi.fn();

vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => getSessionUser() }));
vi.mock('@/lib/auth/show-access', () => ({
  canAccessShow: (...args: unknown[]) => canAccessShow(...args),
}));

const { POST } = await import('@/app/api/checkin/scan/route');

const operator = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'wei@operators.invalid',
  displayName: 'Wei',
  role: 'OPERATOR' as const,
};

afterAll(closeDb);

type Fixture = {
  showId: number;
  otherShowId: number;
  tokens: string[];
  hashes: string[];
  cancelledHash: string;
};

async function arrange(): Promise<Fixture> {
  await resetDb();

  await sql`
    insert into app_users (id, email, display_name, role, is_active)
    values (${operator.id}, ${operator.email}, ${operator.displayName}, 'OPERATOR', true)
  `;

  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const otherShowId = await createShow(concertId, 400);
  await sql`update shows set name = 'Saturday evening' where id = ${otherShowId}`;

  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  const otherSegmentId = await createSegment(otherShowId, {
    audienceMode: 'PUBLIC',
    capacity: 300,
  });

  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({ registrationId, showId, segmentId, count: 3, allocationType: 'BASE' });

  const cancelledReg = await createRegistration({ showId, segmentId, status: 'CANCELLED' });
  await seedAttendees({
    registrationId: cancelledReg,
    showId,
    segmentId,
    count: 1,
    allocationType: 'BASE',
    status: 'CANCELLED',
  });

  const otherReg = await createRegistration({ showId: otherShowId, segmentId: otherSegmentId });
  await seedAttendees({
    registrationId: otherReg,
    showId: otherShowId,
    segmentId: otherSegmentId,
    count: 1,
    allocationType: 'BASE',
  });

  // Mint tokens the way module D does — the column is what the endpoint hashes.
  const rows = await sql<{ id: number; show_id: number; status: string }[]>`
    select id, show_id, status from attendees order by id
  `;
  const tokens: string[] = [];
  for (const [i, row] of rows.entries()) {
    const token = `Tok${String(i).padStart(2, '0')}aaaaaaaaaaaaaaaaaaa`.slice(0, 22);
    tokens.push(token);
    await sql`update attendees set qr_token = ${token} where id = ${row.id}`;
  }

  const hashes = await Promise.all(tokens.map(hashQrToken));
  return {
    showId,
    otherShowId,
    tokens,
    hashes,
    // The fourth attendee is the cancelled registration's.
    cancelledHash: hashes[3],
  };
}

const post = (payload: unknown) =>
  POST(
    new Request('http://localhost/api/checkin/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

function scan(hash: string, over: Record<string, unknown> = {}) {
  return {
    qrTokenSha256: hash,
    scannedAt: '2026-09-19T11:04:00.000Z',
    source: 'ONLINE',
    deviceId: 'usher-phone-1',
    ...over,
  };
}

let f: Fixture;

beforeEach(async () => {
  getSessionUser.mockReset();
  canAccessShow.mockReset();
  getSessionUser.mockResolvedValue(operator);
  canAccessShow.mockResolvedValue(true);
  f = await arrange();
});

describe('who may write a scan', () => {
  it('refuses an anonymous caller with 401', async () => {
    getSessionUser.mockResolvedValue(null);
    expect((await post({ showId: f.showId, scans: [scan(f.hashes[0])] })).status).toBe(401);
  });

  it('re-verifies assignment on every write, including a delayed offline drain', async () => {
    // §12.3: an assignment revoked mid-event takes effect on the next sync,
    // rather than being trusted from a client that has been offline since
    // before it changed. The queue carries no authority of its own.
    canAccessShow.mockResolvedValue(false);
    const response = await post({
      showId: f.showId,
      scans: [scan(f.hashes[0], { source: 'OFFLINE_SYNC' })],
    });
    expect(response.status).toBe(404);

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from check_ins`;
    expect(count).toBe(0);
  });

  it('is 404 rather than 403, like the manifest', async () => {
    canAccessShow.mockResolvedValue(false);
    expect((await post({ showId: f.showId, scans: [scan(f.hashes[0])] })).status).toBe(404);
  });

  it('rejects a malformed batch before touching the database', async () => {
    expect((await post({ showId: f.showId, scans: [] })).status).toBe(400);
    expect((await post({ scans: [scan(f.hashes[0])] })).status).toBe(400);
  });
});

describe('one bad row never blocks the queue (spec/v3.md §32.2)', () => {
  it('refuses the bad row by itself and records every good one beside it', async () => {
    // Before §32.2 a single row the schema refused made the whole batch a 400,
    // and the phone re-sent the same poisoned batch for the rest of the night.
    const response = await post({
      showId: f.showId,
      scans: [
        scan(f.hashes[0]),
        scan('nothex'),
        { ...scan(f.hashes[1]), qrTokenSha256: null }, // names no seat at all
        scan(f.hashes[2], { scannedAt: '2026-09-19T11:05:00.000Z' }),
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.receipts.map((r: { index: number; outcome: string }) => [r.index, r.outcome])).toEqual([
      [0, 'RECORDED'],
      [1, 'REFUSED'],
      [2, 'REFUSED'],
      [3, 'RECORDED'],
    ]);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from check_ins`;
    expect(count).toBe(2);
  });

  it('admits a seat with no ticket by its attendee id, with the reason', async () => {
    // Confirmed and not yet ticketed: a late approval, or a late import.
    const [{ segment_id: segmentId }] = await sql<{ segment_id: number }[]>`
      select segment_id from attendees where show_id = ${f.showId} limit 1
    `;
    const registrationId = await createRegistration({ showId: f.showId, segmentId });
    await seedAttendees({ registrationId, showId: f.showId, segmentId, count: 1, allocationType: 'BASE' });
    const [seat] = await sql<{ id: number }[]>`
      select id from attendees where registration_id = ${registrationId}
    `;

    const body = await (
      await post({
        showId: f.showId,
        scans: [
          {
            attendeeId: Number(seat.id),
            qrTokenSha256: null,
            scannedAt: '2026-09-19T11:04:00.000Z',
            source: 'MANUAL',
            deviceId: 'usher-phone-1',
            overrideReason: 'No ticket issued',
          },
        ],
      })
    ).json();
    expect(body.receipts[0]).toMatchObject({ index: 0, outcome: 'RECORDED' });
    expect(Number(body.receipts[0].attendeeId)).toBe(Number(seat.id));
    const [row] = await sql<{ override_reason: string }[]>`select override_reason from check_ins`;
    expect(row.override_reason).toBe('No ticket issued');
  });

  it('will not record an attendee id from another show', async () => {
    // The id is re-verified against the show the operator is assigned to, just
    // as a token is: knowing an id is not a way into another show's log.
    const [other] = await sql<{ id: number }[]>`
      select id from attendees where show_id = ${f.otherShowId} limit 1
    `;
    const body = await (
      await post({
        showId: f.showId,
        scans: [{ ...scan(f.hashes[4]), attendeeId: Number(other.id), qrTokenSha256: null }],
      })
    ).json();
    expect(body.receipts[0].outcome).toBe('NOT_FOUND');
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from check_ins`;
    expect(count).toBe(0);
  });
});

describe('recording an admission', () => {
  it('writes one row and reports it recorded', async () => {
    const body = await (await post({ showId: f.showId, scans: [scan(f.hashes[0])] })).json();
    expect(body.receipts[0].outcome).toBe('RECORDED');

    const rows = await sql<{ source: string; scanned_at: Date; device_id: string }[]>`
      select source, scanned_at, device_id from check_ins
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].device_id).toBe('usher-phone-1');
  });

  it('preserves the phone`s scanned_at through an offline sync, and stamps synced_at', async () => {
    // The gap between the two is however long the usher was offline, which is
    // the entire point of the queue (src/db/schema/checkin.ts).
    await post({
      showId: f.showId,
      scans: [
        scan(f.hashes[0], { source: 'OFFLINE_SYNC', scannedAt: '2026-09-19T11:00:00.000Z' }),
      ],
    });
    const [row] = await sql<{ scanned_at: string; synced_at: string; source: string }[]>`
      select scanned_at, synced_at, source from check_ins
    `;
    expect(row.source).toBe('OFFLINE_SYNC');
    // The phone's reading survives verbatim — that is the column's whole job.
    expect(new Date(row.scanned_at).toISOString()).toBe('2026-09-19T11:00:00.000Z');
    // And synced_at is the server's clock at drain time, independent of it.
    // Deliberately not asserted as "later than scanned_at": these fixtures scan
    // on the concert date, which is still in the future, and an ordering
    // assertion would encode today's date into the suite.
    expect(new Date(row.synced_at).getTime()).toBeCloseTo(Date.now(), -4);
    expect(row.synced_at).not.toBe(row.scanned_at);
  });

  it('records an override reason when the usher admitted anyway', async () => {
    await post({
      showId: f.showId,
      scans: [
        scan(f.cancelledHash, { source: 'MANUAL', overrideReason: 'Committee approved at desk' }),
      ],
    });
    const [row] = await sql<{ override_reason: string }[]>`
      select override_reason from check_ins
    `;
    expect(row.override_reason).toBe('Committee approved at desk');
  });

  it('admits a cancelled ticket when the operator insists — red is never a hard block', async () => {
    const body = await (
      await post({
        showId: f.showId,
        scans: [scan(f.cancelledHash, { source: 'MANUAL', overrideReason: 'Refer to desk: ok' })],
      })
    ).json();
    expect(body.receipts[0].outcome).toBe('RECORDED');
  });
});

describe('a drain that is retried, which is the normal case', () => {
  it('is idempotent — the same batch twice writes one row', async () => {
    // A flaky venue network is the premise of the whole offline queue, so the
    // same batch arriving twice is expected rather than exceptional.
    const batch = { showId: f.showId, scans: [scan(f.hashes[0], { source: 'OFFLINE_SYNC' })] };
    const first = await (await post(batch)).json();
    const second = await (await post(batch)).json();

    expect(first.receipts[0].outcome).toBe('RECORDED');
    expect(second.receipts[0].outcome).toBe('ALREADY_SYNCED');

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from check_ins`;
    expect(count).toBe(1);
  });

  it('still records two genuinely separate scans of one ticket', async () => {
    // §12.3: the server accepts both and flags the attendee as multi-scanned.
    // Idempotency must not swallow a real second scan.
    await post({ showId: f.showId, scans: [scan(f.hashes[0])] });
    const body = await (
      await post({
        showId: f.showId,
        scans: [scan(f.hashes[0], { scannedAt: '2026-09-19T11:09:00.000Z' })],
      })
    ).json();

    expect(body.receipts[0].outcome).toBe('RECORDED');
    expect(body.receipts[0].scanCount).toBe(2);
    expect(body.receipts[0].firstScan.at).toBe('2026-09-19T11:04:00.000Z');
  });

  it('drains a whole batch in one request', async () => {
    const body = await (
      await post({
        showId: f.showId,
        scans: f.hashes.slice(0, 3).map((h, i) =>
          scan(h, {
            source: 'OFFLINE_SYNC',
            scannedAt: `2026-09-19T11:0${i}:00.000Z`,
          }),
        ),
      })
    ).json();

    expect(body.receipts.map((r: { outcome: string }) => r.outcome)).toEqual([
      'RECORDED',
      'RECORDED',
      'RECORDED',
    ]);
  });
});

describe('a ticket this show does not know', () => {
  it('names the show it actually belongs to, which the phone could not know', async () => {
    // The device holds one roster, so offline this reads "not found". The
    // server sees every show and can say better (§12.1's result table).
    const body = await (
      await post({ showId: f.showId, scans: [scan(f.hashes[4])] })
    ).json();
    expect(body.receipts[0].outcome).toBe('WRONG_SHOW');
    expect(body.receipts[0].showName).toBe('Saturday evening');
  });

  it('writes nothing for a wrong-show ticket', async () => {
    await post({ showId: f.showId, scans: [scan(f.hashes[4])] });
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from check_ins`;
    expect(count).toBe(0);
  });

  it('reports a token nobody has as not found, and writes nothing', async () => {
    const body = await (await post({ showId: f.showId, scans: [scan('e'.repeat(64))] })).json();
    expect(body.receipts[0].outcome).toBe('NOT_FOUND');
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from check_ins`;
    expect(count).toBe(0);
  });
});

describe('reverted scans', () => {
  it('do not make the next genuine scan read as a duplicate', async () => {
    // A revert is module H undoing a mistake, and it never deletes (decision 7).
    // Counting a reverted row would turn the corrected guest amber forever.
    await post({ showId: f.showId, scans: [scan(f.hashes[0])] });
    await sql`update check_ins set reverted_at = now()`;

    const body = await (
      await post({
        showId: f.showId,
        scans: [scan(f.hashes[0], { scannedAt: '2026-09-19T11:20:00.000Z' })],
      })
    ).json();

    expect(body.receipts[0].scanCount).toBe(1);
    expect(body.receipts[0].firstScan).toBeNull();
  });
});
