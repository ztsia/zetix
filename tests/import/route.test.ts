import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow } from '../helpers/fixtures';
import { TEMPLATE_HEADERS, defaultProfileFor } from '@/lib/import/template';

/**
 * The import endpoint's authorization boundary and its refusals.
 *
 * Import writes registrations and attendees for an entire segment, so this route
 * is `ADMIN`-only (spec/admin.md §14.3) and `/api` sits outside the proxy
 * matcher — the check lives in the handler or nowhere. Following
 * `tests/auth/route-guards.test.ts`: the real route module, the real database,
 * and only `getSessionUser` stubbed, because it is the one leaf needing Supabase
 * and a cloud container has no service-role key to make users with
 * (spec/local.md §7).
 */

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const { POST } = await import('@/app/api/import/route');

/**
 * A real `app_users` row, not a bare uuid.
 *
 * `import_batches.uploaded_by` is a foreign key, so a session whose id has no
 * row fails at insert — which is exactly what a stubbed uuid gave, and exactly
 * the kind of thing a test that only mocks the session would never notice.
 */
async function createUser(role: 'ADMIN' | 'OPERATOR') {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}, ${`${role.toLowerCase()}-${id}@example.test`}, ${role}, ${role}::user_role)
  `;
  return { id, role };
}

async function sheetBytes(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Registrations');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const HEADERS = Object.values(TEMPLATE_HEADERS);

/** Two rows of one party, in the template's own shape. */
async function sampleFile(): Promise<File> {
  const bytes = await sheetBytes([
    [...HEADERS],
    ['2026-09-01T10:00:00Z', 'Alice Tan', 'alice@example.com', 'Alice Tan', '', 'Extra'],
    ['2026-09-01T10:00:00Z', 'Alice Tan', 'alice@example.com', 'Ben Tan', '', 'Extra'],
  ]);
  return new File([new Uint8Array(bytes)], 'round1.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function request(fields: Record<string, string | File>): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request('http://localhost/api/import', { method: 'POST', body });
}

let segmentId: number;
let adminUser: { id: string; role: 'ADMIN' | 'OPERATOR' };
let operatorUser: { id: string; role: 'ADMIN' | 'OPERATOR' };

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();

  const concertId = await createConcert();
  const showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: 100,
    extrasPolicy: 'AUTO_FCFS',
    name: 'Public',
  });

  adminUser = await createUser('ADMIN');
  operatorUser = await createUser('OPERATOR');
});

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    sessionUser.mockResolvedValue(null);
    const res = await POST(
      request({ action: 'inspect', segmentId: String(segmentId), file: await sampleFile() }),
    );
    expect(res.status).toBe(401);
  });

  /**
   * The one that matters. An operator holds a real signed-in session, and the
   * import report is the full contact list for a segment before it is even
   * written — the same disclosure the manifest boundary exists to prevent
   * (spec/checkin.md §12.3).
   */
  it('refuses an operator', async () => {
    sessionUser.mockResolvedValue(operatorUser);
    const res = await POST(
      request({ action: 'inspect', segmentId: String(segmentId), file: await sampleFile() }),
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body).not.toHaveProperty('headers');
    expect(JSON.stringify(body)).not.toContain('alice@example.com');
  });

  it('admits an admin', async () => {
    sessionUser.mockResolvedValue(adminUser);
    const res = await POST(
      request({ action: 'inspect', segmentId: String(segmentId), file: await sampleFile() }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).headers).toEqual(HEADERS);
  });
});

describe('refusals', () => {
  beforeEach(() => sessionUser.mockResolvedValue(adminUser));

  it('400s a file that is not a spreadsheet, naming it', async () => {
    const junk = new File([new Uint8Array(Buffer.from('nope'))], 'notes.xlsx');
    const res = await POST(
      request({ action: 'inspect', segmentId: String(segmentId), file: junk }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('notes.xlsx');
  });

  it('404s an unknown segment', async () => {
    const res = await POST(
      request({ action: 'inspect', segmentId: '999999', file: await sampleFile() }),
    );
    expect(res.status).toBe(404);
  });

  it('400s a malformed mapping profile', async () => {
    const res = await POST(
      request({
        action: 'stage',
        segmentId: String(segmentId),
        file: await sampleFile(),
        profile: '{"columns":{}}',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Mapping profile is invalid/);
  });
});

describe('the happy path end to end', () => {
  beforeEach(() => sessionUser.mockResolvedValue(adminUser));

  it('inspects and stages, claiming nothing until the grid commits', async () => {
    const inspect = await POST(
      request({ action: 'inspect', segmentId: String(segmentId), file: await sampleFile() }),
    );
    expect(inspect.status).toBe(200);
    const inspected = await inspect.json();
    expect(inspected.audienceMode).toBe('PUBLIC');
    expect(inspected.suggested.requested_at).toBe(TEMPLATE_HEADERS.timestamp);

    const staged = await POST(
      request({
        action: 'stage',
        segmentId: String(segmentId),
        file: await sampleFile(),
        profile: JSON.stringify(publicProfile()),
      }),
    );
    expect(staged.status).toBe(200);
    const body = await staged.json();
    expect(body.rows).toBe(2);

    // Staged, not written: the rows wait in the grid (spec/v3.md §25.7).
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from registrations`;
    expect(Number(count)).toBe(0);
    const rows = await sql<{ status: string; party_key: string }[]>`
      select status::text, party_key from import_rows where batch_id = ${body.batchId}
    `;
    expect(rows.map((r) => r.status)).toEqual(['STAGED', 'STAGED']);
    expect(new Set(rows.map((r) => r.party_key)).size).toBe(1);

    const [audit] = await sql<{ action: string }[]>`select action from audit_log order by id desc limit 1`;
    expect(audit.action).toBe('import.staged');
  });

  it('refuses the retired dry-run and commit actions', async () => {
    for (const action of ['dry-run', 'commit']) {
      const res = await POST(
        request({ action, segmentId: String(segmentId), file: await sampleFile(), profile: JSON.stringify(publicProfile()) }),
      );
      expect(res.status).toBe(400);
    }
  });
});

/** The profile the screen builds for a public segment: type column unmapped. */
function publicProfile() {
  const base = defaultProfileFor('EXTRA');
  return { ...base, columns: { ...base.columns, allocation_type: null } };
}

const { GET, POST: SAVE } = await import('@/app/api/import/profiles/route');

describe('saved mapping profiles (§9.3)', () => {
  beforeEach(() => sessionUser.mockResolvedValue(adminUser));

  it('refuses an operator', async () => {
    sessionUser.mockResolvedValue(operatorUser);
    const res = await GET(new Request('http://localhost/api/import/profiles'));
    expect(res.status).toBe(403);
  });

  it('saves a profile and lists it back', async () => {
    const saved = await SAVE(
      new Request('http://localhost/api/import/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Google Form, public round',
          config: publicProfile(),
        }),
      }),
    );
    expect(saved.status).toBe(200);

    const listed = await GET(new Request('http://localhost/api/import/profiles'));
    const { profiles } = await listed.json();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('Google Form, public round');
    // Stored in the §9.3 shape, so it parses back on the next round.
    expect(profiles[0].config.columns.requested_at).toBe(TEMPLATE_HEADERS.timestamp);
  });

  /** A profile that cannot be read back is worse than none: it fails at round two. */
  it('refuses to store a mapping the importer could not use', async () => {
    const res = await SAVE(
      new Request('http://localhost/api/import/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Broken', config: { columns: {} } }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not valid/);

    const [{ count }] = await sql<{ count: string }[]>`select count(*) from mapping_profiles`;
    expect(Number(count)).toBe(0);
  });
});
