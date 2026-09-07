import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';
import { TEMPLATE_HEADERS, defaultProfileFor } from '@/lib/import/template';

const LOG = '/tmp/claude-0/-home-user-zetix/7084ffa5-0318-5829-9d7a-f878dfd2e43c/scratchpad/qa-route.log';
const log = (...args: unknown[]) =>
  appendFileSync(LOG, args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const { POST } = await import('@/app/api/import/route');

async function createUser(role: 'ADMIN' | 'OPERATOR') {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}, ${`${role.toLowerCase()}-${id}@example.test`}, ${role}, ${role}::user_role)
  `;
  return { id, role };
}

const HEADERS = Object.values(TEMPLATE_HEADERS);

async function sheetBytes(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Registrations');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function fileOf(rows: string[][], name = 'sheet.xlsx'): Promise<File> {
  const bytes = await sheetBytes(rows);
  return new File([new Uint8Array(bytes)], name);
}

function request(fields: Record<string, string | File>): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request('http://localhost/api/import', { method: 'POST', body });
}

async function publicSegment(capacity: number, name = 'Public') {
  const concertId = await createConcert();
  const showId = await createShow(concertId, capacity);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity,
    extrasPolicy: 'AUTO_FCFS',
    name,
  });
  return { concertId, showId, segmentId };
}

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
});

describe('QA-R1 authorization matrix on POST /api/import', () => {
  it('anonymous, operator and admin', async () => {
    const { segmentId } = await publicSegment(50);
    const file = await fileOf([[...HEADERS], ['2026-09-01T10:00:00Z', 'A', 'a@x.test', 'A1', '', 'Extra']]);

    sessionUser.mockResolvedValue(null);
    const anon = await POST(request({ action: 'inspect', segmentId: String(segmentId), file }));

    sessionUser.mockResolvedValue(await createUser('OPERATOR'));
    const op = await POST(request({ action: 'inspect', segmentId: String(segmentId), file }));

    sessionUser.mockResolvedValue(await createUser('ADMIN'));
    const admin = await POST(request({ action: 'inspect', segmentId: String(segmentId), file }));

    log('QA-R1 statuses', { anon: anon.status, operator: op.status, admin: admin.status });
    log('QA-R1 anon body', await anon.clone().json());
    log('QA-R1 operator body', await op.clone().json());
    expect(anon.status).toBe(401);
    expect(op.status).toBe(403);
    expect(admin.status).toBe(200);
  });

  it('an operator cannot commit either', async () => {
    const { segmentId } = await publicSegment(50, 'Public Block');
    const file = await fileOf([[...HEADERS], ['2026-09-01T10:00:00Z', 'A', 'a@x.test', 'A1', '', 'Extra']]);
    sessionUser.mockResolvedValue(await createUser('OPERATOR'));
    const res = await POST(
      request({
        action: 'commit',
        segmentId: String(segmentId),
        file,
        profile: JSON.stringify(defaultProfileFor('EXTRA')),
        confirmation: 'Public Block',
      }),
    );
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from registrations`;
    log('QA-R1b operator commit', { status: res.status, registrations: n });
    expect(res.status).toBe(403);
    expect(n).toBe(0);
  });
});

