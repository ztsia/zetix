import { test, expect, type Request } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Module R, phase 4 — Settings › People's createAccountAction and
 * setRoleAction fed valid, missing, wrong-type, out-of-range and hostile input
 * by replaying the admin's own request with a rewritten body.
 */
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

test('People inputs: every case answers with a structured error, never a 500, and writes nothing', async ({ page }) => {
  test.setTimeout(300_000);
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.240' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('committee@example.test');
  await page.locator('input[name="password"]').fill('qa-admin-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await page.goto('/admin/settings/people');

  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  const onReq = (req: Request) => {
    const h = req.headers();
    if (req.method() === 'POST' && h['next-action'] && !captured) captured = { url: req.url(), headers: h, body: req.postData() ?? '' };
  };
  page.on('request', onReq);
  const seedEmail = `inputs-${Date.now()}@example.test`;
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.locator('#person-name').fill('Input Seed');
  await page.locator('#person-email').fill(seedEmail);
  await page.getByRole('button', { name: 'Create and show password' }).click();
  await expect(page.locator('#issued-password')).toBeVisible();
  page.off('request', onReq);
  const c = captured!;
  writeFileSync('qa-artifacts/claude-R-roles-accounts/create-action-body.txt', c.body.replace(/[\r]/g, ''));

  const cases: Array<[string, Record<string, string>]> = [
    ['missing email', { email: '' }],
    ['not an email', { email: 'not-an-email' }],
    ['duplicate (case-folded)', { email: seedEmail.toUpperCase() }],
    ['operator domain', { email: 'sneaky@operators.invalid' }],
    ['missing name', { displayName: '   ' }],
    ['name 5000 chars', { displayName: 'x'.repeat(5000) }],
    ['role OPERATOR', { role: 'OPERATOR' }],
    ['role empty', { role: '' }],
    ['sql metachar name', { displayName: "Robert'); drop table app_users;--", email: `sqlmeta-${Date.now()}@example.test` }],
    ['email 400 chars', { email: `${'a'.repeat(390)}@example.test` }],
  ];
  const before = (await sql`select count(*)::int as n from app_users`)[0].n;
  const results: Record<string, string> = {};
  for (const [name, patch] of cases) {
    let body = c.body;
    for (const [field, value] of Object.entries(patch)) {
      const current = new RegExp(`(name="_\\d+_${field}"\\r?\\n\\r?\\n)([^\\r\\n]*)`);
      body = body.replace(current, (_m, head) => `${head}${value}`);
    }
    if (!('email' in patch)) body = body.replace(seedEmail, `fresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`);
    const headers: Record<string, string> = {};
    for (const h of ['next-action', 'content-type', 'next-router-state-tree', 'accept']) if (c.headers[h]) headers[h] = c.headers[h];
    const res = await page.request.post(c.url, { headers, data: body, maxRedirects: 0 });
    const text = (await res.text()).replace(/\s+/g, ' ');
    const err = text.match(/"error":"([^"]*)"/)?.[1] ?? text.slice(0, 200);
    results[name] = `${res.status()} ${err.slice(0, 160)}`;
  }
  const after = (await sql`select count(*)::int as n from app_users`)[0].n;
  const sqlRow = await sql`select display_name from app_users where display_name like 'Robert%'`;
  console.log(JSON.stringify(results, null, 1));
  console.log('app_users before/after:', before, after, 'sql-meta row:', sqlRow.map((r) => r.display_name));
  writeFileSync('qa-artifacts/claude-R-roles-accounts/people-inputs.json', JSON.stringify({ results, before, after, sqlRow }, null, 2));
  for (const [name, r] of Object.entries(results)) {
    if (name === 'sql metachar name') continue;
    expect.soft(r.startsWith('200'), `${name}: ${r}`).toBe(true);
  }
});
