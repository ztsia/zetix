import { test, expect, devices, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Module `Y` — the door (spec/v3.md §32.2), against the `start-v.sh` world:
 * Wei Ling is rostered on show 4 ("Autumn Evening"), where the Satos are
 * confirmed with no ticket and Nadia Hassan's party of two is ticketed.
 */
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
const SHOW = 4;

test.use({ ...devices['Pixel 7'] });
test.afterAll(async () => {
  await sql.end();
});
test.beforeEach(async () => {
  await sql`delete from check_ins where show_id = ${SHOW}`;
  await sql`delete from walk_ins where show_id = ${SHOW}`;
  await sql`
    insert into system_settings (key, value) values ('checkin.walk_ins_enabled', 'true'::jsonb)
    on conflict (key) do update set value = excluded.value`;
});

async function signInWei(page: Page) {
  await page.goto('/scan/login');
  await page.locator('input[name="displayName"]').fill('Wei Ling');
  await page.locator('input[name="code"]').fill('qa-op-code');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes('login'));
}

test('a phone holding a v1 roster and queued scans upgrades without losing either', async ({ page }) => {
  await page.goto('/scan/login');
  // Build the database exactly as the v1 build left it: two stores, a roster
  // keyed by digest, and one unsynced scan.
  const [nadia] = await sql<{ hash: string; registration_id: string }[]>`
    select encode(sha256(convert_to(qr_token, 'UTF8')), 'hex') as hash, registration_id
      from attendees where show_id = ${SHOW} and full_name = 'Nadia Hassan'`;
  await page.evaluate(
    ({ show, hash, registrationId }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('zetix-checkin', 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          db.createObjectStore('manifests', { keyPath: 'showId' });
          db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }).createIndex('showId', 'showId');
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['manifests', 'queue'], 'readwrite');
          tx.objectStore('manifests').put({
            showId: show,
            fetchedAt: new Date().toISOString(),
            expiresAt: null,
            attendees: [
              { qrTokenSha256: hash, ticketCode: null, name: 'Nadia Hassan', playerName: null, status: 'CONFIRMED', registrationId: Number(registrationId), partySize: 2 },
            ],
          });
          tx.objectStore('queue').add({
            showId: show,
            qrTokenSha256: hash,
            scannedAt: new Date().toISOString(),
            source: 'OFFLINE_SYNC',
            deviceId: 'old-phone',
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
    { show: SHOW, hash: nadia.hash, registrationId: nadia.registration_id },
  );

  await signInWei(page);
  await page.goto(`/scan/${SHOW}`);
  // The v1 scan, sent by digest, reaches the server.
  await expect
    .poll(async () => (await sql`select count(*)::int as n from check_ins where show_id = ${SHOW}`)[0].n, { timeout: 20000 })
    .toBe(1);
  const stores = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open('zetix-checkin');
        open.onsuccess = () => resolve([...open.result.objectStoreNames]);
      }),
  );
  expect(stores.sort()).toEqual(['manifests', 'queue', 'walkins']);
});

test('a walk-in is recorded, counted in the hall, and shown on the Door screen', async ({ page, browser }) => {
  await signInWei(page);
  await page.goto(`/scan/${SHOW}`);
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Walk-in' }).click();
  await page.getByRole('button', { name: 'One more' }).click();
  await page.getByLabel('Name or note (optional)').fill('Couple, no booking');
  await page.getByRole('button', { name: 'Admit 2 walk-ins' }).click();
  await expect
    .poll(async () => (await sql`select coalesce(sum(headcount), 0)::int as n from walk_ins where show_id = ${SHOW}`)[0].n, { timeout: 20000 })
    .toBe(2);

  await page.getByRole('tab', { name: 'Stats' }).click();
  await expect(page.getByText('In the hall')).toBeVisible();
  await expect(page.getByText(/2 walk-ins/).first()).toBeVisible();
  await expect(page.getByText('Admitted by you')).toBeVisible();

  // The desk sees the same number.
  const desk = await (await browser.newContext()).newPage();
  await desk.goto('/login');
  await desk.locator('input[name="email"]').fill('committee@example.test');
  await desk.locator('input[name="password"]').fill('qa-admin-pass');
  await Promise.all([desk.waitForURL((u) => !u.pathname.startsWith('/login')), desk.locator('button[type="submit"]').click()]);
  const [show] = await sql<{ concert_id: string }[]>`select concert_id from shows where id = ${SHOW}`;
  await desk.goto(`/admin/concerts/${show.concert_id}/checkin?show=${SHOW}`);
  await expect(desk.getByRole('heading', { name: 'Walk-ins' })).toBeVisible();
  await expect(desk.getByText('Couple, no booking')).toBeVisible();
});

test('"Record as walk-in" is offered when nobody matches, carrying what was typed', async ({ page }) => {
  await signInWei(page);
  await page.goto(`/scan/${SHOW}`);
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search by name or ticket code').fill('Zebedee Quux');
  await page.getByRole('button', { name: 'Record as walk-in' }).click();
  await expect(page.getByLabel('Name or note (optional)')).toHaveValue('Zebedee Quux');
});

test('with walk-ins off, the door offers none', async ({ page }) => {
  await sql`update system_settings set value = 'false'::jsonb where key = 'checkin.walk_ins_enabled'`;
  await signInWei(page);
  await page.goto(`/scan/${SHOW}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Walk-in' })).toHaveCount(0);
});
