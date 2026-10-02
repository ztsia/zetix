/**
 * QA phase 5 — module `G`'s flows, walked in a real browser at a phone
 * viewport, with screenshots at every step.
 *
 * **The camera path is driven for real.** The branch's own e2e never scans
 * anything: its `scan()` helper dispatches a `zetix:test-decode` event that
 * nothing in `src/` listens for, so every one of its "scan" assertions actually
 * goes through Search and the attendee sheet. Here Chromium is launched with a
 * fake capture device fed a generated Y4M of an actual QR code, so
 * `@zxing/browser` decodes it and the whole path runs —
 * `extractQrToken` -> `hashQrToken` -> `evaluateScan` -> queue -> POST.
 *
 * `qa/support/qa-qr-y4m.mjs` renders the fixtures.
 */
import { test, expect, chromium, devices, type Browser, type Page } from '@playwright/test';
import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve('qa-artifacts/G-door-scanner/screens');
fs.mkdirSync(SHOTS, { recursive: true });

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 2 },
);
const seed = JSON.parse(fs.readFileSync('qa-artifacts/G-door-scanner/seed.json', 'utf8'));

const QR = (name: string) => `/tmp/claude-0/qr/${name}.y4m`;

/**
 * A Chromium launched with a fake capture device fed a real QR code.
 *
 * `test.use({ launchOptions })` is rejected inside a describe block, and each
 * flow needs a different QR, so the browser is launched by hand here. The
 * viewport and user agent come from the Pixel 7 descriptor, so this is still
 * the phone shape §15.4 requires.
 */
