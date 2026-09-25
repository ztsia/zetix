import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { DB, SHOTS, signIn } from './rs-helpers';

/**
 * AC-24: an admin demoted to VIEWER while the record is open presses a
 * command. The server refuses; what does the page say? Also AC-7 for the
 * client-navigation RSC payload (list -> record), which the HTML sweep cannot see.
 */
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
test.use({ viewport: { width: 1280, height: 800 } });

test('FLOW-11 stale admin page after demotion shows the read-only message', async ({ page }) => {
  const sql = postgres(DB, { max: 1 });
  try {
    await signIn(page, 'committee@example.test', 'qa-admin-pass');
    await page.goto('/admin/concerts/1/audience/7');
    await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/FLOW-11-step-1-admin-page-open.png`, fullPage: true });
    await sql`update app_users set role = 'VIEWER' where id = ${ADMIN_ID}`;
    const [before] = await sql`select count(*)::int as n from command_runs`;
    await page.getByRole('button', { name: 'Release' }).click();
    await page.waitForTimeout(20000);
    const text = await page.locator('body').innerText();
    await page.screenshot({ path: `${SHOTS}/FLOW-11-step-2-refused.png`, fullPage: true });
    const [after] = await sql`select count(*)::int as n from command_runs`;
    console.log(JSON.stringify({ readOnly: /read-only/i.test(text), stack: /\.ts:\d+|at [a-zA-Z]+ \(/.test(text), snippet: text.slice(0, 1200), before: before.n, after: after.n }));
    expect(after.n).toBe(before.n);
    expect(text).toMatch(/read-only/i);
  } finally {
    await sql`update app_users set role = 'ADMIN' where id = ${ADMIN_ID}`;
    await sql.end();
  }
});

test('FLOW-4b client navigation RSC payload list -> record carries no secret', async ({ page }) => {
  const sql = postgres(DB, { max: 1 });
  const tokens = (await sql`select qr_token as v from attendees where qr_token is not null`).map((r) => r.v as string);
  await sql.end();
  const bodies: string[] = [];
  page.on('response', async (res) => {
    if ((res.headers()['content-type'] ?? '').includes('text/x-component')) {
      try { bodies.push(await res.text()); } catch {}
    }
  });
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  await page.goto('/admin/concerts/1/audience');
  await page.locator('table tbody').getByText('Daniel Wong').first().click();
  await expect(page).toHaveURL(/audience\/6$/);
  await page.getByRole('link', { name: 'Audience' }).first().click();
  await page.locator('table tbody').getByText('Alice Tan').first().click();
  await expect(page).toHaveURL(/audience\/5$/);
  await page.waitForTimeout(1500);
  const all = bodies.join('\n');
  const found = {
    rscResponses: bodies.length,
    fullEmails: [...new Set(all.match(/[A-Za-z0-9._%+-]+@example\.test/g) ?? [])],
    qrTokens: tokens.filter((t) => all.includes(t)),
    creds: [...new Set(all.match(/(edit\?r=|verify\?t=|\?k=)[A-Za-z0-9_-]+/g) ?? [])],
    phones: [...new Set(all.match(/\+6[05] [0-9 -]{7,}/g) ?? [])],
  };
  console.log(JSON.stringify(found));
  await page.screenshot({ path: `${SHOTS}/FLOW-4b-step-1-client-nav-record.png`, fullPage: true });
  expect(found.rscResponses).toBeGreaterThan(0);
  expect(found.fullEmails).toEqual([]);
  expect(found.qrTokens).toEqual([]);
});

test('AC-17 unknown / contact-shaped URL keys do not filter for a viewer', async ({ page }) => {
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  const out: Record<string, number> = {};
  for (const qs of ['', 'email=alice', 'phone=9123', 'contact_email=alice%40example.test', 'contactEmail=alice', 'search=alice%40example.test', 'q=alice%40example.test&view=sent', 'sort=contactEmail.asc', 'player=1', 'source=FORM']) {
    const res = await page.request.get(`/admin/concerts/1/audience?${qs}`);
    const html = await res.text();
    out[qs || '(none)'] = new Set(html.match(/\/admin\/concerts\/1\/audience\/\d+/g) ?? []).size;
  }
  console.log(JSON.stringify(out));
  expect(out['email=alice']).toBe(out['(none)']);
  expect(out['phone=9123']).toBe(out['(none)']);
  expect(out['contact_email=alice%40example.test']).toBe(out['(none)']);
  expect(out['contactEmail=alice']).toBe(out['(none)']);
  expect(out['q=alice%40example.test&view=sent']).toBe(0);
});

test('AC-11 ticket PDF route refuses a viewer, serves an admin', async ({ page, browser }) => {
  await signIn(page, 'mei@example.test', 'qa-viewer-pass');
  const v = await page.request.get('/api/tickets/12/pdf?download=1');
  const vb = await v.body();
  const adminPage = await browser.newPage();
  await signIn(adminPage, 'committee@example.test', 'qa-admin-pass');
  const a = await adminPage.request.get('/api/tickets/12/pdf?download=1');
  const ab = await a.body();
  console.log(JSON.stringify({ viewer: [v.status(), v.headers()['content-type'], vb.subarray(0, 40).toString()], admin: [a.status(), a.headers()['content-type'], ab.subarray(0, 5).toString()] }));
  expect(v.status()).not.toBe(200);
  expect(vb.subarray(0, 4).toString()).not.toBe('%PDF');
  expect(ab.subarray(0, 4).toString()).toBe('%PDF');
});

test('AC-32 retired screens redirect to their view, for admin and viewer', async ({ browser }) => {
  const out: Record<string, unknown> = {};
  for (const [who, email, pw] of [['viewer', 'mei@example.test', 'qa-viewer-pass'], ['admin', 'committee@example.test', 'qa-admin-pass']]) {
    const p = await browser.newPage();
    await signIn(p, email, pw);
    for (const path of ['registrations', 'registrations/unverified', 'extras-review', 'tickets']) {
      await p.goto(`/admin/concerts/1/${path}`);
      out[`${who} ${path}`] = new URL(p.url()).pathname + new URL(p.url()).search;
    }
    await p.close();
  }
  console.log(JSON.stringify(out));
  expect(out['viewer registrations/unverified']).toContain('view=unverified');
  expect(out['viewer extras-review']).toContain('view=needs-review');
  expect(out['viewer tickets']).toContain('grain=seats');
  expect(out['admin tickets']).toContain('grain=seats');
});

test('AC-30 admin preview of Approve on an approved party skips it with a reason', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const cap = JSON.parse(readFileSync('qa-artifacts/claude-S-audience-workspace-rs/captured-actions.json', 'utf8'));
  const preview = Object.values(cap as Record<string, { id: string; url: string; body: string }>).find((c) => c.body.startsWith('["audience.approve"') && !c.body.includes('confirmPhrase'))!;
  await signIn(page, 'committee@example.test', 'qa-admin-pass');
  await page.goto('/admin/concerts/1/audience/5');
  const r = await page.evaluate(async ({ url, id }) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Next-Action': id, 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'text/x-component' }, body: JSON.stringify(['audience.approve', { concertId: 1, selection: { ids: [5] }, params: { includeFlagged: true } }]) });
    return { status: res.status, body: await res.text() };
  }, preview);
  console.log(JSON.stringify(r).slice(0, 1500));
  expect(r.status).toBe(200);
  expect(r.body).toMatch(/"runnable":0/);
});
