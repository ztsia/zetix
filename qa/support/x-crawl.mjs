// usage: node qa/support/x-crawl.mjs <outdir> name=path ...   (signs in as the demo admin)
import { chromium } from '@playwright/test';
const [out, ...paths] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: 'http://localhost:3100', viewport: { width: 1440, height: 900 }, colorScheme: process.env.SCHEME ?? 'light' });
const page = await ctx.newPage();
let errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text().slice(0, 300)}`); });
page.on('response', (r) => { if (r.status() >= 500) errs.push(`[${r.status()}] ${r.url()}`); });
if (process.env.WHO !== 'none') {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(process.env.WHO === 'viewer' ? 'visitor@example.org' : 'admin@example.org');
  await page.locator('input[name="password"]').fill(process.env.WHO === 'viewer' ? 'demo-viewer-pass' : 'demo-admin-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 }), page.locator('button[type="submit"]').click()]);
}
for (const entry of paths) {
  const i = entry.indexOf('=');
  const [name, path] = [entry.slice(0, i), entry.slice(i + 1)];
  errs = [];
  const res = await page.goto(path, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: process.env.FULL === '1' });
  console.log(`${name} ${res?.status()} ${page.url()}${errs.length ? '\n  ' + errs.join('\n  ') : ''}`);
}
await b.close();
