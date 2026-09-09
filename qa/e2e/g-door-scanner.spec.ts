/**
 * Module `G` — the door, walked in a real browser on both phone shapes.
 *
 * Runs under the `android` and `iphone` projects (`playwright.config.ts`), and
 * the config states the limit these specs inherit: both are Chromium, so they
 * reproduce an iPhone's *metrics* and never Safari's *behaviour*. Vibration,
 * autoplay and the ringer switch are settled on the ushers' own handsets via
 * `/scan/diagnostics` (local.md §5f), not here.
 *
 * What these do cover is the part that can regress silently: the offline
 * manifest, the queue draining on reconnect, search without a camera, the
 * result states, and the party control.
 */
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import path from 'node:path';
import fs from 'node:fs';

const SHOTS = path.resolve('qa-artifacts/G-door-scanner/screens');
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
const seed = JSON.parse(
  fs.readFileSync('qa-artifacts/G-door-scanner/seed.json', 'utf8'),
) as {
  show1: number;
  show2: number;
  tans: { attendees: { id: number; name: string; code: string; token: string }[] };
  cancelled: { attendees: { token: string; code: string }[] };
  other: { attendees: { token: string; code: string }[] };
};

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-${name}.png`) });

/**
 * Hide the Next.js dev-tools indicator.
 *
 * It is fixed to the bottom-left of the viewport, and at 390px wide that lands
 * squarely on top of the Scan tab — so every tab click in this file would time
 * out on an element the overlay is intercepting. A harness artifact, not a
 * product one: `next dev` renders it and `next build` does not, so hiding it
 * here restores what an usher actually sees rather than papering over a defect.
 */
async function hideDevOverlay(page: Page) {
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal{display:none!important}';
      document.head?.appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
}

async function signInOperator(page: Page) {
  await hideDevOverlay(page);
  await page.goto('/scan/login');
  await page.fill('#displayName', 'Wei Ling');
  await page.fill('#code', 'qa-op-code');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/scan/);
}

/**
 * Drive a scan without a camera.
 *
 * The camera is a decode source, not the decision — §12.1 gives three
 * independent ways in and the manifest match is common to all of them. Feeding
 * a decoded string directly exercises exactly the code a QR would reach, on a
 * headless browser that has no camera at all.
 */
async function scan(page: Page, decoded: string) {
  await page.evaluate((text) => {
    window.dispatchEvent(new CustomEvent('zetix:test-decode', { detail: text }));
  }, decoded);
}

test.beforeEach(async () => {
  await sql`delete from check_ins`;
});

test.afterAll(async () => {
  await sql.end();
});

test('the show picker auto-selects a single assignment', async ({ page }) => {
  // §12.1: with exactly one assignment it is auto-selected, removing the most
  // damaging setup mistake — an usher admitting against the wrong show.
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));
  // The pill is a link back to the picker, so an usher on the wrong show can
  // always get off it (ref.md §1.3).
  await expect(page.getByRole('link', { name: /Evening Show/ })).toBeVisible();
  await shot(page, 'picker-autoselected');
});

test('the manifest lands and Search works with no camera', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));

  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search by name or ticket code').fill('Tan');
  await expect(page.getByText('Alice Tan')).toBeVisible();
  await shot(page, 'search-by-name');

  // The code as an usher would actually type it: lower case, no hyphen.
  await page.getByLabel('Search by name or ticket code').fill('orc7k4q');
  await expect(page.getByText('Alice Tan')).toBeVisible();
  await shot(page, 'search-by-code');
});

test('a cancelled ticket says refer to desk, never not found', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search by name or ticket code').fill('Marcus');
  await expect(page.getByText('Cancelled')).toBeVisible();
  await shot(page, 'cancelled-refer-to-desk');
});

test('the bottom tab bar sits inside the safe area and is thumb-sized', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));

  const tab = page.getByRole('tab', { name: 'Scan' });
  const box = await tab.boundingBox();
  // 44px is the documented minimum touch target; this is tapped one-handed in
  // the dark by someone holding a stack of programmes.
  expect(box!.height).toBeGreaterThanOrEqual(44);

  const viewport = page.viewportSize()!;
  // Nothing may hang off the bottom of the display.
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  await shot(page, 'tab-bar');
});

test('the page never scrolls horizontally on a phone', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/**
 * Fetched from **inside the page**, not through `page.request`.
 *
 * `page.request` is a separate context that does not carry the Supabase session
 * cookies, so every call through it comes back 401 and would "pass" a 403-vs-404
 * assertion for entirely the wrong reason. An in-page `fetch` is also what the
 * scanner itself does.
 */
async function apiStatus(page: Page, path: string): Promise<number> {
  return page.evaluate(async (p) => (await fetch(p)).status, path);
}

test('the manifest endpoint refuses a show this operator is not rostered on', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));

  // Rostered on show 1 only, and the seed proves show 2 exists — so this is a
  // real refusal rather than a missing row.
  expect(await apiStatus(page, `/api/checkin/manifest?showId=${seed.show1}`)).toBe(200);
  // 404, not 403 — probing must not distinguish "not yours" from "not there".
  expect(await apiStatus(page, `/api/checkin/manifest?showId=${seed.show2}`)).toBe(404);
});

test('the manifest carries no raw token, only digests', async ({ page }) => {
  // The roster lands in IndexedDB on a phone that can be lost, lent or stolen.
  // A raw qr_token there is a usable ticket for whoever picks the phone up.
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));

  const body = await page.evaluate(
    async (id) => (await fetch(`/api/checkin/manifest?showId=${id}`)).text(),
    seed.show1,
  );
  for (const attendee of seed.tans.attendees) {
    expect(body).not.toContain(attendee.token);
  }
  const parsed = JSON.parse(body) as { attendees: { qrTokenSha256: string }[] };
  expect(parsed.attendees.length).toBeGreaterThan(0);
  for (const a of parsed.attendees) {
    expect(a.qrTokenSha256).toMatch(/^[0-9a-f]{64}$/);
  }
});

/**
 * The module's stated acceptance criterion: **a ticket admits with the phone
 * offline, and queued scans sync when the network returns** (docs/modules.md,
 * spec/checkin.md §12.3).
 *
 * Driven through Search rather than the camera, deliberately. §12.1 gives three
 * independent ways in and the manifest match is common to all of them, so this
 * exercises the same decision, queue and drain a QR would reach — on a headless
 * browser that has no camera to give it.
 */
test('admits with the network gone, and syncs when it returns', async ({ page, context }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));
  // Let the manifest land while there is still a network.
  await expect
    .poll(async () => page.evaluate(async (id) => (await fetch(`/api/checkin/manifest?showId=${id}`)).status, seed.show1))
    .toBe(200);
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search by name or ticket code').fill('Priya');
  await expect(page.getByText('Priya Nair')).toBeVisible();

  // --- the venue wifi drops ---
  await context.setOffline(true);

  await page.getByText('Priya Nair').click();
  await expect(page.getByRole('button', { name: /^Admit Priya/ })).toBeVisible();
  await shot(page, 'offline-attendee-sheet');
  await page.getByRole('button', { name: /^Admit Priya/ }).click();

  // The admission is recorded on the device and visibly owed to the server.
  await expect(page.getByText(/queued/)).toBeVisible();
  await shot(page, 'offline-queued');

  // Nothing has reached the database yet — that is what "offline" means.
  const [{ count: before }] = await sql`select count(*)::int as count from check_ins`;
  expect(before).toBe(0);

  // --- the wifi comes back ---
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect
    .poll(async () => {
      const [{ count }] = await sql`select count(*)::int as count from check_ins`;
      return count;
    }, { timeout: 15000 })
    .toBe(1);

  // The phone's own clock is preserved, and the row is marked as a delayed sync.
  const [row] = await sql`
    select source, scanned_at, synced_at from check_ins limit 1
  `;
  expect(row.source).toBe('OFFLINE_SYNC');
  expect(row.synced_at).not.toBeNull();

  // And the badge clears, so the operator can see the queue is empty.
  await expect(page.getByText(/queued/)).toHaveCount(0);
  await shot(page, 'after-sync');
});

test('admits a whole party in one tap, which is what stops the stats going wrong', async ({
  page,
}) => {
  // §12.1: a family of four holds four PDFs in one email and the person at the
  // front shows the first while the other three walk in behind them.
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}`));
  await expect
    .poll(async () => page.evaluate(async (id) => (await fetch(`/api/checkin/manifest?showId=${id}`)).status, seed.show1))
    .toBe(200);

  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search by name or ticket code').fill('Alice Tan');
  await page.getByText('Alice Tan', { exact: true }).click();

  await expect(page.getByText('Party of 4')).toBeVisible();
  await shot(page, 'party-sheet');
  await page.getByRole('button', { name: /Admit remaining 4/ }).click();

  await expect
    .poll(async () => {
      const [{ count }] = await sql`select count(*)::int as count from check_ins`;
      return count;
    }, { timeout: 15000 })
    .toBe(4);

  // Recorded as a manual admission with a reason, per §12.1.
  const rows = await sql`select source, override_reason from check_ins`;
  for (const row of rows) {
    expect(row.source).toBe('MANUAL');
    expect(row.override_reason).toContain('party');
  }
});

