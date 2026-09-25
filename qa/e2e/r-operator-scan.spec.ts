import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

/** Module R re-verification — the scan route's new viewer refusal leaves an assigned OPERATOR's scan working. */
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

test('assigned operator still records a real scan', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.205' });
  await page.goto('/scan/login');
  await page.locator('input[name="displayName"]').fill('Wei Ling');
  await page.locator('input[name="code"]').fill('qa-op-code');
  await Promise.all([page.waitForURL(/\/scan(\/\d+)?$/), page.locator('button[type="submit"]').click()]);
  const [seat] = await sql`select id, qr_token, show_id from attendees where qr_token = 'QRSECRET00000000000001'`;
  const before = (await sql`select count(*)::int as n from check_ins where attendee_id = ${seat.id}`)[0].n;
  const res = await page.request.post('/api/checkin/scan', {
    data: { showId: Number(seat.show_id), scans: [{ qrTokenSha256: createHash('sha256').update(seat.qr_token).digest('hex'), scannedAt: new Date().toISOString(), source: 'ONLINE', deviceId: 'qa-op' }] },
  });
  const body = await res.text();
  const after = (await sql`select count(*)::int as n from check_ins where attendee_id = ${seat.id}`)[0].n;
  console.log('operator scan', res.status(), body.slice(0, 200), 'check_ins', before, after);
  expect(res.status()).toBe(200);
  expect(after).toBe(before + 1);
});
