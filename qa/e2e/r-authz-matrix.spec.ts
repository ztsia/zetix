import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Module R, phase 4 — every Route Handler, and the scanner surface, called
 * for real as anonymous / ADMIN / VIEWER / OPERATOR (assigned to show 1).
 * No mocks: the stack is qa/support/start-r.sh against zetix_qa.
 */
const OUT = 'qa-artifacts/claude-R-roles-accounts';
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

type Role = 'anon' | 'admin' | 'viewer' | 'operator';

async function contextFor(browser: Browser, role: Role): Promise<APIRequestContext> {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  if (role === 'admin' || role === 'viewer') {
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(role === 'admin' ? 'committee@example.test' : 'mei@example.test');
    await page.locator('input[name="password"]').fill(role === 'admin' ? 'qa-admin-pass' : 'qa-viewer-pass');
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  } else if (role === 'operator') {
    await page.goto('/scan/login');
    await page.locator('input[name="displayName"]').fill('Wei Ling');
    await page.locator('input[name="code"]').fill('qa-op-code');
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/scan/login')), page.locator('button[type="submit"]').click()]);
  }
  return ctx.request;
}

const xlsxBody = { filename: 'x', headers: ['a'], rows: [['alice@example.test']], timeZone: 'UTC' };
const previewBody = { concertId: 1, showId: 1, subject: 'FIRST', layout: { elements: [] } };

const CALLS: Array<{ name: string; run: (r: APIRequestContext) => Promise<{ status: number; body: string }> }> = [
  { name: 'GET /api/checkin/manifest?showId=1', run: (r) => get(r, '/api/checkin/manifest?showId=1') },
  { name: 'GET /api/checkin/manifest?showId=2', run: (r) => get(r, '/api/checkin/manifest?showId=2') },
  { name: 'POST /api/checkin/scan show 1 (empty batch)', run: (r) => post(r, '/api/checkin/scan', { showId: 1, scans: [] }) },
  { name: 'POST /api/export/xlsx', run: (r) => post(r, '/api/export/xlsx', xlsxBody) },
  { name: 'GET /api/notes/export?concertId=1', run: (r) => get(r, '/api/notes/export?concertId=1') },
  { name: 'GET /api/import/template?concertId=1', run: (r) => get(r, '/api/import/template?concertId=1') },
  { name: 'GET /api/import/profiles?showId=1', run: (r) => get(r, '/api/import/profiles?showId=1') },
  { name: 'POST /api/import/profiles (empty)', run: (r) => post(r, '/api/import/profiles', {}) },
  { name: 'POST /api/import (no form)', run: (r) => post(r, '/api/import', {}) },
  { name: 'GET /api/tickets/12/pdf', run: (r) => get(r, '/api/tickets/12/pdf') },
  { name: 'POST /api/tickets/preview', run: (r) => post(r, '/api/tickets/preview', previewBody) },
  { name: 'POST /api/ticket-assets (no form)', run: (r) => post(r, '/api/ticket-assets', {}) },
  { name: 'GET /api/ticket-assets/x/y.png', run: (r) => get(r, '/api/ticket-assets/x/y.png') },
  { name: 'POST /api/portal/booklet (no form)', run: (r) => post(r, '/api/portal/booklet', {}) },
  { name: 'PATCH /api/portal/booklet (empty)', run: async (r) => { const res = await r.patch('/api/portal/booklet', { data: {}, maxRedirects: 0 }); return { status: res.status(), body: (await res.text()).slice(0, 160) }; } },
  { name: 'POST /api/outbox/dispatch', run: (r) => post(r, '/api/outbox/dispatch', {}) },
  { name: 'PAGE /scan', run: (r) => get(r, '/scan') },
  { name: 'PAGE /scan/1', run: (r) => get(r, '/scan/1') },
  { name: 'PAGE /admin/concerts', run: (r) => get(r, '/admin/concerts') },
];

async function get(r: APIRequestContext, url: string) {
  const res = await r.get(url, { maxRedirects: 0 });
  const loc = res.headers()['location'];
  return { status: res.status(), body: loc ? `→ ${loc}` : (await res.text()).replace(/\s+/g, ' ').slice(0, 160) };
}
async function post(r: APIRequestContext, url: string, data: unknown) {
  const res = await r.post(url, { data, maxRedirects: 0 });
  const loc = res.headers()['location'];
  return { status: res.status(), body: loc ? `→ ${loc}` : (await res.text()).replace(/\s+/g, ' ').slice(0, 160) };
}

test('authorization matrix, every cell called', async ({ browser }) => {
  test.setTimeout(600_000);
  const roles: Role[] = ['anon', 'admin', 'viewer', 'operator'];
  const ctxs = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await contextFor(browser, r)] as const)));
  const [{ n: scanRejectsBefore }] = await sql`select count(*)::int as n from audit_log where action like '%reject%'`;
  const matrix: Record<string, Record<Role, { status: number; body: string }>> = {};
  for (const call of CALLS) {
    matrix[call.name] = {} as Record<Role, { status: number; body: string }>;
    for (const role of roles) matrix[call.name][role] = await call.run(ctxs[role]);
  }
  writeFileSync(`${OUT}/authz-matrix.json`, JSON.stringify(matrix, null, 2));
  for (const [name, row] of Object.entries(matrix)) {
    console.log(name.padEnd(46), roles.map((r) => `${r}=${row[r].status}`).join('  '), '| viewer:', row.viewer.body.slice(0, 90));
  }
  // The manifest is the roster: a viewer must get nothing but a refusal.
  expect(matrix['GET /api/checkin/manifest?showId=1'].viewer.status).toBe(404);
  expect(matrix['GET /api/checkin/manifest?showId=2'].operator.status).toBe(404);
  expect(matrix['GET /api/checkin/manifest?showId=1'].operator.status).toBe(200);
  const refusedForViewer = [
    'POST /api/export/xlsx', 'GET /api/notes/export?concertId=1', 'GET /api/import/template?concertId=1',
    'POST /api/import (no form)', 'GET /api/tickets/12/pdf', 'POST /api/tickets/preview',
    'POST /api/ticket-assets (no form)', 'POST /api/portal/booklet (no form)', 'POST /api/outbox/dispatch',
    'POST /api/import/profiles (empty)',
  ];
  for (const name of refusedForViewer) expect.soft(matrix[name].viewer.status, name).toBeGreaterThanOrEqual(401);
  const [{ n: scanRejectsAfter }] = await sql`select count(*)::int as n from audit_log where action like '%reject%'`;
  console.log('reject audit rows before/after:', scanRejectsBefore, scanRejectsAfter);
});
