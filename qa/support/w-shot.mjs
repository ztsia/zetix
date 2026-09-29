// usage: node shot.mjs <who> <outdir> <path> [<path> ...]  (paths may be name=path)
import { chromium } from '@playwright/test';
const [who, out, ...paths] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: 'http://localhost:3100', viewport: { width: 1440, height: 1000 }, colorScheme: process.env.SCHEME ?? 'light' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text().slice(0, 300)}`); });
await page.goto('/login');
await page.locator('input[name="email"]').fill(who === 'admin' ? 'committee@example.test' : 'mei@example.test');
await page.locator('input[name="password"]').fill(who === 'admin' ? 'qa-admin-pass' : 'qa-viewer-pass');
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
if (process.env.INIT) await page.evaluate(process.env.INIT);
for (const entry of paths) {
  const [name, path] = entry.includes('=') ? entry.split('=') : [entry.replace(/\W+/g, '_'), entry];
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: process.env.FULL !== '0' });
  console.log(name, page.url());
}
console.log(errs.join('\n'));
await b.close();
