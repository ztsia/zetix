import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Module W, phase 4 — the pages W added or retired and the Setup › Concert
 * Server Actions, called for real as anonymous / ADMIN / VIEWER / OPERATOR
 * assigned / OPERATOR unassigned, and fed hostile input as an ADMIN.
 * Stack: qa/support/start-v.sh against zetix_qa. No mocks.
 *
 * Action ids are read from the admin's own request (the page must be visited
 * once so the ids are current), then replayed with each role's cookies.
 */
const OUT = 'qa-artifacts/claude-W-home-setup-theme';
mkdirSync(OUT, { recursive: true });
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

type Role = 'anon' | 'admin' | 'viewer' | 'opAssigned' | 'opUnassigned';
const ROLES: Role[] = ['anon', 'admin', 'viewer', 'opAssigned', 'opUnassigned'];

async function login(browser: Browser, role: Role) {
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
  return { ctx, page };
}

async function actionIds(browser: Browser) {
  const { ctx, page } = await login(browser, 'admin');
  const ids: Record<string, string> = {};
  page.on('request', (req) => {
    const h = req.headers();
    if (req.method() !== 'POST' || !h['next-action']) return;
    const body = req.postData() ?? '';
    if (body.includes('_1_concertId')) ids.update = h['next-action'];
    else if (/^\[\d+,"[^"]+","/.test(body)) ids.set = h['next-action'];
    else if (/^\[\d+,"[^"]+"\]$/.test(body)) ids.clear = h['next-action'];
  });
  await page.goto('/admin/concerts/2/setup', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Save concert' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  const row = page.locator('div.border-b', { has: page.locator('code', { hasText: /^portal\.note_max_length$/ }) });
  await row.locator('input').fill('998');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await sql`select defaults->'portal.note_max_length' as v from concerts where id=2`)[0].v).toBe(998);
  await row.getByRole('button', { name: /Inherit/ }).click();
  await expect.poll(async () => (await sql`select defaults->'portal.note_max_length' as v from concerts where id=2`)[0].v).toBe(null);
  await ctx.close();
  expect(Object.keys(ids).sort()).toEqual(['clear', 'set', 'update']);
  return ids;
}

const B = '----qaWBoundary7MA4YWxkTrZu0gW';
function concertBody(fields: Record<string, string>): string {
  const all = { concertId: '2', name: 'Other T', season: '', slug: 'other-t', status: 'ACTIVE', timezone: 'Europe/London', startsOn: '', endsOn: '', ...fields };
  let out = '';
  for (const [k, v] of Object.entries(all)) out += `--${B}\r\nContent-Disposition: form-data; name="_1_${k}"\r\n\r\n${v}\r\n`;
  out += `--${B}\r\nContent-Disposition: form-data; name="0"\r\n\r\n[{"error":null,"message":null},"$K1"]\r\n--${B}--\r\n`;
  return out;
}

type Cell = { status: number; body: string };
async function callAction(r: APIRequestContext, id: string, body: string, multipart: boolean): Promise<Cell> {
  const res = await r.post('/admin/concerts/2/setup', {
    maxRedirects: 0,
    headers: {
      'next-action': id,
      accept: 'text/x-component',
      'content-type': multipart ? `multipart/form-data; boundary=${B}` : 'text/plain;charset=UTF-8',
    },
    data: body,
  });
  const loc = res.headers()['location'] ?? res.headers()['x-action-redirect'];
  const text = (await res.text()).replace(/\s+/g, ' ');
  const err = text.match(/"error":"([^"]*)"/)?.[1] ?? text.match(/"message":"([^"]*)"/)?.[1];
  return { status: res.status(), body: loc ? `→ ${loc}` : (err ? `error/message: ${err}` : text.slice(0, 160)) };
}

async function concert2() {
  const [row] = await sql`select name, slug, timezone, status::text, defaults, updated_at::text from concerts where id = 2`;
  return row;
}

