import { test, expect, type BrowserContext } from '@playwright/test';
import { asAdmin, asOperator, reseed, shot, sql } from './b-helpers';

/**
 * FLOW-13 — anonymous and OPERATOR against module B's two screens and the
 * Server Actions behind them. AC-60.
 */
test.describe.configure({ mode: 'serial' });

let ids: Record<string, string>;
test.beforeAll(() => {
  ids = reseed();
});
test.afterAll(async () => {
  await sql.end();
});

test('FLOW-13 authorization matrix', async ({ browser }) => {
  test.setTimeout(180_000);
  const concertId = ids.concertId;

  const actors: [string, BrowserContext][] = [
    ['anonymous', await browser.newContext()],
    ['ADMIN', await asAdmin(browser)],
    ['OPERATOR assigned', await asOperator(browser, 'Wei Ling')],
  ];

  const targets: [string, string][] = [
    ['GET registrations', `/admin/concerts/${concertId}/registrations`],
    ['GET extras-review', `/admin/concerts/${concertId}/extras-review`],
  ];

  const table: Record<string, Record<string, string>> = {};
  for (const [label, path] of targets) {
    table[label] = {};
    for (const [actor, ctx] of actors) {
      const page = await ctx.newPage();
      const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
      const landed = new URL(page.url()).pathname;
      const body = await page.locator('body').innerText();
      const leaked = /Alice Tan|Daniel Wong|Extras review|Registrations/.test(body) && landed === path;
      table[label][actor] = `${res?.status()} -> ${landed}${leaked ? ' [DATA]' : ''}`;
      if (actor !== 'ADMIN') {
        await shot(page, `FLOW-13-step-${label.includes('extras') ? 2 : 1}-${actor.replace(/ /g, '-')}`);
      }
      await page.close();
    }
  }
  console.log(JSON.stringify(table, null, 2));

  for (const label of Object.keys(table)) {
    expect(table[label]['anonymous'], `${label} anonymous`).toContain('/login');
    expect(table[label]['anonymous'], `${label} anonymous`).not.toContain('[DATA]');
    expect(table[label]['OPERATOR assigned'], `${label} operator`).toContain('/scan');
    expect(table[label]['OPERATOR assigned'], `${label} operator`).not.toContain('[DATA]');
    expect(table[label]['ADMIN'], `${label} admin`).toContain('[DATA]');
  }
});

/**
 * A page redirect is not the boundary — the Server Action is. Replay the exact
 * POST an authenticated admin makes, from an anonymous context, and assert the
 * database is untouched.
 */
test('FLOW-13 step 3 — Server Action replayed without a session', async ({ browser }) => {
  test.setTimeout(120_000);
  const concertId = ids.concertId;

  const admin = await asAdmin(browser);
  const page = await admin.newPage();
  await page.goto(`/admin/concerts/${concertId}/registrations`);

  // Capture the real create POST an admin makes: URL, action id and body.
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.headers()['next-action']) {
      captured = { url: req.url(), headers: req.headers(), body: req.postData() ?? '' };
    }
  });

  await page.getByRole('button', { name: 'New registration' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('select[name="segmentId"]').selectOption({ index: 1 });
  await dialog.locator('input[name="contactName"]').fill('Authz Probe');
  await dialog.getByRole('button', { name: 'Create registration' }).click();
  await expect(page.locator('div[role="status"], div[role="alert"]').first()).toBeVisible({ timeout: 15_000 });
  await shot(page, 'FLOW-13-step-3-admin-create-succeeds');
  expect(captured, 'a Server Action POST was captured').not.toBeNull();

  const [before] = await sql<{ n: number }[]>`
    select count(*)::int as n from registrations where contact_name = 'Authz Probe'`;
  expect(before.n, 'the admin call really did create a row').toBe(1);

  const anon = await browser.newContext();
  const res = await anon.request.post(captured!.url, {
    headers: {
      'next-action': captured!.headers['next-action'],
      'content-type': captured!.headers['content-type'] ?? 'text/plain;charset=UTF-8',
    },
    data: captured!.body,
  });
  const text = await res.text();
  console.log('anonymous create replay ->', res.status(), JSON.stringify(text.slice(0, 400)));

  const [after] = await sql<{ n: number }[]>`
    select count(*)::int as n from registrations where contact_name = 'Authz Probe'`;
  expect(after.n, 'the anonymous replay created nothing').toBe(1);
  expect(text).not.toContain('seat confirmed');
});