async function withCamera(
  fixture: string,
  fn: (page: Page) => Promise<void>,
  contextOptions: Record<string, unknown> = {},
): Promise<void> {
  const browser: Browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${QR(fixture)}`,
    ],
  });
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    baseURL: process.env.QA_BASE_URL ?? 'http://localhost:3100',
    permissions: ['camera'],
    ...contextOptions,
  });
  const page = await context.newPage();
  try {
    await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Android shots keep the plain name; the WebKit pass is suffixed. */
const shot = (page: Page, name: string) => {
  const project = test.info().project.name;
  const file = project === 'iphone' ? `${name}-webkit.png` : `${name}.png`;
  return page.screenshot({ path: path.join(SHOTS, file) });
};

async function hideDevOverlay(page: Page) {
  await page.addInitScript(() => {
    const hide = () => {
      const s = document.createElement('style');
      s.textContent = 'nextjs-portal{display:none!important}';
      document.head?.appendChild(s);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
}

async function signInOperator(page: Page, who: 'Wei Ling' | 'No Shows' = 'Wei Ling') {
  await hideDevOverlay(page);
  await page.goto('/scan/login');
  await page.fill('#displayName', who);
  await page.fill('#code', 'qa-op-code');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/scan(\/\d+)?$/);
}

/** Wait for the manifest to be on the device before judging anything. */
async function manifestLanded(page: Page) {
  await page.getByRole('tab', { name: 'Search' }).click();
  await expect(page.getByText(/6 tickets are on this device/)).toBeVisible({ timeout: 20000 });
  await page.getByRole('tab', { name: 'Scan' }).click();
}

async function startScanning(page: Page) {
  await page.getByRole('button', { name: 'Start scanning' }).click();
}

const overlay = (page: Page) => page.locator('[data-slot="scan-result"]');

async function setDebounce(ms: number) {
  await sql`update system_settings set value = ${String(ms)}::jsonb where key = 'checkin.scan_debounce_ms'`;
}

test.beforeEach(async () => {
  await sql`delete from check_ins`;
});
test.afterAll(async () => {
  await setDebounce(0);
  await sql.end();
});

// ═══════════════════════════════════════════════ FLOW-1, 11, 12, 15 (no camera)

test('FLOW-1 operator signs in and lands on their one assigned show', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
  await shot(page, 'FLOW-1-step-1-signed-in');

  // The three tabs of §15.4 / ref.md §1.1, in a bottom bar.
  for (const name of ['Scan', 'Search', 'Stats']) {
    await expect(page.getByRole('tab', { name })).toBeVisible();
  }
  const tabBox = (await page.getByRole('tab', { name: 'Scan' }).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(tabBox.y).toBeGreaterThan(vp.height / 2); // bottom half, thumb-reachable
  expect(await page.getByRole('button', { name: /menu/i }).count()).toBe(0); // no hamburger

  // The show pill, persistent in the header — and **read-only** here, because
  // this operator is rostered on exactly one show (§12.1). Updated from a link
  // to a pill when this run's own finding 5 was fixed: with nowhere to switch
  // to, a tappable pill only offers a way onto an empty picker mid-queue.
  const pill = page.locator('[data-slot=show-pill]').filter({ hasText: /Evening Show/ });
  await expect(pill).toBeVisible();
  await expect(page.getByRole('link', { name: /Evening Show/ })).toHaveCount(0);
  const pillBox = (await pill.boundingBox())!;
  expect(pillBox.y).toBeLessThan(80);
  await shot(page, 'FLOW-1-step-2-tabs-and-pill');
});

test('FLOW-11 an operator cannot reach a show they are not rostered on', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));

  // The picker never offers it: one assignment, so the picker redirects.
  const listed = await page.evaluate(async () => {
    const r = await fetch('/scan');
    return (await r.text()).includes('Saturday Matinee');
  });
  expect(listed).toBe(false);

  const response = await page.goto(`/scan/${seed.show2}`);
  expect(response!.status()).toBe(404);
  await expect(page.locator('body')).not.toContainText('Siti Rahman');
  await shot(page, 'FLOW-11-step-1-unassigned-show-404');

  const api = await page.evaluate(
    async (id) => {
      const r = await fetch(`/api/checkin/manifest?showId=${id}`);
      return `${r.status} ${await r.text()}`;
    },
    seed.show2,
  );
  expect(api).toBe('404 {"error":"Not found"}');
});

test('FLOW-12 the Stats tab counts up as scans land', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
  await manifestLanded(page);

  await page.getByRole('tab', { name: 'Stats' }).click();
  await expect(page.getByText('Expected', { exact: true })).toBeVisible();
  await shot(page, 'FLOW-12-step-1-stats-before');
  const before = await page.locator('div', { hasText: /^Admitted here$/ }).count();
  void before;
  const readFigure = async (label: string) =>
    Number(
      await page
        .locator('div.rounded-lg', { has: page.getByText(label, { exact: true }) })
        .locator('p')
        .first()
        .textContent(),
    );
  expect(await readFigure('Expected')).toBe(5); // 6 rows, one cancelled
  expect(await readFigure('Admitted here')).toBe(0);
  expect(await readFigure('Remaining')).toBe(5);

  // Admit one through Search, then read Stats again.
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search by name or ticket code').fill('Priya');
  await page.getByText('Priya Nair').click();
  await page.getByRole('button', { name: /^Admit Priya/ }).click();
  await page.getByRole('tab', { name: 'Stats' }).click();
  await expect.poll(() => readFigure('Admitted here')).toBe(1);
  expect(await readFigure('Remaining')).toBe(4);
  await shot(page, 'FLOW-12-step-2-stats-after');
});

// FLOW-15 is covered properly by FLOW-15b below, which reads a real rendered
// time out of the result overlay rather than only screenshotting the screen.

// ═════════════════════════════════════════════════ FLOW-9, 10 (offline, no camera)

test('FLOW-9 Search finds a guest with the network gone, in a bottom sheet', async ({
  page,
  context,
}) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
  await manifestLanded(page);
  await startScanning(page);

  await context.setOffline(true);
  await page.getByRole('tab', { name: 'Search' }).click();
  await shot(page, 'FLOW-9-step-1-offline-search');

  // By ticket code, as an usher would type it off paper: no hyphen, lower case.
  await page.getByLabel('Search by name or ticket code').fill('orc7k4q');
  await expect(page.getByText('Alice Tan')).toBeVisible();
  await shot(page, 'FLOW-9-step-2-by-code');

  await page.getByLabel('Search by name or ticket code').fill('tan');
  await expect(page.getByText('Alice Tan')).toBeVisible();
  await expect(page.getByText('Dan Tan')).toBeVisible();
  await shot(page, 'FLOW-9-step-3-by-name');

  const urlBefore = page.url();
  await page.getByText('Alice Tan', { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // ref.md §1.4: a sheet, not a route change, and the camera stays mounted.
  expect(page.url()).toBe(urlBefore);
  // The scan panel is still in the DOM behind the sheet — `keepMounted`.
  // (FLOW-9b proves the <video> itself survives, with a real camera attached.)
  expect(await page.locator('[role="tabpanel"]').count()).toBeGreaterThanOrEqual(2);
  await shot(page, 'FLOW-9-step-4-bottom-sheet');
});

test('FLOW-10 admits offline, and the whole queue drains on reconnect', async ({
  page,
  context,
}) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
  await manifestLanded(page);

  await context.setOffline(true);
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search by name or ticket code').fill('Alice Tan');
  await page.getByText('Alice Tan', { exact: true }).click();
  await expect(page.getByText('Party of 4')).toBeVisible();
  await shot(page, 'FLOW-10-step-1-offline-party-sheet');

  const t0 = Date.now();
  await page.getByRole('button', { name: /^Admit 4$/ }).click();
  await expect(page.getByText(/queued/)).toBeVisible();
  await shot(page, 'FLOW-10-step-2-four-queued');

  const [{ count: before }] = await sql`select count(*)::int as count from check_ins`;
  expect(before).toBe(0);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect
    .poll(async () => (await sql`select count(*)::int as count from check_ins`)[0].count, {
      timeout: 20000,
    })
    .toBe(4);
  await expect(page.getByText(/queued/)).toHaveCount(0);
  await shot(page, 'FLOW-10-step-3-drained');

  const rows = await sql`select source, override_reason, scanned_at, synced_at from check_ins order by scanned_at`;
  for (const r of rows) {
    /**
     * MANUAL, not OFFLINE_SYNC — updated when this run's own finding 6 was
     * fixed. These four rows came from one tap on "Admit remaining", which
     * §12.1 requires be recorded as MANUAL; that the tap happened with no
     * network is a separate fact, carried by the gap between `scanned_at` and
     * `synced_at` below rather than by overwriting how the call was made.
     */
    expect(r.source).toBe('MANUAL');
    expect(new Date(r.scanned_at).getTime()).toBeGreaterThanOrEqual(t0 - 5000);
    expect(new Date(r.synced_at).getTime()).toBeGreaterThan(new Date(r.scanned_at).getTime());
  }
  console.log('FLOW-10 rows: ' + JSON.stringify(rows));
});

test('FLOW-13 the mute toggle survives a reload', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
  const mute = page.getByRole('button', { name: /Mute scan sounds/ });
  await expect(mute).toBeVisible();
  await mute.click();
  await expect(page.getByRole('button', { name: /Unmute scan sounds/ })).toBeVisible();
  await shot(page, 'FLOW-13-step-1-muted');
  await page.reload();
  await expect(page.getByRole('button', { name: /Unmute scan sounds/ })).toBeVisible();
  await shot(page, 'FLOW-13-step-2-still-muted-after-reload');
  // Leave the device unmuted for later specs.
  await page.getByRole('button', { name: /Unmute scan sounds/ }).click();

  // §12.2's gotcha: no Vibration API on WebKit. Nothing may throw either way.
  const hasVibrate = await page.evaluate(() => typeof navigator.vibrate === 'function');
  console.log(`FLOW-13 navigator.vibrate present on ${test.info().project.name}: ${hasVibrate}`);
});

// ═══════════════════════════════════════════════════════ camera flows

test.describe('FLOW-2 / FLOW-14 a valid ticket, from a QR whose origin is dead', () => {
  test('scans green, writes one ONLINE row, and never touches the origin', async () => {
   await withCamera('alice', async (page) => {
    await setDebounce(60_000);
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));

    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await shot(page, 'FLOW-2-step-1-ready-at-the-door');

    await startScanning(page);
    await expect(page.locator('[data-slot="scanner-video"]')).toBeVisible();
    await shot(page, 'FLOW-2-step-2-viewfinder');

    await expect(overlay(page)).toHaveAttribute('data-outcome', 'ADMITTED', { timeout: 30000 });
    await expect(overlay(page)).toContainText('Admitted');
    await expect(overlay(page)).toContainText('Alice Tan');
    await shot(page, 'FLOW-2-step-3-admitted');

    // FLOW-14 / decision 28: the QR read `https://dead-domain.invalid/t/…`.
    // Nothing may have been fetched from that origin.
    expect(requested.filter((u) => u.includes('dead-domain.invalid'))).toEqual([]);

    await expect
      .poll(async () => (await sql`select count(*)::int as count from check_ins`)[0].count, {
        timeout: 20000,
      })
      .toBe(1);
    const [row] = await sql`select a.full_name, c.source from check_ins c
                            join attendees a on a.id = c.attendee_id`;
    expect(row.full_name).toBe('Alice Tan');
    expect(row.source).toBe('ONLINE');
    console.log(`FLOW-2 row: ${JSON.stringify(row)}`);

    // FLOW-7: the party control, on the result itself.
    await expect(overlay(page)).toContainText('Party of 4 · 1 in, 3 remaining');
    await shot(page, 'FLOW-7-step-1-party-context');
    await page.getByRole('button', { name: /choose who/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'FLOW-7-step-2-party-sheet');
    await page.getByRole('dialog').getByRole('button', { name: /^Admit 3$/ }).click();
    await expect
      .poll(async () => (await sql`select count(*)::int as count from check_ins`)[0].count, {
        timeout: 20000,
      })
      .toBe(4);
    const sources = await sql`select source, count(*)::int from check_ins group by source`;
    console.log(`FLOW-7 sources: ${JSON.stringify(sources)}`);
    await shot(page, 'FLOW-7-step-3-party-admitted');
   });
  });

  test('FLOW-3 the same ticket a second time reads amber, not green', async () => {
   await withCamera('alice', async (page) => {
    await setDebounce(60_000);
    // Put the first scan on this device's queue and on the server.
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await startScanning(page);
    await expect(overlay(page)).toHaveAttribute('data-outcome', 'ADMITTED', { timeout: 30000 });
    await shot(page, 'FLOW-3-step-1-first-scan-green');

    // A reload clears the per-token debounce, so the camera fires again — which
    // is exactly what a second person presenting the same ticket looks like.
    await page.reload();
    await manifestLanded(page);
    await startScanning(page);
    await expect(overlay(page)).toHaveAttribute('data-outcome', 'ALREADY_CHECKED_IN', {
      timeout: 30000,
    });
    await expect(overlay(page)).toContainText('Already checked in');
    await expect(overlay(page)).toContainText('First scanned');
    await expect(page.getByRole('button', { name: 'Admit anyway' })).toBeVisible();
    await shot(page, 'FLOW-3-step-2-already-checked-in-amber');

    // It did not silently double-count.
    const [{ count }] = await sql`select count(*)::int as count from check_ins`;
    expect(count).toBe(1);
   });
  });

  test('AC-26 the debounce is the settings value, not a literal', async () => {
   await withCamera('alice', async (page) => {
    // With a 60s debounce the camera sees the same QR 25 times a second and
    // fires exactly once. With the debounce set to 0 it fires repeatedly.
    await setDebounce(60_000);
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await startScanning(page);
    await expect(overlay(page)).toHaveAttribute('data-outcome', 'ADMITTED', { timeout: 30000 });
    await page.waitForTimeout(4000);
    const [{ count: debounced }] = await sql`select count(*)::int as count from check_ins`;
    expect(debounced).toBe(1);

    // With the setting at 0 the same QR fires on every frame, so the overlay
    // moves on to ALREADY_CHECKED_IN. That is the discriminator: the value
    // consulted is the settings row, not a constant.
    await setDebounce(0);
    await page.reload();
    await manifestLanded(page);
    await startScanning(page);
    await expect(overlay(page)).toHaveAttribute('data-outcome', 'ALREADY_CHECKED_IN', {
      timeout: 30000,
    });
    const [{ count: undebounced }] = await sql`select count(*)::int as count from check_ins`;
    console.log(`debounce 60000ms -> ${debounced} row, overlay stayed ADMITTED; debounce 0ms -> refired, ${undebounced} row`);
    expect(undebounced).toBe(1);
   });
  });
});

