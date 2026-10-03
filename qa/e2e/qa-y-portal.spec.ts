import { test, expect, devices, type Page } from '@playwright/test';
import { sql, SHOTS } from './qa-y-helpers';

/**
 * QA, module Y — phase 5, the portal (spec/v3.md §32.3) on a phone, dark mode,
 * browser timezone deliberately not the concert's (Asia/Kuala_Lumpur).
 * Show 4 starts 2026-11-20 12:00Z (20:00 KL), doors 11:00Z (19:00 KL).
 */
test.use({ ...devices['Pixel 7'], colorScheme: 'dark', timezoneId: 'America/Los_Angeles' });

const LIM = 'QaLimTok0000000000001A';
const WAIT = 'QaWaitTok000000000001W';
const MINT = 'QaMintTok000000000001M';
const CANCEL = 'QaCnclTok000000000001C';

const shot = (page: Page, flow: string, step: number, what: string) =>
  page.screenshot({ path: `${SHOTS}/${flow}-step-${step}-${what}.png`, fullPage: true });

test.beforeAll(async () => {
  await sql`delete from check_ins c using attendees a where a.id = c.attendee_id and a.full_name like 'Qa %'`;
  await sql`insert into system_settings (key, value) values ('portal.enabled', 'true'::jsonb)
            on conflict (key) do update set value = excluded.value`;
  await sql`update concerts set practical_info_md = 'Parking is behind the hall. Latecomers wait for the interval.' where id = 3`;
});
test.afterAll(async () => {
  await sql`update shows set starts_at = '2026-11-20 12:00:00+00', doors_open_at = '2026-11-20 11:00:00+00' where id = 4`;
  await sql`delete from system_settings where key = 'portal.enabled'`;
  await sql`update concerts set practical_info_md = null where id = 3`;
});


test('FLOW-13 issued seat: facts first, QR named, party of N without names, Before you come, download, dark, concert timezone', async ({ page }) => {
  await page.goto(`/t/${LIM}`);
  await shot(page, 'FLOW-13', 1, 'issued-dark');

  const text = await page.locator('main').innerText();
  // date, doors and venue first — above every section
  const whenAt = text.indexOf('Doors 19:00');
  const venueAt = text.indexOf('Dewan Filharmonik');
  const ticketAt = text.indexOf('Qa Lim Ah');
  const practicalAt = text.indexOf('Before you come');
  test.info().annotations.push({ type: 'order', description: JSON.stringify({ whenAt, venueAt, ticketAt, practicalAt }) });
  expect(whenAt).toBeGreaterThanOrEqual(0);
  expect(text).toContain('Starts 20:00');
  expect(venueAt).toBeGreaterThan(-1);
  expect(whenAt).toBeLessThan(ticketAt);
  expect(venueAt).toBeLessThan(ticketAt);
  // practical info shows before admission
  expect(practicalAt).toBeGreaterThan(-1);
  await expect(page.getByText('Parking is behind the hall.')).toBeVisible();

  // QR has an accessible name
  await expect(page.getByRole('img', { name: /QR code for ticket QL01AAAA/ })).toBeVisible();
  // section titles are headings
  const headings = await page.getByRole('heading').allInnerTexts();
  test.info().annotations.push({ type: 'headings', description: headings.join(' | ') });
  expect(headings).toEqual(expect.arrayContaining(['Before you come']));

  // party: one of 4, nobody else named, one code admits the whole party
  await expect(page.getByText(/one of 4 seats/)).toBeVisible();
  await expect(page.getByText(/whole party/)).toBeVisible();
  for (const other of ['Qa Lim Bee', 'Qa Lim Chen', 'Qa Lim Dina', 'qalim@example.test']) expect(text).not.toContain(other);

  // download: present, tall enough, really a PDF
  const dl = page.getByRole('link', { name: /Download your ticket/ });
  await expect(dl).toBeVisible();
  const box = await dl.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const res = await page.request.get((await dl.getAttribute('href'))!);
  expect(res.headers()['content-type']).toContain('application/pdf');

  // dark mode follows the device
  const theme = await page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), fg: getComputedStyle(document.body).color, bg: getComputedStyle(document.body).backgroundColor }));
  test.info().annotations.push({ type: 'dark-theme', description: JSON.stringify(theme) });
  expect(theme.dark).toBe(true);
  // and the QR keeps its light plate
  const qrBg = await page.getByRole('img', { name: /QR code/ }).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(qrBg).toMatch(/255, 255, 255|oklch\(1 /);
});

