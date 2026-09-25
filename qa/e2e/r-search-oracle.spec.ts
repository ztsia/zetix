import { test, expect, type APIRequestContext } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * Module R — can a VIEWER recover a masked contact detail through a
 * server-side search? (spec/v3.md §28: the viewer must not "see full email
 * addresses and phone numbers").
 *
 * The page masks what it renders, but the responses screen's `?q=` runs an
 * ILIKE over the whole raw payload on the server, and the result set changes
 * with the guess. That is a membership oracle; this spec uses it to rebuild a
 * phone number the viewer is never shown, one character at a time.
 */
const OUT = 'qa-artifacts/claude-R-roles-accounts';
const SHOTS = `${OUT}/screens`;

async function hit(r: APIRequestContext, q: string): Promise<boolean> {
  const res = await r.get(`/admin/concerts/1/forms/1/responses?q=${encodeURIComponent(q)}`);
  expect(res.status()).toBe(200);
  return (await res.text()).includes('Farah Formfill');
}

test('viewer rebuilds a phone number and confirms an email via responses search', async ({ page }) => {
  test.setTimeout(900_000);
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.201' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await expect(page.getByText('Read-only access.')).toBeVisible();
  const r = page.request;

  const log: string[] = [];
  // Email: a yes/no on a full guess.
  const emailYes = await hit(r, 'farah.form@example.test');
  const emailNo = await hit(r, 'farah.forn@example.test');
  log.push(`q=farah.form@example.test -> ${emailYes}; q=farah.forn@example.test -> ${emailNo}`);

  // Phone: extend a guessable prefix one character at a time.
  const alphabet = '0123456789 -';
  let known = '+60 17-'; // eslint-disable-line prefer-const
  let requests = 0;
  for (let i = 0; i < 12; i++) {
    let extended = false;
    for (const ch of alphabet) {
      requests++;
      if (await hit(r, known + ch)) { known += ch; extended = true; break; }
    }
    if (!extended) break;
    // The server trims `q`, so a trailing space always "hits": stop there.
    if (known.endsWith(' ') && known.trimEnd().length < known.length - 1) break;
  }
  known = known.trimEnd();
  log.push(`rebuilt "${known}" in ${requests} requests`);
  writeFileSync(`${OUT}/search-oracle.txt`, log.join('\n') + '\n');
  console.log(log.join('\n'));

  await page.goto(`/admin/concerts/1/forms/1/responses?q=${encodeURIComponent(known)}`);
  await page.screenshot({ path: `${SHOTS}/FLOW-14-step-1-viewer-search-hit.png`, fullPage: true });
  await page.goto(`/admin/concerts/1/forms/1/responses?q=${encodeURIComponent(known.slice(0, -1) + '9')}`);
  await page.screenshot({ path: `${SHOTS}/FLOW-14-step-2-viewer-search-miss.png`, fullPage: true });

  expect(emailYes).toBe(true);
  expect(emailNo).toBe(false);
  // The finding: this should NOT be recoverable by a viewer.
  expect.soft(known, 'viewer rebuilt a phone number the screen never shows').not.toBe('+60 17-313 1313');
});

test('viewer confirms masked addresses through Trash and Activity search', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.202' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  const r = page.request;
  const probe = async (path: string, marker: string) => (await (await r.get(path)).text()).includes(marker);
  const lines = [
    `trash player q=player80@example.test -> ${await probe('/admin/concerts/1/trash?kind=player&q=player80%40example.test', 'Player 80')}`,
    `trash player q=player80@example.tesx -> ${await probe('/admin/concerts/1/trash?kind=player&q=player80%40example.tesx', 'Player 80')}`,
    `activity q=alice-reason@example.test -> ${await probe('/admin/concerts/1/activity?q=alice-reason%40example.test', 'registration.updated')}`,
    `activity q=alice-reason@example.tesx -> ${await probe('/admin/concerts/1/activity?q=alice-reason%40example.tesx', 'registration.updated')}`,
  ];
  console.log(lines.join('\n'));
  writeFileSync(`${OUT}/search-oracle-2.txt`, lines.join('\n') + '\n');
  await page.goto('/admin/concerts/1/trash?kind=player&q=player80%40example.test');
  await page.screenshot({ path: `${SHOTS}/FLOW-14-step-3-trash-search-hit.png`, fullPage: true });
});