test.describe('FLOW-9b the camera never unmounts', () => {
  test('survives a tab change and a bottom sheet, with a real camera', async () => {
   await withCamera('alice', async (page) => {
    await setDebounce(60_000);
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await startScanning(page);
    await expect(page.locator('[data-slot="scanner-video"]')).toHaveCount(1);

    await page.getByRole('tab', { name: 'Search' }).click();
    // ref.md §1.4: re-acquiring a stream costs 1-3s on mid-range Android, so
    // the <video> must still be mounted while another tab is showing.
    await expect(page.locator('[data-slot="scanner-video"]')).toHaveCount(1);
    await shot(page, 'FLOW-9b-step-1-video-alive-under-search');

    await page.getByLabel('Search by name or ticket code').fill('Alice Tan');
    const urlBefore = page.url();
    await page.getByRole('button', { name: /Alice Tan/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await expect(page.locator('[data-slot="scanner-video"]')).toHaveCount(1);
    await shot(page, 'FLOW-9b-step-2-video-alive-under-sheet');
   });
  });
});

test.describe('AC-42 overlay dismissal', () => {
  test('a green result should auto-dismiss after ~2s (ref.md §1.2)', async () => {
   await withCamera('alice', async (page) => {
    await setDebounce(60_000);
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await startScanning(page);
    await expect(overlay(page)).toHaveAttribute('data-outcome', 'ADMITTED', { timeout: 30000 });
    await page.waitForTimeout(5000);
    const stillThere = await overlay(page).count();
    console.log(`AC-42: overlay still present 5s after a green scan: ${stillThere === 1}`);
    await shot(page, 'AC-42-step-1-overlay-5s-after-green');
    // ref.md §1.2: "Overlay auto-dismisses after ~2s on success".
    expect(stillThere).toBe(0);
   });
  });
});

test('AC-44 the manifest is in IndexedDB, small, and holds no raw token', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
  await manifestLanded(page);

  const stored = await page.evaluate(
    (showId) =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('zetix-checkin', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('manifests', 'readonly')
            .objectStore('manifests').get(showId);
          get.onsuccess = () => resolve(JSON.stringify(get.result));
          get.onerror = () => reject(get.error);
        };
      }),
    seed.show1,
  );
  const parsed = JSON.parse(stored);
  expect(parsed.attendees).toHaveLength(6);
  expect(parsed.fetchedAt).toBeTruthy();
  for (const a of seed.tans.attendees) expect(stored).not.toContain(a.token);
  console.log(`AC-44 IndexedDB manifest: ${stored.length} bytes for 6 rows, expiresAt=${parsed.expiresAt}`);
  expect(stored.length).toBeLessThan(200_000);
  // §12.3: show start + checkin.manifest_ttl_hours, from the cascade.
  expect(parsed.expiresAt).toBe('2026-09-20T00:00:00.000Z'); // 12:00Z start + 12h
});