describe('QA-R2 hostile and malformed input', () => {
  it('garbage bytes named .xlsx', async () => {
    const { segmentId } = await publicSegment(50);
    sessionUser.mockResolvedValue(await createUser('ADMIN'));
    const junk = new File([new Uint8Array(Buffer.from('not a spreadsheet at all'))], 'evil.xlsx');
    const res = await POST(request({ action: 'inspect', segmentId: String(segmentId), file: junk }));
    const body = await res.json();
    log('QA-R2 junk', { status: res.status, body });
    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it('segmentId that is not a number, negative, and unknown', async () => {
    await publicSegment(50);
    sessionUser.mockResolvedValue(await createUser('ADMIN'));
    const file = await fileOf([[...HEADERS], ['2026-09-01T10:00:00Z', 'A', 'a@x.test', 'A1', '', 'Extra']]);
    const out: Record<string, unknown> = {};
    for (const sid of ['abc', '-1', '0', '999999', '../../etc/passwd', "1; drop table attendees"]) {
      const res = await POST(request({ action: 'inspect', segmentId: sid, file }));
      out[sid] = { status: res.status, body: await res.json() };
    }
    log('QA-R2 segmentIds', out);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from show_segments`;
    expect(n).toBe(1);
    for (const v of Object.values(out)) expect((v as { status: number }).status).toBeGreaterThanOrEqual(400);
  });

  it('a 100k-character cell and SQL metacharacters commit safely', async () => {
    const { segmentId } = await publicSegment(50, 'Public Block');
    sessionUser.mockResolvedValue(await createUser('ADMIN'));
    const long = 'x'.repeat(100_000);
    const file = await fileOf([
      [...HEADERS],
      ['2026-09-01T10:00:00Z', "'; drop table attendees; --", 'a@x.test', long, '', 'Extra'],
    ]);
    const res = await POST(
      request({
        action: 'commit',
        segmentId: String(segmentId),
        file,
        profile: JSON.stringify(defaultProfileFor('EXTRA')),
        confirmation: 'Public Block',
      }),
    );
    const body = await res.json();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from attendees`;
    log('QA-R2 hostile commit', { status: res.status, attendees: n, error: (body as { error?: string }).error?.slice(0, 200) });
    expect([200, 400]).toContain(res.status);
  });

  it('a profile that is not JSON, and one missing required columns', async () => {
    const { segmentId } = await publicSegment(50);
    sessionUser.mockResolvedValue(await createUser('ADMIN'));
    const file = await fileOf([[...HEADERS], ['2026-09-01T10:00:00Z', 'A', 'a@x.test', 'A1', '', 'Extra']]);
    const bad = await POST(request({ action: 'dry-run', segmentId: String(segmentId), file, profile: '{{{' }));
    const missing = await POST(
      request({ action: 'dry-run', segmentId: String(segmentId), file, profile: JSON.stringify({ columns: {} }) }),
    );
    log('QA-R2 profiles', { bad: bad.status, badBody: await bad.json(), missing: missing.status, missingBody: await missing.json() });
    expect(bad.status).toBe(400);
    expect(missing.status).toBe(400);
  });
});

describe('QA-R3 the commit gate against blocking findings', () => {
  it('commits the unblocked remainder of a file that still has blocking rows', async () => {
    const { segmentId } = await publicSegment(50, 'Public Block');
    sessionUser.mockResolvedValue(await createUser('ADMIN'));
    const file = await fileOf([
      [...HEADERS],
      ['2026-09-01T10:00:00Z', 'A', 'a@x.test', 'A1', '', 'Extra'],
      ['2026-09-01T11:00:00Z', 'B', 'b@x.test', 'B1', '', 'Complimentary'],
    ]);
    const dry = await POST(
      request({ action: 'dry-run', segmentId: String(segmentId), file, profile: JSON.stringify(defaultProfileFor('EXTRA')) }),
    );
    const dryBody = (await dry.json()) as { counts: { blocking: number } };
    const res = await POST(
      request({
        action: 'commit',
        segmentId: String(segmentId),
        file,
        profile: JSON.stringify(defaultProfileFor('EXTRA')),
        confirmation: 'Public Block',
      }),
    );
    const body = await res.json();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from registrations`;
    log('QA-R3', { blocking: dryBody.counts.blocking, commitStatus: res.status, registrations: n, body });
    expect(res.status).toBe(409);
  });
});

describe('QA-R4 no oversell through import even from a stale plan', () => {
  it('a stale dry run cannot confirm more seats than the segment holds', async () => {
    const { segmentId } = await publicSegment(2, 'Public Block');
    sessionUser.mockResolvedValue(await createUser('ADMIN'));
    const file = await fileOf([
      [...HEADERS],
      ['2026-09-01T10:00:00Z', 'A', 'a@x.test', 'A1', '', 'Extra'],
      ['2026-09-01T10:00:00Z', 'A', 'a@x.test', 'A2', '', 'Extra'],
    ]);
    const first = await POST(
      request({
        action: 'commit', segmentId: String(segmentId), file,
        profile: JSON.stringify(defaultProfileFor('EXTRA')), confirmation: 'Public Block',
      }),
    );
    // Same file again: the pool is now empty, so the second run must not confirm.
    const second = await POST(
      request({
        action: 'commit', segmentId: String(segmentId), file,
        profile: JSON.stringify(defaultProfileFor('EXTRA')), confirmation: 'Public Block',
      }),
    );
    const statuses = await sql<{ status: string; n: number }[]>`
      select status, count(*)::int as n from attendees group by status order by status
    `;
    log('QA-R4', { first: first.status, second: second.status, statuses });
    const confirmed = statuses.find((s) => s.status === 'CONFIRMED')?.n ?? 0;
    expect(confirmed).toBeLessThanOrEqual(2);
  });
});

describe('QA-R5 the client cannot forge rows', () => {
  it('ignores a rows payload and commits what the file says', async () => {
    const { segmentId } = await publicSegment(50, 'Public Block');
    sessionUser.mockResolvedValue(await createUser('ADMIN'));
    const file = await fileOf([
      [...HEADERS],
      ['2026-09-01T10:00:00Z', 'Real Person', 'real@x.test', 'Real Person', '', 'Extra'],
    ]);
    const res = await POST(
      request({
        action: 'commit',
        segmentId: String(segmentId),
        file,
        profile: JSON.stringify(defaultProfileFor('EXTRA')),
        confirmation: 'Public Block',
        // A forged payload the browser never sends.
        rows: JSON.stringify([{ contact_name: 'Forged', attendee_name: 'Forged Guest' }]),
        parties: JSON.stringify([{ contactName: 'Forged', seats: 99 }]),
      }),
    );
    const names = await sql<{ contact_name: string }[]>`select contact_name from registrations`;
    const atts = await sql<{ full_name: string }[]>`select full_name from attendees`;
    log('QA-R5', { status: res.status, names, atts });
    expect(res.status).toBe(200);
    expect(names.map((n) => n.contact_name)).toEqual(['Real Person']);
    expect(atts.map((a) => a.full_name)).toEqual(['Real Person']);
  });
});