test('FLOW-13b same page in light mode is light', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:3100/t/${LIM}`);
  const theme = await page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), fg: getComputedStyle(document.body).color }));
  await shot(page, 'FLOW-13b', 1, 'issued-light');
  await ctx.close();
  expect(theme.dark).toBe(false);
});

test('FLOW-14 waitlisted seat: no QR, on hold, no download, no practical info', async ({ page }) => {
  await page.goto(`/t/${WAIT}`);
  await shot(page, 'FLOW-14', 1, 'on-hold');
  await expect(page.getByText('Your seat is on hold')).toBeVisible();
  await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0);
  await expect(page.getByText('Present this QR')).toHaveCount(0);
  await expect(page.getByText('Doors are open')).toHaveCount(0);
  await expect(page.getByText('Before you come')).toHaveCount(0);
});

test('FLOW-15 download route for a seat on hold answers a page, not JSON', async ({ page }) => {
  const res = await page.goto(`/api/portal/${WAIT}/ticket?download=1`);
  await shot(page, 'FLOW-15', 1, 'download-unavailable');
  expect(res!.status()).toBe(404);
  expect(res!.headers()['content-type']).toContain('text/html');
  await expect(page.getByRole('heading', { name: /isn.t available to download/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to your ticket page' })).toHaveAttribute('href', `/t/${WAIT}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  test.info().annotations.push({ type: 'unavailable-bg', description: bg });
});

test('FLOW-16 unknown token: one not-found page, promises nothing about the PDF', async ({ page }) => {
  await page.goto('/t/ZZZZZZZZZZZZZZZZZZZZZZ');
  await shot(page, 'FLOW-16', 1, 'not-found');
  const a = await page.locator('main').innerText();
  await page.goto('/t/short');
  const b = await page.locator('main').innerText();
  expect(a).toBe(b);
  expect(a).toContain('We could not find that ticket');
  expect(a).not.toMatch(/PDF|still (be )?valid|still admit/i);
});

test('FLOW-23 token minted but not issued: QR shown, no download, says the PDF is on its way', async ({ page }) => {
  await page.goto(`/t/${MINT}`);
  await shot(page, 'FLOW-23', 1, 'minted-not-issued');
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0);
  await expect(page.getByText(/on its way by email/)).toBeVisible();
});

test('FLOW-25 cancelled seat: no longer valid, no QR, no download', async ({ page }) => {
  await page.goto(`/t/${CANCEL}`);
  await shot(page, 'FLOW-25', 1, 'cancelled');
  await expect(page.getByText('This ticket is no longer valid')).toBeVisible();
  await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0);
});

test('FLOW-24 the show day has passed with no ends_at: no QR, no "Doors are open", says when it was', async ({ page }) => {
  // KL-local yesterday; ends_at stays null
  await sql`update shows set starts_at = now() - interval '2 days', doors_open_at = now() - interval '2 days 1 hour' where id = 4`;
  await page.goto(`/t/${LIM}`);
  await shot(page, 'FLOW-24', 1, 'show-day-passed');
  await expect(page.getByText('Doors are open')).toHaveCount(0);
  await expect(page.getByText('Present this QR')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
  await expect(page.getByText(/This show took place on/)).toBeVisible();

  // and on the day itself, doors open: "Doors are open" and the QR are still offered
  await sql`update shows set starts_at = now() + interval '30 minutes', doors_open_at = now() - interval '5 minutes' where id = 4`;
  await page.goto(`/t/${LIM}`);
  await shot(page, 'FLOW-24', 2, 'doors-open-today');
  await expect(page.getByText('Doors are open')).toBeVisible();
  await expect(page.getByRole('img', { name: /QR/ })).toBeVisible();
});