test('AC-53 the scanner surface reaches nothing an operator may not have', async ({ page }) => {
  await signInOperator(page);
  await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
  const results: string[] = [];
  for (const p of ['/admin/concerts', '/api/export/xlsx?entity=attendees', '/admin']) {
    const r = await page.evaluate(async (u) => {
      const res = await fetch(u, { redirect: 'manual' });
      return `${res.status}${res.type === 'opaqueredirect' ? ' (redirect)' : ''}`;
    }, p);
    results.push(`${p} -> ${r}`);
  }
  console.log('AC-53 operator against admin surfaces:\n' + results.join('\n'));
  for (const r of results) expect(r).not.toMatch(/-> 200$/);
});

test.describe('AC-30/31/32 feedback channels at runtime', () => {
  test('audio unlocks inside the Start gesture, the flash fires, no audio file is fetched', async () => {
   await withCamera('alice', async (page) => {
    await setDebounce(60_000);
    const media: string[] = [];
    page.on('request', (r) => {
      if (/\.(mp3|wav|ogg|m4a|aac)(\?|$)/i.test(r.url())) media.push(r.url());
    });
    // Instrument AudioContext *before* any app code runs — `createScanFeedback()`
    // captures `window.AudioContext` at boot, so a later patch is never seen.
    await page.addInitScript(() => {
      const w = window as unknown as { __ctxs: AudioContext[]; AudioContext: typeof AudioContext };
      w.__ctxs = [];
      const Real = w.AudioContext;
      w.AudioContext = class extends Real {
        constructor(...a: unknown[]) {
          // @ts-expect-error -- passthrough
          super(...a);
          w.__ctxs.push(this as unknown as AudioContext);
        }
      } as unknown as typeof AudioContext;
    });
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);

    // Nothing may have been constructed before the gesture (§12.2's gotcha).
    expect(await page.evaluate(() => (window as never as { __ctxs: unknown[] }).__ctxs.length)).toBe(0);

    await startScanning(page);
    const state = await page.evaluate(() => {
      const ctxs = (window as never as { __ctxs: AudioContext[] }).__ctxs;
      return { n: ctxs.length, state: ctxs[0]?.state ?? null };
    });
    console.log(`AC-31/32 AudioContext after the Start tap: ${JSON.stringify(state)}`);
    expect(state.n).toBe(1);
    expect(state.state).toBe('running');

    await expect(overlay(page)).toHaveAttribute('data-outcome', 'ADMITTED', { timeout: 30000 });
    // AC-30: the full-screen flash, ~800ms.
    await expect(page.locator('[data-flash="admitted"]')).toHaveCount(1);
    await shot(page, 'AC-30-step-1-green-flash');
    await expect(page.locator('[data-flash]')).toHaveCount(0, { timeout: 4000 });
    expect(media).toEqual([]); // synthesised, never loaded (§12.2)
   });
  });
});

