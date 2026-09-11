import { chromium } from '@playwright/test';

const BASE = 'http://localhost:3100';

async function login(browser, kind) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const p = await ctx.newPage();
  if (kind === 'admin') {
    await p.goto('/login');
    await p.getByLabel('Admin code').fill('qa-admin-code');
    await Promise.all([p.waitForURL(u => !u.pathname.startsWith('/login')), p.getByRole('button', { name: 'Sign in' }).click()]);
  } else {
    await p.goto('/scan/login');
    await p.getByLabel('Display name').fill(kind);
    await p.getByLabel('Access code').fill('qa-op-code');
    await Promise.all([p.waitForURL(u => !u.pathname.startsWith('/scan/login')), p.getByRole('button', { name: 'Sign in' }).click()]);
  }
  await p.close();
  return ctx;
}

const browser = await chromium.launch();
for (const who of ['anonymous', 'admin', 'Wei Ling', 'No Shows']) {
  const ctx = who === 'anonymous' ? await browser.newContext({ baseURL: BASE }) : await login(browser, who === 'admin' ? 'admin' : who);
  const r = await ctx.request.post('/api/outbox/dispatch');
  const body = (await r.text()).slice(0, 120);
  // and the admin shell itself (where the banner lives)
  const page = await ctx.newPage();
  const resp = await page.goto('/admin/concerts/1/overview', { waitUntil: 'domcontentloaded' });
  const finalUrl = page.url();
  const hasBanner = await page.locator('[data-slot="item"]').count();
  console.log(JSON.stringify({ who, dispatchStatus: r.status(), dispatchBody: body, shellStatus: resp?.status(), finalUrl, itemsOnPage: hasBanner }));
  await page.close();
  await ctx.close();
}
await browser.close();
