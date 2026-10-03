import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';

/**
 * Walk-ins (spec/v3.md §32.2, decision 58) and the door's stats endpoint,
 * against a real Postgres.
 */
const getSessionUser = vi.fn();
const canAccessShow = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => getSessionUser() }));
vi.mock('@/lib/auth/show-access', () => ({
  canAccessShow: (...args: unknown[]) => canAccessShow(...args),
}));

const { POST } = await import('@/app/api/checkin/walk-ins/route');
const { GET } = await import('@/app/api/checkin/stats/route');
const { revertWalkIn, WalkInRevertError } = await import('@/lib/checkin/walk-ins');

const operator = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'wei@operators.invalid',
  displayName: 'Wei',
  role: 'OPERATOR' as const,
};
const admin = { id: '00000000-0000-4000-8000-0000000000aa', email: 'a@x', displayName: 'Desk', role: 'ADMIN' as const };

let concertId: number;
let showId: number;
let otherShowId: number;
let segmentId: number;

beforeEach(async () => {
  await resetDb();
  for (const u of [operator, admin]) {
    await sql`insert into app_users (id, email, display_name, role, is_active)
              values (${u.id}, ${u.email}, ${u.displayName}, ${u.role}, true)`;
  }
  concertId = await createConcert();
  showId = await createShow(concertId, 50);
  otherShowId = await createShow(concertId, 50);
  segmentId = await createSegment(otherShowId, { audienceMode: 'PUBLIC', capacity: 10 });
  await setSystemSetting('checkin.walk_ins_enabled', true);
  await setSystemSetting('checkin.walk_in_max_headcount', 10);
  getSessionUser.mockReset().mockResolvedValue(operator);
  canAccessShow.mockReset().mockResolvedValue(true);
});

const walkIn = (over: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  headcount: 2,
  label: 'Family at the door',
  admittedAt: '2026-09-19T11:04:00.000Z',
  deviceId: 'phone-1',
  ...over,
});

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/checkin/walk-ins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

const count = async () =>
  (await sql<{ n: number }[]>`select count(*)::int as n from walk_ins`)[0].n;