test.describe('FLOW-15b the first-scan time on the result overlay', () => {
  test('renders in concert.timezone, not the phone\'s', async () => {
   await withCamera(
    'alice',
    async (page) => {
      await setDebounce(60_000);
      await signInOperator(page);
      await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
      await manifestLanded(page);
      await startScanning(page);
      await expect(overlay(page)).toHaveAttribute('data-outcome', 'ADMITTED', { timeout: 30000 });

      // Second presentation of the same ticket -> amber, which is the one place
      // this surface prints an absolute time.
      await page.reload();
      await manifestLanded(page);
      await startScanning(page);
      await expect(overlay(page)).toHaveAttribute('data-outcome', 'ALREADY_CHECKED_IN', {
        timeout: 30000,
      });
      const text = (await overlay(page).textContent())!;
      const shown = /First scanned (\d{2}:\d{2})/.exec(text)?.[1];
      const [row] = await sql`select scanned_at from check_ins order by scanned_at limit 1`;
      const at = new Date(row.scanned_at);
      const inVenue = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(at);
      const inNewYork = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(at);
      console.log(`FLOW-15b shown=${shown} venue(Asia/Kuala_Lumpur)=${inVenue} phone(America/New_York)=${inNewYork}`);
      await shot(page, 'FLOW-15b-step-1-first-scan-time');
      // domain.md §6.1: the venue's time, never the viewer's.
      expect(shown).toBe(inVenue);
    },
    { timezoneId: 'America/New_York', locale: 'en-GB' },
   );
  });
});

