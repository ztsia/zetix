import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/export/xlsx` — the one Route Handler F2 ships (spec/admin.md §14.3).
 *
 * Route Handlers are **not** covered by `src/proxy.ts`: `/api` is excluded from
 * its matcher so an unrelated auth outage cannot take the keep-alive down. That
 * makes the check inside the handler the only one there is, which is exactly
 * what these pin down.
 *
 * Operators may not export at all — §14.3 says they cannot "edit any data,
 * export, or view PII beyond name and ticket status".
 */
const getSessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSessionUser: () => getSessionUser() }));

const { POST } = await import('@/app/api/export/xlsx/route');

const admin = { id: 'a1', email: 'admin@x', displayName: 'Committee', role: 'ADMIN' as const };
const operator = { id: 'o1', email: 'o@operators.invalid', displayName: 'Wei', role: 'OPERATOR' as const };

const body = {
  filename: 'registrations',
  headers: ['Name', 'Registered'],
  rows: [['Alice Tan', { date: '2026-09-19T15:30:00Z' }]],
  timeZone: 'Asia/Singapore',
};

const post = (payload: unknown = body) =>
  POST(
    new Request('http://localhost/api/export/xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

beforeEach(() => getSessionUser.mockReset());

describe('POST /api/export/xlsx', () => {
  it('refuses an anonymous caller with 401', async () => {
    getSessionUser.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
  });

  it('refuses an OPERATOR with 403 — operators may not export', async () => {
    getSessionUser.mockResolvedValue(operator);
    expect((await post()).status).toBe(403);
  });

  it('returns a real xlsx workbook to an ADMIN', async () => {
    getSessionUser.mockResolvedValue(admin);
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('spreadsheetml');
    expect(response.headers.get('Content-Disposition')).toContain('registrations-');

    // A real .xlsx is a zip: it starts with the local file header magic `PK\x03\x04`.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('rejects a malformed body before doing any work', async () => {
    getSessionUser.mockResolvedValue(admin);
    expect((await post({ nope: true })).status).toBe(400);
  });

  it('rejects an unknown timezone rather than throwing a 500', async () => {
    getSessionUser.mockResolvedValue(admin);
    expect((await post({ ...body, timeZone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('survives a filename Excel would reject as a sheet name', async () => {
    // `filename` becomes the worksheet name, and Excel forbids * ? : \\ / [ ].
    // Left unsanitised this threw *outside* the zod boundary and 500'd — and a
    // concert called "Gala 2026/27" is enough to hit it, so this is ordinary
    // data, not just hostile input.
    getSessionUser.mockResolvedValue(admin);
    for (const filename of ['../../../etc/passwd', 'Gala 2026/27', 'a[b]c*d?e:f', "'quoted'"]) {
      const response = await post({ ...body, filename });
      expect(response.status, filename).toBe(200);
    }
  });

  it('refuses an export too large to build inside a function timeout', async () => {
    getSessionUser.mockResolvedValue(admin);
    const huge = {
      ...body,
      headers: Array.from({ length: 50 }, (_, i) => `c${i}`),
      rows: Array.from({ length: 5000 }, () => Array.from({ length: 50 }, () => 'x')),
    };
    expect((await post(huge)).status).toBe(413);
  });
});
