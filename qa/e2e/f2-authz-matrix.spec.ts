import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import postgres from 'postgres';

/** Phase 4 authorization matrix — every cell filled by making the call. */
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

async function asAdmin(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

async function asOperator(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

test('authorization matrix', async ({ browser }) => {
  test.setTimeout(180_000);
  const [{ id: assigned }] = await sql`select id from shows where name = 'Evening Show'`;
  const [{ id: unassigned }] = await sql`select id from shows where name = 'Matinee Show'`;
  const [{ id: concertId }] = await sql`select id from concerts where slug = 'qa-opener'`;

  const actors: [string, BrowserContext | null][] = [
    ['anonymous', await browser.newContext()],
    ['ADMIN', await asAdmin(browser)],
    ['OPERATOR assigned', await asOperator(browser, 'Wei Ling')],
    ['OPERATOR unassigned', await asOperator(browser, 'No Shows')],
  ];

  const targets: [string, string][] = [
    ['GET /admin/concerts', `/admin/concerts`],
    ['GET /admin/settings', `/admin/settings`],
    [`GET /admin/concerts/${concertId}/registrations`, `/admin/concerts/${concertId}/registrations`],
    ['GET /scan', '/scan'],
    [`GET /scan/${assigned} (assigned to Wei Ling)`, `/scan/${assigned}`],
    [`GET /scan/${unassigned} (assigned to nobody)`, `/scan/${unassigned}`],
  ];

  const table: Record<string, Record<string, string>> = {};
  for (const [label, path] of targets) {
    table[label] = {};
    for (const [actor, ctx] of actors) {
      const page = await ctx!.newPage();
      const res = await page.goto(path);
      const landed = new URL(page.url()).pathname;
      table[label][actor] = `${res?.status()} ${landed === path ? '' : `→ ${landed}`}`.trim();
      await page.close();
    }
  }

  // POST /api/export/xlsx
  table['POST /api/export/xlsx'] = {};
  for (const [actor, ctx] of actors) {
    const res = await ctx!.request.post('/api/export/xlsx', {
      data: { filename: 'x', headers: ['a'], rows: [['b']], timeZone: 'UTC' },
    });
    table['POST /api/export/xlsx'][actor] = String(res.status());
  }

  console.log('\n| Endpoint | ' + actors.map(([a]) => a).join(' | ') + ' |');
  console.log('|---|' + actors.map(() => '---|').join(''));
  for (const [label, row] of Object.entries(table)) {
    console.log(`| ${label} | ` + actors.map(([a]) => row[a]).join(' | ') + ' |');
  }

  // The cell that ends the concert if it is wrong.
  expect(table[`GET /scan/${unassigned} (assigned to nobody)`]['OPERATOR assigned']).toBe('404');
  expect(table[`GET /scan/${assigned} (assigned to Wei Ling)`]['OPERATOR unassigned']).toBe('404');
  expect(table['POST /api/export/xlsx']['OPERATOR assigned']).toBe('403');
  expect(table['POST /api/export/xlsx']['anonymous']).toBe('401');
  for (const [, ctx] of actors) await ctx!.close();
});
