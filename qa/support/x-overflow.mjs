// usage: node qa/support/x-overflow.mjs <width> path ...  — reports horizontal overflow on each page, and its widest culprits
import { chromium } from '@playwright/test';
const [width, ...paths] = process.argv.slice(2);
const b = await chromium.launch();
const page = await (await b.newContext({ baseURL: 'http://localhost:3100', viewport: { width: Number(width), height: 900 } })).newPage();
await page.goto('/login');
await page.locator('input[name="email"]').fill('admin@example.org');
await page.locator('input[name="password"]').fill('demo-admin-pass');
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 }), page.locator('button[type="submit"]').click()]);
for (const path of paths) {
  await page.goto(path, { waitUntil: 'networkidle', timeout: 120000 });
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.right > vw + 1 && rect.width > 0) {
        const parentOver = el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 1;
        if (!parentOver) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 140)} right=${Math.round(rect.right)} w=${Math.round(rect.width)}`);
      }
    }
    return { vw, sw, out: out.slice(0, 6) };
  });
  console.log(`${path}  client=${r.vw} scroll=${r.sw}${r.sw > r.vw ? '  OVERFLOW' : ''}\n  ${r.out.join('\n  ')}`);
}
await b.close();
