// usage: node qa/support/x-scanner.mjs <outdir>  — the door scanner on a phone, as usher Aisyah
import { chromium, devices } from '@playwright/test';
const [out] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['Pixel 7'], baseURL: 'http://localhost:3100' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on('response', (r) => { if (r.status() >= 500) errs.push(`[${r.status()}] ${r.url()}`); });
await page.goto('/scan/login');
await page.locator('input[name="displayName"]').fill('aisyah');
await page.locator('input[name="code"]').fill('demo-usher-code');
await page.screenshot({ path: `${out}/scan-login.png` });
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 60000 }), page.locator('button[type="submit"]').click()]);
await page.waitForLoadState('networkidle');
await page.screenshot({ path: `${out}/scan-home.png` });
console.log('after login', page.url());
await page.goto('/scan/' + (process.env.SHOW ?? '1'), { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/scan-show.png` });
for (const tab of ['Search', 'Stats']) {
  const t = page.getByRole('tab', { name: new RegExp(tab, 'i') }).or(page.getByRole('button', { name: new RegExp(`^${tab}`, 'i') })).first();
  if (await t.count()) { await t.click(); await page.waitForTimeout(800); await page.screenshot({ path: `${out}/scan-${tab}.png` }); }
  else console.log('no tab', tab);
}
console.log(errs.join('\n') || 'no errors');
await b.close();