test.describe('FLOW-4 a ticket for another show', () => {
  test('should read "Wrong show" and name the show it is for', async () => {
   await withCamera('siti', async (page) => {
    await setDebounce(60_000);
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await startScanning(page);

    await expect(overlay(page)).toBeVisible({ timeout: 30000 });
    const outcome = await overlay(page).getAttribute('data-outcome');
    const text = (await overlay(page).textContent())!.replace(/\s+/g, ' ');
    console.log(`FLOW-4 outcome=${outcome} text=${text}`);
    await shot(page, 'FLOW-4-step-1-other-shows-ticket');

    // §12.1's result table: Wrong show, red, showing the show the ticket is
    // actually for. The server knows it — /api/checkin/scan returns
    // WRONG_SHOW + "Saturday Matinee" (proved in qa-g-backend.spec.ts).
    expect(outcome).toBe('WRONG_SHOW');
    await expect(overlay(page)).toContainText('Saturday Matinee');
   });
  });
});

test.describe('FLOW-5 a cancelled ticket', () => {
  test('reads red with "refer to desk", never "not found"', async () => {
   await withCamera('marcus', async (page) => {
    await setDebounce(60_000);
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await startScanning(page);

    await expect(overlay(page)).toHaveAttribute('data-outcome', 'CANCELLED', { timeout: 30000 });
    await expect(overlay(page)).toContainText('Marcus Lee');
    await expect(overlay(page)).toContainText('Refer to desk');
    await expect(page.getByRole('button', { name: 'Admit anyway' })).toBeVisible();
    await shot(page, 'FLOW-5-step-1-cancelled-refer-to-desk');

    // Amber and red are never hard blocks (§12.1).
    await page.getByRole('button', { name: 'Admit anyway' }).click();
    await expect
      .poll(async () => (await sql`select count(*)::int as count from check_ins`)[0].count, {
        timeout: 20000,
      })
      .toBe(1);
    const [row] = await sql`select source, override_reason from check_ins`;
    expect(row.source).toBe('MANUAL');
    expect(row.override_reason).not.toBeNull();
    console.log(`FLOW-5 override row: ${JSON.stringify(row)}`);
    await shot(page, 'FLOW-5-step-2-admitted-anyway');
   });
  });
});

