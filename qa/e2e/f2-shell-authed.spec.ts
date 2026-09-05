import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Pass B — signed-in flows.
 *
 * The Supabase Auth endpoint is a local stand-in (`fake-gotrue.mjs`) because
 * creating a real user needs the service-role key, which no cloud session holds
 * (docs/local.md §7). Everything under test here — the guards, the role split,
 * the assignment check, the shell, the DataTable — is the branch's own code and
 * runs unmodified; only the identity provider is local.
 */
const SHOTS = 'qa-artifacts/F2-app-shell-auth/screens';
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

async function loginAdmin(page: Page, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

async function loginOperator(page: Page, name: string, next?: string) {
  await page.goto(next ? `/scan/login?next=${encodeURIComponent(next)}` : '/scan/login');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 15000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

test('FLOW-1: admin signs in with the code alone and reaches the console', async ({ page }) => {
  await sql`delete from auth_failures`;
  await loginAdmin(page);
  expect(page.url()).toContain('/admin');
  await expect(page.getByRole('heading', { name: 'Concerts' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-3-console.png`, fullPage: true });

  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name.startsWith('sb-'))).toBe(true);

  // the successful login cleared the throttle bucket and stamped last_login_at
  expect((await sql`select count(*)::int as c from auth_failures`)[0].c).toBe(0);
  const [row] = await sql`select last_login_at from app_users where email = 'committee@example.org'`;
  expect(row.last_login_at).not.toBeNull();
});

test('FLOW-1b: every route in admin.md §14.1 renders for an admin', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAdmin(page);
  const [{ id: concertId }] = await sql`select id from concerts where slug = 'qa-opener'`;
  const paths = [
    '/admin', '/admin/concerts', '/admin/settings',
    ...['overview','shows','players','forms','registrations','extras-review','import',
        'tickets','email','checkin','operators','portal','notes','exports']
      .map((s) => `/admin/concerts/${concertId}/${s}`),
    `/admin/concerts/${concertId}`,
  ];
  const failures: string[] = [];
  for (const path of paths) {
    const res = await page.goto(path);
    const status = res?.status() ?? 0;
    const body = await page.content();
    if (status >= 400 || /Application error|Unhandled Runtime Error/.test(body)) {
      failures.push(`${path} -> ${status}`);
    }
  }
  expect(failures).toEqual([]);
  await page.goto(`/admin/concerts/${concertId}/registrations`);
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-5-route-skeleton.png`, fullPage: true });
});

test('FLOW-7: an operator cannot reach the admin console', async ({ page }) => {
  await loginOperator(page, 'Wei Ling');
  const res = await page.goto('/admin/concerts');
  expect(page.url()).not.toContain('/admin');
  const body = await page.content();
  // No admin chrome and no admin data: the operator lands on their own surface.
  expect(page.url()).toContain('/scan');
  expect(body).not.toContain('Concerts');
  expect(body).not.toContain('Registrations');
  expect(body).not.toContain('Settings');
  expect(res?.status()).toBeLessThan(400);
  await page.screenshot({ path: `${SHOTS}/FLOW-7-step-1-operator-refused-admin.png`, fullPage: true });
});

test('FLOW-4: operator sees only assigned shows', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await loginOperator(page, 'Wei Ling');
  await expect(page.getByRole('heading', { name: 'Choose a show' })).toBeVisible();
  await expect(page.getByText('Evening Show')).toBeVisible();
  await expect(page.getByText('Matinee Show')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-4-step-3-assigned-shows.png`, fullPage: true });
  await ctx.close();
});

test('FLOW-5: an operator with no assignments gets an empty state, not an error', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await loginOperator(page, 'No Shows');
  await expect(page.getByText('No shows assigned yet')).toBeVisible();
  await expect(page.getByText('Evening Show')).toHaveCount(0);
  const body = await page.content();
  expect(body).not.toMatch(/Application error|403|Forbidden/);
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-2-empty-show-list.png`, fullPage: true });
  await ctx.close();
});

test('FLOW-6: an operator cannot open an unassigned show by typing its id', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await loginOperator(page, 'Wei Ling');
  const [{ id: unassigned }] = await sql`select id from shows where name = 'Matinee Show'`;
  const res = await page.goto(`/scan/${unassigned}`);
  expect(res?.status()).toBe(404);
  const body = await page.content();
  expect(body).not.toContain('Matinee Show');
  expect(body).not.toContain('Admitting');
  await page.screenshot({ path: `${SHOTS}/FLOW-6-step-2-unassigned-refused.png`, fullPage: true });

  // the assigned one still works, so the 404 is the check and not a broken route
  const [{ id: assigned }] = await sql`select id from shows where name = 'Evening Show'`;
  const ok = await page.goto(`/scan/${assigned}`);
  expect(ok?.status()).toBe(200);
  await expect(page.getByText('Evening Show')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-6-step-3-assigned-allowed.png`, fullPage: true });
  await ctx.close();
});

test('FLOW-6b: hostile show ids are refused, not crashed', async ({ page }) => {
  await loginOperator(page, 'Wei Ling');
  for (const id of ['999999', '1 OR 1=1', "1'; drop table shows;--", '../../admin/concerts', '1e999']) {
    const res = await page.goto(`/scan/${encodeURIComponent(id)}`);
    expect.soft(res?.status(), `/scan/${id}`).toBe(404);
  }
  const [{ c }] = await sql`select count(*)::int as c from shows`;
  expect(c).toBe(2);
});

test('FLOW-8: an admin may use the scanner', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await loginAdmin(page);
  const res = await page.goto('/scan');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Choose a show' })).toBeVisible();
  // ADMIN ignores operator_show_assignments and sees every show
  await expect(page.getByText('Evening Show')).toBeVisible();
  await expect(page.getByText('Matinee Show')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-8-step-1-admin-in-scanner.png`, fullPage: true });
  await ctx.close();
});

