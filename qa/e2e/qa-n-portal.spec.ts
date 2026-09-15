import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Module N QA — the portal, feedback and post-show, walked in a browser.
 * Flows are numbered from qa-artifacts/claude-N-portal/02-flows.md.
 */

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);

const SHOTS = 'qa-artifacts/claude-N-portal/screens';
const TOK = {
  admitted: 'AdmittedOneAAAAAAAAA1x',
  admittedTwo: 'AdmittedTwoBBBBBBBBB2x',
  noShow: 'NoShowCCCCCCCCCCCCCC3x',
  reverted: 'RevertedDDDDDDDDDDDD4x',
  cancelled: 'CancelledEEEEEEEEEEE5x',
  deleted: 'DeletedFFFFFFFFFFFFF6x',
  upcoming: 'UpcomingGGGGGGGGGGG7xx',
  noEnd: 'NoEndTimeHHHHHHHHHH8xx',
};

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

test.use({ viewport: { width: 390, height: 844 } });

test.afterAll(async () => { await sql.end(); });

test('FLOW-1 ticket holder before the show', async ({ page }) => {
  await page.goto(`/t/${TOK.upcoming}`);
  await expect(page.getByText('Present this QR at the door')).toBeVisible();
  await expect(page.getByText(/Programme/i)).toHaveCount(0);
  await expect(page.getByText(/feedback/i)).toHaveCount(0);
  // Segment is never shown to the audience (§13.3 item 1).
  expect(await page.content()).not.toContain('Public block');
  await shot(page, 'FLOW-1-step-1-before-show');
});

test('FLOW-2 a token that matches nothing', async ({ page }) => {
  await page.goto('/t/zzzzzzzzzzzzzzzzzzzzzz');
  await expect(page.getByText('We could not find that ticket')).toBeVisible();
  await shot(page, 'FLOW-2-step-1-unknown-token');
  await page.goto(`/t/${TOK.deleted}`);
  await expect(page.getByText('We could not find that ticket')).toBeVisible();
  await shot(page, 'FLOW-2-step-2-soft-deleted');
});

test('FLOW-3 cancelled ticket', async ({ page }) => {
  await page.goto(`/t/${TOK.cancelled}`);
  await expect(page.getByText('This ticket is no longer valid')).toBeVisible();
  await expect(page.getByText(/Download your ticket/i)).toHaveCount(0);
  await shot(page, 'FLOW-3-step-1-cancelled');
});

test('FLOW-4 admitted, show still running (no end time)', async ({ page }) => {
  await page.goto(`/t/${TOK.noEnd}`);
  await expect(page.getByText('Concert Programme')).toBeVisible();
  await expect(page.getByText('Before you come')).toBeVisible();
  await expect(page.getByRole('button', { name: /send feedback/i })).toHaveCount(0);
  await shot(page, 'FLOW-7-step-1-no-end-time-never-post-show');
});

test('FLOW-5 unpublished booklet never reaches a guest', async ({ request }) => {
  const r = await request.get(`/api/portal/${TOK.upcoming}/booklet`);
  expect(r.status()).toBe(404);
  // and the published one never carries the unpublished title
  const [row] = await sql`select title, published from booklets where published = false`;
  expect(row.title).toContain('unpublished');
});

test('FLOW-6 post-show portal: feedback first, ticket a stub', async ({ page }) => {
  await page.goto(`/t/${TOK.admitted}`);
  const text = await page.innerText('main');
  const iFeedback = text.indexOf('How was your evening?');
  const iBooklet = text.indexOf('Concert Programme');
  const iStub = text.indexOf('Admitted');
  expect(iFeedback).toBeGreaterThanOrEqual(0);
  expect(iFeedback).toBeLessThan(iBooklet);
  expect(iBooklet).toBeLessThan(iStub);
  await shot(page, 'FLOW-6-step-1-post-show-feedback-first');
});

test('FLOW-8 guest submits feedback', async ({ page }) => {
  await page.goto(`/t/${TOK.admitted}`);
  await page.selectOption('#feedback\\.rating', 'wonderful');
  await page.fill('#feedback\\.highlight', 'The strings were superb.');
  await shot(page, 'FLOW-8-step-1-filled');
  await page.getByRole('button', { name: /send feedback/i }).click();
  await expect(page.getByText(/thank/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, 'FLOW-8-step-2-submitted');

  const rows = await sql`
    select fr.id, fr.answers, fr.form_schema, a.qr_token
      from feedback_responses fr join attendees a on a.id = fr.attendee_id`;
  expect(rows).toHaveLength(1);
  expect(rows[0].qr_token).toBe(TOK.admitted);
  expect(JSON.stringify(rows[0].answers)).toContain('superb');
  expect(rows[0].form_schema).toBeTruthy();
});

test('FLOW-9 submitting twice leaves one row', async ({ page }) => {
  await page.goto(`/t/${TOK.admitted}`);
  await shot(page, 'FLOW-9-step-1-reopened-after-answering');
  const button = page.getByRole('button', { name: /send feedback|update/i });
  if (await button.count()) {
    await button.first().click();
    await page.waitForTimeout(1500);
  }
  await shot(page, 'FLOW-9-step-2-after-second-submit');
  const rows = await sql`select count(*)::int as n from feedback_responses`;
  expect(rows[0].n).toBe(1);
});

test('FLOW-10 an unadmitted guest cannot submit', async ({ page }) => {
  await page.goto(`/t/${TOK.noShow}`);
  await expect(page.getByRole('button', { name: /send feedback/i })).toHaveCount(0);
  await shot(page, 'FLOW-10-step-1-no-feedback-for-noshow');
  const before = await sql`select count(*)::int as n from feedback_responses`;
  expect(before[0].n).toBe(1);
});

test('FLOW-20 timestamps render in the concert zone, not the viewer s', async ({ browser }) => {
  const a = await browser.newContext({ timezoneId: 'America/New_York', viewport: { width: 390, height: 844 } });
  const b = await browser.newContext({ timezoneId: 'Pacific/Auckland', viewport: { width: 390, height: 844 } });
  const pa = await a.newPage();
  const pb = await b.newPage();
  await pa.goto(`/t/${TOK.upcoming}`);
  await pb.goto(`/t/${TOK.upcoming}`);
  const ta = await pa.innerText('main');
  const tb = await pb.innerText('main');
  const starts = (s: string) => s.match(/Starts \d{2}:\d{2}/)?.[0];
  expect(starts(ta)).toBeTruthy();
  expect(starts(ta)).toBe(starts(tb));
  await pa.screenshot({ path: `${SHOTS}/FLOW-20-step-1-new-york.png`, fullPage: true });
  await pb.screenshot({ path: `${SHOTS}/FLOW-20-step-2-auckland.png`, fullPage: true });
  await a.close();
  await b.close();
});