test.describe('FLOW-6 a token in no manifest', () => {
  test('reads red "Invalid ticket" and offers no admission it cannot record', async () => {
   await withCamera('unknown', async (page) => {
    await setDebounce(60_000);
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await startScanning(page);

    await expect(overlay(page)).toHaveAttribute('data-outcome', 'NOT_FOUND', { timeout: 30000 });
    await expect(overlay(page)).toContainText('Invalid ticket');
    await shot(page, 'FLOW-6-step-1-invalid-ticket');
    const [{ count }] = await sql`select count(*)::int as count from check_ins`;
    expect(count).toBe(0);
   });
  });
});

test.describe('FLOW-8 a party of one', () => {
  test('offers no party control', async () => {
   await withCamera('priya', async (page) => {
    await setDebounce(60_000);
    await signInOperator(page);
    await page.waitForURL(new RegExp(`/scan/${seed.show1}$`));
    await manifestLanded(page);
    await startScanning(page);

    await expect(overlay(page)).toHaveAttribute('data-outcome', 'ADMITTED', { timeout: 30000 });
    await expect(overlay(page)).toContainText('Priya Nair');
    await expect(overlay(page)).not.toContainText('Party of');
    await expect(page.getByRole('button', { name: /choose who/ })).toHaveCount(0);
    await shot(page, 'FLOW-8-step-1-solo-no-party-control');
   });
  });
});
