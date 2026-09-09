import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRejectedSyncs } from '@/lib/checkin/rejected-sync';
import { closeDb, resetDb, sql } from '../helpers/db';
import { createConcert, createShow } from '../helpers/fixtures';

/**
 * A revoked operator's queued scans are refused **and surfaced**
 * (spec/admin.md §14.3).
 *
 * §14.3 asks for both halves: "its queued scans are rejected on sync and
 * surfaced to the admin rather than silently dropped." The rejection was
 * already true and is covered by `tests/checkin/scan-route.test.ts`; this file
 * is about the second half, which a QA pass found missing — the refused
 * admissions existed only in the operator's IndexedDB, on a device the admin is
 * not holding.
 *
 * It matters because of where those people are standing. They were physically
 * let into the hall by an usher whose phone still believed it was rostered, so
 * they are inside the building and absent from every count on the dashboard.
 */
const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';
const WEI_ID = '00000000-0000-4000-8000-000000000101';

const getSessionUser = vi.fn();
const canAccessShow = vi.fn();

vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => getSessionUser() }));
vi.mock('@/lib/auth/show-access', () => ({
  canAccessShow: (...args: unknown[]) => canAccessShow(...args),
}));

const { POST } = await import('@/app/api/checkin/scan/route');

afterAll(closeDb);

const operator = {
  id: WEI_ID,
  email: 'wei@operators.invalid',
  displayName: 'Wei',
  role: 'OPERATOR' as const,
};

let showId: number;

function drain(targetShowId: number, count: number) {
  return new Request('http://localhost/api/checkin/scan', {
    method: 'POST',
    body: JSON.stringify({
      showId: targetShowId,
      scans: Array.from({ length: count }, (_, i) => ({
        qrTokenSha256: 'a'.repeat(64),
        scannedAt: `2026-09-19T11:0${i}:00.000Z`,
        source: 'OFFLINE_SYNC',
        deviceId: 'wei-phone',
      })),
    }),
  });
}

beforeEach(async () => {
  await resetDb();
  getSessionUser.mockReset();
  canAccessShow.mockReset();

  await sql`
    insert into app_users (id, email, display_name, role, is_active) values
      (${ADMIN_ID}, 'admin@example.test', 'Committee', 'ADMIN', true),
      (${WEI_ID}, ${operator.email}, 'Wei', 'OPERATOR', true)
  `;
  const concertId = await createConcert('Revocation Concert');
  showId = await createShow(concertId, 300);
});

describe('a refused drain reaches the admin', () => {
  it('records the operator, the device and how many scans were lost', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);

    const response = await POST(drain(showId, 3));
    expect(response.status).toBe(404);

    const rejected = await getRejectedSyncs(showId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      operatorId: WEI_ID,
      operatorName: 'Wei',
      deviceId: 'wei-phone',
      scanCount: 3,
      earliestScanAt: '2026-09-19T11:00:00.000Z',
      latestScanAt: '2026-09-19T11:02:00.000Z',
    });
  });

  it('still records nothing in check_ins — the refusal is real', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);

    await POST(drain(showId, 3));

    const rows = await sql`select count(*)::int as n from check_ins`;
    expect(rows[0]!.n).toBe(0);
  });

  it('tells the caller nothing it did not already know', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);

    const response = await POST(drain(showId, 1));
    // Unchanged from before this existed: probing ids must not distinguish
    // "not yours" from "not there" (modules.md §5.2.1).
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('ignores a probe against a show that does not exist', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);

    // Otherwise someone walking ids fills the log with one row per guess, and
    // buries the entry the desk actually needs to read on the night.
    const response = await POST(drain(999_999, 2));
    expect(response.status).toBe(404);

    const rows = await sql`select count(*)::int as n from audit_log`;
    expect(rows[0]!.n).toBe(0);
  });

  it('writes nothing when the operator is properly assigned', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(true);

    await POST(drain(showId, 1));

    expect(await getRejectedSyncs(showId)).toHaveLength(0);
  });

  it('keeps each refused batch, newest first', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);

    await POST(drain(showId, 1));
    await POST(drain(showId, 4));

    const rejected = await getRejectedSyncs(showId);
    expect(rejected).toHaveLength(2);
    expect(rejected.map((entry) => entry.scanCount).sort()).toEqual([1, 4]);
  });

  it('does not name any attendee', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);

    await POST(drain(showId, 1));

    // The caller was not entitled to this show's roster when the batch arrived,
    // so resolving the digests would write the roster into the log on their
    // behalf.
    const rows = await sql`select after from audit_log`;
    expect(JSON.stringify(rows[0]!.after)).not.toContain('a'.repeat(64));
  });

  it('is scoped to the show being watched', async () => {
    getSessionUser.mockResolvedValue(operator);
    canAccessShow.mockResolvedValue(false);
    const concertId = await createConcert('Other');
    const otherShowId = await createShow(concertId, 100);

    await POST(drain(otherShowId, 2));

    expect(await getRejectedSyncs(showId)).toHaveLength(0);
    expect(await getRejectedSyncs(otherShowId)).toHaveLength(1);
  });
});
