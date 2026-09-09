import { test, expect } from '@playwright/test';
import { asAdmin, asOperator, EMAIL_URL, IDS, newSql, shot } from './f-helpers';

/**
 * QA phase 4/5 — the authorization matrix for module `F`, filled in by actually
 * making each call rather than by reading the guards.
 *
 * The email screens carry every registrant's name and address, and the
 * dispatch route sends real mail. `admin.md` §14.3: an operator may not edit
 * data, export, or view PII beyond name and ticket status.
 */
const sql = newSql();

test.afterAll(async () => {
  await sql.end();
});

test('FLOW-14 anonymous cannot reach the email screens or the dispatcher', async ({ page, request }) => {
  await page.goto(EMAIL_URL());
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('Admin code')).toBeVisible();
  await shot(page, 'FLOW-14-step-1-anonymous-redirected-to-login');

  const dispatch = await request.post('/api/outbox/dispatch');
  expect(dispatch.status()).toBe(401);
  expect(await dispatch.json()).toEqual({ error: 'unauthorized' });

  const delivery = await request.get(`/admin/concerts/${IDS.concertId}/email/delivery`);
  // A redirect to /login, never the roster.
  expect(await delivery.text()).not.toContain('alice@example.test');
});

test('FLOW-15 a signed-in operator is refused before any registrant data', async ({ browser }) => {
  const ctx = await asOperator(browser, 'Wei Ling');
  const page = await ctx.newPage();

  await page.goto(EMAIL_URL());
  const body = await page.content();
  expect(body).not.toContain('alice@example.test');
  expect(body).not.toContain('chandra@example.test');
  await expect(page).not.toHaveURL(new RegExp(`/admin/concerts/${IDS.concertId}/email$`));
  await shot(page, 'FLOW-15-step-1-operator-refused');

  const dispatch = await ctx.request.post('/api/outbox/dispatch');
  expect(dispatch.status()).toBe(401);

  const delivery = await ctx.request.get(`/admin/concerts/${IDS.concertId}/email/delivery`);
  expect(await delivery.text()).not.toContain('alice@example.test');

  await ctx.close();
});

test('the admin is the only role that gets through', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(EMAIL_URL());
  await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
  await shot(page, 'FLOW-14-step-2-admin-allowed');

  const dispatch = await ctx.request.post('/api/outbox/dispatch');
  expect(dispatch.status()).toBe(200);
  await ctx.close();
});

test('hostile input to the email screen is refused without a stack trace', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  for (const bad of [
    `?segment=0&template=public_ticket`,
    `?segment=-1&template=public_ticket`,
    `?segment=999999&template=public_ticket`,
    `?segment=1'%20or%201=1--&template=public_ticket`,
    `?segment=1&template=${'x'.repeat(5000)}`,
    `?segment=1&template=../../../etc/passwd`,
  ]) {
    const response = await ctx.request.get(`/admin/concerts/${IDS.concertId}/email${bad}`);
    const text = await response.text();
    expect(
      { input: bad, status: response.status(), stack: /at [A-Za-z]+ \(.*\.ts:/.test(text) },
      `input ${bad}`,
    ).toEqual({ input: bad, status: response.status(), stack: false });
    expect(response.status(), `input ${bad}`).toBeLessThan(500);
  }

  const bogusConcert = await ctx.request.get('/admin/concerts/999999/email');
  expect(bogusConcert.status()).toBe(404);

  await page.close();
  await ctx.close();
});
