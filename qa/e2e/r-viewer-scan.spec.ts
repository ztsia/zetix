import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

/** Module R — a VIEWER posting a real scan batch: refused, nothing admitted. */
const sql = postgres(process.env.QA_DATABASE_URL!, { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

test('viewer POST /api/checkin/scan with a real token is refused and admits nobody', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.251' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  const [seat] = await sql`select id, qr_token, show_id from attendees where qr_token is not null order by id limit 1`;
  const before = await sql`select count(*)::int as n from check_ins`;
  const res = await page.request.post('/api/checkin/scan', {
    data: { showId: Number(seat.show_id), scans: [{ qrTokenSha256: createHash('sha256').update(seat.qr_token).digest('hex'), scannedAt: new Date().toISOString(), source: 'ONLINE', deviceId: 'qa-viewer' }] },
  });
  const after = await sql`select count(*)::int as n from check_ins`;
  const rejects = await sql`select action, actor_id from audit_log where actor_id = '33333333-3333-4333-8333-333333333333'::uuid order by id desc limit 3`;
  console.log('status', res.status(), await res.text(), 'check_ins', before[0].n, after[0].n, 'audit rows by viewer', rejects);
  expect(res.status()).toBe(404);
  expect(after[0].n).toBe(before[0].n);
});
