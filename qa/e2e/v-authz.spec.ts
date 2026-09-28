import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Module V, phase 4 — intake's Route Handlers and public pages, called for real
 * as anonymous / ADMIN / VIEWER / OPERATOR assigned / OPERATOR unassigned.
 * Stack: qa/support/start-v.sh against zetix_qa. No mocks.
 */
const OUT = 'qa-artifacts/claude-V-intake';
mkdirSync(OUT, { recursive: true });
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', { prepare: false, max: 2 });
const seed = JSON.parse(readFileSync('/tmp/qa-v-seed.json', 'utf8'));
test.afterAll(async () => { await sql.end(); });

type Role = 'anon' | 'admin' | 'viewer' | 'opAssigned' | 'opUnassigned';

async function contextFor(browser: Browser, role: Role): Promise<APIRequestContext> {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const page = await ctx.newPage();
  if (role === 'admin' || role === 'viewer') {
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(role === 'admin' ? 'committee@example.test' : 'mei@example.test');
    await page.locator('input[name="password"]').fill(role === 'admin' ? 'qa-admin-pass' : 'qa-viewer-pass');
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  } else if (role === 'opAssigned' || role === 'opUnassigned') {
    await page.goto('/scan/login');
    await page.locator('input[name="displayName"]').fill(role === 'opAssigned' ? 'Wei Ling' : 'Bob Unassigned');
    await page.locator('input[name="code"]').fill(role === 'opAssigned' ? 'qa-op-code' : 'qa-op-code-2');
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 15_000 }).catch(() => null), page.locator('button[type="submit"]').click()]);
  }
  await page.close();
  return ctx.request;
}

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CSV = Buffer.from('Timestamp,Name,Email,Guest\n,Authz Probe,authz@example.test,Authz Guest\n');
const profile = JSON.stringify({ columns: { requested_at: 'Timestamp', contact_name: 'Name', contact_email: 'Email', attendee_name: 'Guest' }, default_allocation_type: 'EXTRA' });

