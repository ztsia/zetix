/**
 * QA pass 2 — hostile input at the one Route Handler F2 ships, and the
 * throttle's live behaviour through the real Server Action.
 */
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

async function signInAdmin(page: Page) {
  await sql`delete from auth_failures`;
  await page.goto('/login');
  await page.fill('#code', 'correct-admin-code');
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin/**', { timeout: 20000 });
}

const OK = { filename: 'registrations', headers: ['A'], rows: [['x']], timeZone: 'Asia/Singapore' };

test('export handler: every input class, valid through hostile', async ({ page }) => {
  await signInAdmin(page);
  const cases: [string, unknown, number][] = [
    ['valid', OK, 200],
    ['missing filename', { ...OK, filename: undefined }, 400],
    ['missing headers', { ...OK, headers: undefined }, 400],
    ['missing timeZone', { ...OK, timeZone: undefined }, 400],
    ['wrong type: headers a string', { ...OK, headers: 'A' }, 400],
    ['wrong type: rows an object', { ...OK, rows: { a: 1 } }, 400],
    ['out of range: empty headers', { ...OK, headers: [] }, 400],
    ['out of range: 201 headers', { ...OK, headers: Array(201).fill('h') }, 400],
    ['out of range: filename 500 chars', { ...OK, filename: 'a'.repeat(500) }, 400],
    ['hostile: 1MB filename', { ...OK, filename: 'a'.repeat(1_000_000) }, 400],
    ['hostile: SQL metacharacters', { ...OK, filename: "reg'; drop table app_users;--" }, 200],
    ['hostile: path traversal in filename', { ...OK, filename: '../../../etc/passwd' }, 200],
    ['hostile: CRLF header injection', { ...OK, filename: 'x"\r\nSet-Cookie: a=b' }, 200],
    ['hostile: unknown timezone', { ...OK, timeZone: 'Mars/Olympus' }, 400],
    ['hostile: timezone traversal', { ...OK, timeZone: '../../etc' }, 400],
    ['hostile: null body', null, 400],
    ['hostile: not json', 'not-json', 400],
    ['hostile: 300k cells', { ...OK, headers: Array(50).fill('h'), rows: Array(6000).fill(Array(50).fill('x')) }, 413],
  ];

  const results: string[] = [];
  for (const [label, body, expected] of cases) {
    const res = await page.request.post('/api/export/xlsx', {
      headers: { 'Content-Type': 'application/json' },
      data: body === undefined ? {} : (body as object),
    });
    const text = res.status() === 200 ? '<binary>' : (await res.text()).slice(0, 120);
    results.push(`${String(res.status()).padEnd(4)} ${label.padEnd(34)} ${text}`);
    expect.soft(res.status(), label).toBe(expected);
    // Never a stack trace, whatever happens.
    expect.soft(text, label).not.toMatch(/at .*\(.*:\d+:\d+\)|node_modules/);
  }
  console.log('\n--- export handler input matrix ---\n' + results.join('\n'));

  // The table is still there after the SQL metacharacter probe.
  expect(Number((await sql`select count(*) from app_users`)[0].count)).toBeGreaterThan(0);

  // Content-Disposition cannot be poisoned by the filename.
  const res = await page.request.post('/api/export/xlsx', {
    data: { ...OK, filename: 'x"\r\nSet-Cookie: pwn=1' },
  });
  const cd = res.headers()['content-disposition'];
  console.log('Content-Disposition:', JSON.stringify(cd));
  expect(cd).not.toContain('Set-Cookie');
  expect(cd).toMatch(/^attachment; filename="[a-z0-9-]+\.xlsx"$/);
});

test('AC-10 a correct code clears the throttle bucket', async ({ page }) => {
  await sql`delete from auth_failures`;
  const max = Number((await sql`select value from system_settings where key='auth.admin_max_attempts'`)[0].value);
  for (let i = 0; i < max - 1; i++) {
    await page.goto('/login');
    await page.fill('#code', 'nope');
    await page.click('button[type=submit]');
    await expect(page.locator('#login-error')).toBeVisible();
  }
  expect(Number((await sql`select count(*) from auth_failures`)[0].count)).toBe(max - 1);

  await page.goto('/login');
  await page.fill('#code', 'correct-admin-code');
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin/**', { timeout: 20000 });
  expect(Number((await sql`select count(*) from auth_failures`)[0].count)).toBe(0);
});

test('AC-11 the throttle refuses the sign-in when its settings are missing', async ({ page }) => {
  await sql`delete from auth_failures`;
  const saved = await sql`select key, value from system_settings where key like 'auth.%'`;
  await sql`delete from system_settings where key like 'auth.%'`;
  try {
    await page.goto('/login');
    await page.fill('#code', 'correct-admin-code');
    await page.click('button[type=submit]');
    const message = await page.locator('#login-error').textContent();
    console.log('unconfigured-throttle message:', message);
    expect(message).toMatch(/throttle is not configured/i);
    expect(new URL(page.url()).pathname).toBe('/login');
    // Fails closed: even the right code does not get in.
    expect((await page.context().cookies()).filter((c) => c.name.startsWith('sb-')).length).toBe(0);
  } finally {
    for (const row of saved) {
      await sql`insert into system_settings (key, value) values (${row.key}, ${JSON.stringify(row.value)}::text::jsonb)`;
    }
  }
});

test('AC-50 hostile ?next= values cannot leave the origin', async ({ page }) => {
  const hostile = [
    'https://evil.example/', '//evil.example/', '/\\evil.example',
    'javascript:alert(1)', '/%09/evil.example', 'http:/evil.example',
  ];
  for (const next of hostile) {
    await sql`delete from auth_failures`;
    await page.context().clearCookies();
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.fill('#code', 'correct-admin-code');
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
    await page.waitForLoadState('domcontentloaded');
    console.log(`next=${next} -> ${page.url()}`);
    expect.soft(new URL(page.url()).origin, next).toBe('http://localhost:3100');
    expect.soft(new URL(page.url()).host, next).not.toContain('evil.example');
  }
});