test('FLOW-14: a deactivated operator is turned away at the next request', async ({ page }) => {
  await loginOperator(page, 'Wei Ling');
  await expect(page.getByRole('heading', { name: 'Choose a show' })).toBeVisible();
  await sql`update app_users set is_active = false where email = 'wei-ling@operators.invalid'`;
  try {
    await page.goto('/scan');
    expect(page.url()).toContain('/scan/login');
    const body = await page.content();
    expect(body).not.toContain('Evening Show');
    await page.screenshot({ path: `${SHOTS}/FLOW-14-deactivated-operator.png`, fullPage: true });
  } finally {
    await sql`update app_users set is_active = true where email = 'wei-ling@operators.invalid'`;
  }
});

test('FLOW-12: sign out ends the session; ?next= survives but cannot leave the origin', async ({ page }) => {
  await loginAdmin(page, '/admin/settings');
  expect(page.url()).toContain('/admin/settings');
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-0-next-honoured.png`, fullPage: true });

  await page.goto('/admin/concerts');
  await page.getByRole('button', { name: /Sign out/i }).click().catch(() => {});
  // the sidebar sign-out is a form action; wait for the login page
  await page.waitForURL(/\/login/, { timeout: 15000 });
  const res = await page.goto('/admin/concerts');
  expect(page.url()).toContain('/login');
  expect(res?.status()).toBeLessThan(400);
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-2-signed-out.png`, fullPage: true });
});

test('AC-17b: /api/export/xlsx refuses an operator', async ({ page }) => {
  await loginOperator(page, 'Wei Ling');
  const res = await page.request.post('/api/export/xlsx', {
    data: { filename: 'x', headers: ['a'], rows: [['b']], timeZone: 'Asia/Singapore' },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: 'Admins only' });
});

test('AC-25/AC-32: hostile input to the export route is a structured error, never a 500', async ({ page }) => {
  await loginAdmin(page);
  const cases: [string, unknown, number][] = [
    ['missing everything', {}, 400],
    ['wrong types', { filename: 1, headers: 'a', rows: 'b', timeZone: 5 }, 400],
    ['unknown timezone', { filename: 'x', headers: ['a'], rows: [['b']], timeZone: 'Mars/Olympus' }, 400],
    ['path traversal in filename', { filename: '../../etc/passwd', headers: ['a'], rows: [['b']], timeZone: 'UTC' }, 200],
    ['very long string', { filename: 'x'.repeat(500), headers: ['a'], rows: [['b']], timeZone: 'UTC' }, 400],
  ];
  for (const [label, body, expected] of cases) {
    const res = await page.request.post('/api/export/xlsx', { data: body as object });
    expect.soft(res.status(), label).toBe(expected);
    if (res.status() >= 500) console.log(label, await res.text());
  }
  // the traversal case must not produce a filename that escapes a directory
  const ok = await page.request.post('/api/export/xlsx', {
    data: { filename: '../../etc/passwd', headers: ['a'], rows: [['b']], timeZone: 'UTC' },
  });
  const disposition = ok.headers()['content-disposition'];
  expect(disposition).not.toContain('..');
  expect(disposition).not.toContain('/');
});