type Cell = { status: number; body: string };
async function shape(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<Cell> {
  const loc = res.headers()['location'];
  return { status: res.status(), body: loc ? `→ ${loc}` : (await res.text()).replace(/\s+/g, ' ').slice(0, 140) };
}

const CALLS: Array<{ name: string; run: (r: APIRequestContext) => Promise<Cell> }> = [
  {
    name: 'POST /api/form-banners (valid PNG, concert 3 form 1)',
    run: async (r) => shape(await r.post('/api/form-banners', { maxRedirects: 0, multipart: {
      concertId: String(seed.concert), formId: String(seed.autumnForm), colour: '#3366cc',
      file: { name: 'b.png', mimeType: 'image/png', buffer: PNG } } })),
  },
  {
    name: 'POST /api/form-banners (text file claiming image/png)',
    run: async (r) => shape(await r.post('/api/form-banners', { maxRedirects: 0, multipart: {
      concertId: String(seed.concert), formId: String(seed.autumnForm),
      file: { name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<script>alert(1)</script>') } } })),
  },
  {
    name: 'POST /api/form-banners (form of another concert)',
    run: async (r) => shape(await r.post('/api/form-banners', { maxRedirects: 0, multipart: {
      concertId: '1', formId: String(seed.autumnForm), file: { name: 'b.png', mimeType: 'image/png', buffer: PNG } } })),
  },
  { name: 'GET /api/form-banners/..%2f..%2f..%2fetc%2fpasswd.png', run: async (r) => shape(await r.get('/api/form-banners/..%2f..%2f..%2fetc%2fpasswd.png', { maxRedirects: 0 })) },
  { name: 'GET /api/form-banners/forms/1/..%2e/..%2e/x.png', run: async (r) => shape(await r.get('/api/form-banners/forms/1/..%2e/..%2e/x.png', { maxRedirects: 0 })) },
  {
    name: 'POST /api/import action=stage (1-row CSV, public segment)',
    run: async (r) => shape(await r.post('/api/import', { maxRedirects: 0, multipart: {
      action: 'stage', segmentId: String(seed.pub), profile, file: { name: 'authz.csv', mimeType: 'text/csv', buffer: CSV } } })),
  },
  {
    name: 'POST /api/import action=inspect',
    run: async (r) => shape(await r.post('/api/import', { maxRedirects: 0, multipart: {
      action: 'inspect', segmentId: String(seed.pub), file: { name: 'authz.csv', mimeType: 'text/csv', buffer: CSV } } })),
  },
  { name: 'PAGE /admin/concerts/3/import', run: async (r) => shape(await r.get(`/admin/concerts/${seed.concert}/import`, { maxRedirects: 0 })) },
  { name: 'PAGE /admin/concerts/3/forms', run: async (r) => shape(await r.get(`/admin/concerts/${seed.concert}/forms`, { maxRedirects: 0 })) },
  { name: 'PAGE /admin/concerts/3/players', run: async (r) => shape(await r.get(`/admin/concerts/${seed.concert}/players`, { maxRedirects: 0 })) },
  { name: 'PAGE /f/update?t=<nadia>', run: async (r) => shape(await r.get('/f/update?t=qa-update-nadia-0000000000', { maxRedirects: 0 })) },
  { name: 'PAGE /f/update?t=garbage', run: async (r) => shape(await r.get('/f/update?t=garbage%00%27--', { maxRedirects: 0 })) },
];

test('V authorization matrix, every cell called', async ({ browser }) => {
  test.setTimeout(600_000);
  const roles: Role[] = ['anon', 'admin', 'viewer', 'opAssigned', 'opUnassigned'];
  const ctxs = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await contextFor(browser, r)] as const))) as Record<Role, APIRequestContext>;
  const [{ n: batchesBefore }] = await sql`select count(*)::int as n from import_batches`;
  const matrix: Record<string, Record<Role, Cell>> = {};
  for (const call of CALLS) {
    matrix[call.name] = {} as Record<Role, Cell>;
    for (const role of roles) matrix[call.name][role] = await call.run(ctxs[role]);
  }
  const [{ n: batchesAfter }] = await sql`select count(*)::int as n from import_batches`;
  const batches = await sql`select b.id::int, b.uploaded_by from import_batches b order by id`;
  writeFileSync(`${OUT}/authz-matrix.json`, JSON.stringify({ matrix, batchesBefore, batchesAfter, batches }, null, 2));

  const upload = matrix['POST /api/form-banners (valid PNG, concert 3 form 1)'];
  expect(upload.admin.status).toBe(200);
  for (const role of ['anon', 'viewer', 'opAssigned', 'opUnassigned'] as const) expect(upload[role].status).toBeGreaterThanOrEqual(400);
  const stage = matrix['POST /api/import action=stage (1-row CSV, public segment)'];
  expect(stage.admin.status).toBe(200);
  for (const role of ['anon', 'viewer', 'opAssigned', 'opUnassigned'] as const) expect(stage[role].status).toBeGreaterThanOrEqual(400);
  expect(batchesAfter - batchesBefore).toBe(1);
  for (const role of roles) {
    expect(matrix['GET /api/form-banners/..%2f..%2f..%2fetc%2fpasswd.png'][role].status).toBe(404);
    expect(matrix['POST /api/form-banners (text file claiming image/png)'][role].status).not.toBe(200);
    expect(matrix['POST /api/form-banners (form of another concert)'][role].status).not.toBe(200);
  }
  for (const page of ['PAGE /admin/concerts/3/import', 'PAGE /admin/concerts/3/forms']) {
    expect(matrix[page].anon.status).not.toBe(200);
    expect(matrix[page].opAssigned.status).not.toBe(200);
    expect(matrix[page].admin.status).toBe(200);
    expect(matrix[page].viewer.status).toBe(200);
  }
});