test('W authz matrix: pages and Setup › Concert actions, every role', async ({ browser }) => {
  test.setTimeout(600_000);
  const ids = await actionIds(browser);
  const PAGES = [
    '/admin/concerts/1/home', '/admin/concerts/1/setup', '/admin/concerts/1/feedback',
    '/admin/concerts/1', '/admin/concerts/1/overview', '/admin/concerts/1/exports',
    '/admin/concerts/99999/home', '/admin/concerts/abc/setup', '/admin/concerts/99999/feedback', '/admin/concerts/99999/overview',
  ];
  const matrix: Record<string, Record<Role, Cell>> = {};
  const dbAfter: Record<string, unknown> = {};
  for (const role of ROLES) {
    const { ctx } = await login(browser, role);
    const r = ctx.request;
    for (const p of PAGES) {
      const res = await r.get(p, { maxRedirects: 0 });
      const text = await res.text();
      const loc = res.headers()['location'];
      (matrix[`PAGE ${p}`] ??= {} as Record<Role, Cell>)[role] = {
        status: res.status(),
        body: loc ? `→ ${loc}` : `${text.includes('QA September') ? 'concert name in body' : 'no concert name'}${/NEXT_HTTP_ERROR_FALLBACK;404|This page could not be found/.test(text) ? ' · 404 page' : ''}`,
      };
    }
    if (role !== 'admin') {
      const before = await concert2();
      matrix['ACTION updateConcertAction (rename concert 2)'] ??= {} as Record<Role, Cell>;
      matrix['ACTION updateConcertAction (rename concert 2)'][role] = await callAction(r, ids.update, concertBody({ name: `pwned-by-${role}` }), true);
      matrix['ACTION setConcertSettingAction (portal.note_max_length=5)'] ??= {} as Record<Role, Cell>;
      matrix['ACTION setConcertSettingAction (portal.note_max_length=5)'][role] = await callAction(r, ids.set, '[2,"portal.note_max_length","5"]', false);
      await sql`update concerts set defaults = coalesce(defaults,'{}'::jsonb) || '{"form.extra_rows_max": 3}'::jsonb where id = 2`;
      const seeded = await concert2();
      matrix['ACTION clearConcertSettingAction (form.extra_rows_max)'] ??= {} as Record<Role, Cell>;
      matrix['ACTION clearConcertSettingAction (form.extra_rows_max)'][role] = await callAction(r, ids.clear, '[2,"form.extra_rows_max"]', false);
      const after = await concert2();
      dbAfter[role] = { before, seeded, after };
      expect(after.name, `${role} renamed the concert`).toBe(before.name);
      expect(after.defaults?.['portal.note_max_length'], `${role} set a setting`).toBeUndefined();
      expect(after.defaults?.['form.extra_rows_max'], `${role} cleared a setting`).toBe(3);
      await sql`update concerts set defaults = defaults - 'form.extra_rows_max' where id = 2`;
    }
    await ctx.close();
  }
  writeFileSync(`${OUT}/authz-matrix.json`, JSON.stringify({ matrix, dbAfter }, null, 2));
  console.log(JSON.stringify(matrix, null, 1));

  for (const p of PAGES.slice(0, 3)) {
    expect(matrix[`PAGE ${p}`].admin.status).toBe(200);
    expect(matrix[`PAGE ${p}`].viewer.status).toBe(200);
    for (const role of ['anon', 'opAssigned', 'opUnassigned'] as Role[]) {
      expect(matrix[`PAGE ${p}`][role].body, `${role} ${p}`).not.toContain('concert name in body');
      expect(matrix[`PAGE ${p}`][role].status, `${role} ${p}`).not.toBe(200);
    }
  }
});