describe('POST /api/checkin/walk-ins', () => {
  it('records a walk-in as one event row, attributed to the operator', async () => {
    const w = walkIn();
    const body = await (await post({ showId, walkIns: [w] })).json();
    expect(body.receipts[0]).toMatchObject({ index: 0, clientId: w.clientId, outcome: 'RECORDED' });
    const [row] = await sql<{ headcount: number; operator_id: string; label: string }[]>`
      select headcount, operator_id, label from walk_ins`;
    expect(row).toMatchObject({ headcount: 2, operator_id: operator.id, label: 'Family at the door' });
  });

  it('is harmless to re-send: the phone-minted id makes it idempotent', async () => {
    const w = walkIn();
    await post({ showId, walkIns: [w] });
    const again = await (await post({ showId, walkIns: [w] })).json();
    expect(again.receipts[0].outcome).toBe('ALREADY_SYNCED');
    expect(await count()).toBe(1);
  });

  it('refuses one bad row by itself and records the good ones', async () => {
    const body = await (
      await post({ showId, walkIns: [walkIn(), { headcount: 0 }, walkIn({ headcount: 1 })] })
    ).json();
    expect(body.receipts.map((r: { outcome: string }) => r.outcome)).toEqual(['RECORDED', 'REFUSED', 'RECORDED']);
    expect(await count()).toBe(2);
  });

  it('refuses everything while walk-ins are off, saying so', async () => {
    await setSystemSetting('checkin.walk_ins_enabled', false);
    const body = await (await post({ showId, walkIns: [walkIn()] })).json();
    expect(body.receipts[0]).toMatchObject({ outcome: 'REFUSED' });
    expect(body.receipts[0].reason).toContain('turned off');
    expect(await count()).toBe(0);
  });

  it('refuses a headcount above the setting, as the typo it likely is', async () => {
    const body = await (await post({ showId, walkIns: [walkIn({ headcount: 30 })] })).json();
    expect(body.receipts[0].outcome).toBe('REFUSED');
    expect(body.receipts[0].reason).toContain('10');
  });

  it('refuses every walk-in while no largest group is set, rather than allowing any size', async () => {
    // QA found an unset cap meant no cap: 2147483647 people were recorded and
    // the stats endpoint then answered 500.
    await sql`delete from system_settings where key = 'checkin.walk_in_max_headcount'`;
    const body = await (await post({ showId, walkIns: [walkIn({ headcount: 2 })] })).json();
    expect(body.receipts[0].outcome).toBe('REFUSED');
    expect(body.receipts[0].reason).toContain('largest');
    expect(await count()).toBe(0);
  });

  it('refuses a headcount past the column`s own range as unreadable', async () => {
    const body = await (await post({ showId, walkIns: [walkIn({ headcount: 2 ** 31 })] })).json();
    expect(body.receipts[0].outcome).toBe('REFUSED');
  });

  it('keeps the stats endpoint answering however large the walk-in total', async () => {
    await sql`
      insert into walk_ins (client_id, show_id, headcount, operator_id, admitted_at)
      values (gen_random_uuid(), ${showId}, 2000000000, ${operator.id}, now()),
             (gen_random_uuid(), ${showId}, 2000000000, ${operator.id}, now())`;
    const response = await GET(new Request(`http://localhost/api/checkin/stats?showId=${showId}`));
    expect(response.status).toBe(200);
    expect((await response.json()).walkIns).toBe(4_000_000_000);
  });

  it('refuses a segment that belongs to another show', async () => {
    const body = await (await post({ showId, walkIns: [walkIn({ segmentId })] })).json();
    expect(body.receipts[0].outcome).toBe('REFUSED');
    expect(await count()).toBe(0);
  });

  it('re-verifies assignment on every write, 404, and tells the desk', async () => {
    canAccessShow.mockResolvedValue(false);
    const response = await post({ showId, walkIns: [walkIn()] });
    expect(response.status).toBe(404);
    expect(await count()).toBe(0);
    const [alert] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where action = 'checkin.sync_rejected'`;
    expect(alert.n).toBe(1);
  });

  it('refuses no session with 401 and a viewer with 404', async () => {
    getSessionUser.mockResolvedValue(null);
    expect((await post({ showId, walkIns: [walkIn()] })).status).toBe(401);
    getSessionUser.mockResolvedValue({ ...admin, role: 'VIEWER' });
    expect((await post({ showId, walkIns: [walkIn()] })).status).toBe(404);
  });
});

describe('reverting a walk-in', () => {
  it('stamps it reverted, audits it, and takes it out of the hall', async () => {
    await post({ showId, walkIns: [walkIn({ headcount: 3 })] });
    const [{ id }] = await sql<{ id: string }[]>`select id from walk_ins`;
    await revertWalkIn({ walkInId: Number(id), showId, concertId, actorId: admin.id });

    const [row] = await sql<{ reverted_by: string }[]>`select reverted_by from walk_ins`;
    expect(row.reverted_by).toBe(admin.id);
    const [audit] = await sql<{ concert_id: string }[]>`
      select concert_id from audit_log where action = 'checkin.walk_in_reverted'`;
    expect(Number(audit.concert_id)).toBe(concertId);

    const stats = await (await GET(new Request(`http://localhost/api/checkin/stats?showId=${showId}`))).json();
    expect(stats.walkIns).toBe(0);
  });

  it('will not revert a walk-in through another show', async () => {
    await post({ showId, walkIns: [walkIn()] });
    const [{ id }] = await sql<{ id: string }[]>`select id from walk_ins`;
    await expect(
      revertWalkIn({ walkInId: Number(id), showId: otherShowId, concertId, actorId: admin.id }),
    ).rejects.toBeInstanceOf(WalkInRevertError);
  });
});

describe('GET /api/checkin/stats', () => {
  const get = (q: string) => GET(new Request(`http://localhost/api/checkin/stats${q}`));

  it('gives the house and this operator`s share, counts only', async () => {
    await post({ showId, walkIns: [walkIn({ headcount: 3 })] });
    const response = await get(`?showId=${showId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ walkIns: 3, inHall: 3, capacity: 50, byYou: { admitted: 0, walkIns: 3 } });
    expect(JSON.stringify(body)).not.toMatch(/Family|Wei/);
  });

  it('is held to the manifest`s rule: 404 for a show the operator is not rostered on', async () => {
    canAccessShow.mockResolvedValue(false);
    expect((await get(`?showId=${showId}`)).status).toBe(404);
  });

  it('refuses no session with 401, a viewer with 404, and a bad id with 400', async () => {
    getSessionUser.mockResolvedValue(null);
    expect((await get(`?showId=${showId}`)).status).toBe(401);
    getSessionUser.mockResolvedValue({ ...admin, role: 'VIEWER' });
    expect((await get(`?showId=${showId}`)).status).toBe(404);
    getSessionUser.mockResolvedValue(operator);
    expect((await get('?showId=abc')).status).toBe(400);
  });
});
