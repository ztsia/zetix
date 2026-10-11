// usage: node qa/support/x-messages.mjs <outdir>  — the Failed and Bounced tabs, and each one's detail
import { chromium } from '@playwright/test';
const [out] = process.argv.slice(2);
const b = await chromium.launch();
const page = await (await b.newContext({ baseURL: 'http://localhost:3100', viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on('response', (r) => { if (r.status() >= 500) errs.push(`[${r.status()}] ${r.url()}`); });
await page.goto('/login');
await page.locator('input[name="email"]').fill('admin@example.org');
await page.locator('input[name="password"]').fill('demo-admin-pass');
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 }), page.locator('button[type="submit"]').click()]);
for (const tab of ['Failed', 'Bounced']) {
  await page.goto('/admin/concerts/1/audience/messages', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/msg-${tab}.png` });
  await page.locator('tbody tr').first().getByRole('button').last().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/msg-${tab}-menu.png` });
  const view = page.getByRole('menuitem', { name: /view|open|detail/i }).first();
  if (await view.count()) { await view.click(); await page.waitForTimeout(800); }
  await page.screenshot({ path: `${out}/msg-${tab}-detail.png` });
}
await page.goto('/admin/concerts/1/inbox', { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: /^Bounced/ }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/inbox-bounced.png` });
console.log(errs.join('\n') || 'no errors');
await b.close();