test('W Setup › Concert inputs as ADMIN: structured errors, never a 500, nothing written on refusal', async ({ browser }) => {
  test.setTimeout(300_000);
  const ids = await actionIds(browser);
  const { ctx } = await login(browser, 'admin');
  const r = ctx.request;
  const base = await concert2();
  const cases: Array<[string, Record<string, string>]> = [
    ['missing name', { name: '   ' }],
    ['name 10000 chars', { name: 'x'.repeat(10000) }],
    ['missing slug', { slug: '' }],
    ['slug ../etc', { slug: '../etc' }],
    ['slug taken (qa-sep)', { slug: 'qa-sep' }],
    ['timezone Mars/Olympus', { timezone: 'Mars/Olympus' }],
    ['timezone empty', { timezone: '' }],
    ['status ARCHIVED', { status: 'ARCHIVED' }],
    ['status missing', { status: '' }],
    ['concertId abc', { concertId: 'abc' }],
    ['concertId -1', { concertId: '-1' }],
    ['concertId 99999', { concertId: '99999' }],
    ['startsOn 2026-13-45 (matches the regex, not a date)', { startsOn: '2026-13-45' }],
    ['endsOn 2026-02-30', { startsOn: '2026-02-01', endsOn: '2026-02-30' }],
    ['ends before start', { startsOn: '2026-02-10', endsOn: '2026-02-01' }],
  ];
  const results: Record<string, Cell & { wrote: boolean }> = {};
  for (const [name, patch] of cases) {
    const res = await callAction(r, ids.update, concertBody(patch), true);
    const after = await concert2();
    const wrote = after.updated_at !== base.updated_at;
    results[name] = { ...res, wrote };
    if (wrote) await sql`update concerts set name='Other T', slug='other-t', timezone='Europe/London', status='ACTIVE', starts_on=null, ends_on=null where id=2`;
  }
  // SQL metacharacters must be stored literally.
  const meta = "Robert'); drop table concerts;--";
  results['sql metachar name'] = { ...(await callAction(r, ids.update, concertBody({ name: meta }), true)), wrote: true };
  const [stored] = await sql`select name from concerts where id = 2`;
  results['sql metachar name'].body += ` · stored=${JSON.stringify(stored.name)}`;
  await sql`update concerts set name='Other T' where id=2`;

  const settingCases: Array<[string, string]> = [
    ['key ../../etc/passwd', '[2,"../../etc/passwd","1"]'],
    ['key sql metachar', `[2,"x'); drop table concerts;--","1"]`],
    ['key email.max_per_day (system-only)', '[2,"email.max_per_day","5"]'],
    ['number as text', '[2,"portal.note_max_length","lots"]'],
    ['negative', '[2,"portal.note_max_length","-5"]'],
    ['huge number', '[2,"portal.note_max_length","1e308"]'],
    ['concertId string', '["2","portal.note_max_length","5"]'],
    ['concertId 99999', '[99999,"portal.note_max_length","5"]'],
    ['concertId -1', '[-1,"portal.note_max_length","5"]'],
    ['boolean garbage', '[2,"portal.enabled","maybe"]'],
    ['notes_close_at garbage', '[2,"portal.notes_close_at","next tuesday"]'],
    ['notes_close_at year 275760', '[2,"portal.notes_close_at","+275760-09-13T00:00:00Z"]'],
    ['wall visibility bad', '[2,"portal.public_wall_visibility","EVERYONE"]'],
    ['base_claim_deadline garbage', '[2,"allocation.base_claim_deadline","next tuesday"]'],
    ['unlock_mode garbage', '[2,"portal.unlock_mode","BANANA"]'],
    ['extras_policy wrong shape', '[2,"allocation.extras_policy","[1,2,3]"]'],
    ['feedback_close_at garbage', '[2,"portal.feedback_close_at","soonish"]'],
    ['value 100k chars', `[2,"allocation.base_claim_deadline","${'y'.repeat(100000)}"]`],
    ['missing value arg', '[2,"portal.note_max_length"]'],
  ];
  const settingResults: Record<string, Cell & { defaults: unknown }> = {};
  for (const [name, body] of settingCases) {
    const res = await callAction(r, ids.set, body, false);
    const after = await concert2();
    const [cols] = await sql`select notes_close_at::text, portal_enabled, public_wall_visibility::text from concerts where id=2`;
    settingResults[name] = { ...res, defaults: { bag: after.defaults, cols } };
    await sql`update concerts set defaults = null, notes_close_at = null, portal_enabled = null, public_wall_visibility = null where id = 2`;
  }
  await ctx.close();
  writeFileSync(`${OUT}/setup-inputs.json`, JSON.stringify({ results, settingResults }, null, 2));
  console.log(JSON.stringify({ results, settingResults }, null, 1).slice(0, 12000));
  for (const [name, res] of Object.entries(results)) expect(res.status, name).not.toBe(500);
  for (const [name, res] of Object.entries(settingResults)) expect(res.status, name).not.toBe(500);
});
