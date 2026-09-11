import { chromium } from '@playwright/test';
const b = await chromium.launch();
const c = await b.newContext({ baseURL: 'http://localhost:3100' });
const p = await c.newPage();
await p.goto('/login');
await p.getByLabel('Admin code').fill('qa-admin-code');
await Promise.all([p.waitForURL(u => !u.pathname.startsWith('/login')), p.getByRole('button', { name: 'Sign in' }).click()]);
for (const route of ['/admin/concerts', '/admin/settings', '/admin/concerts/1/overview', '/admin/concerts/1/players', '/admin/concerts/1/checkin', '/admin/concerts/1/operators', '/admin/concerts/1/exports']) {
  await p.goto(route);
  const t = await p.locator('[data-slot="item"]').first().innerText().catch(() => '(no banner)');
  console.log(route.padEnd(34), JSON.stringify(t.replace(/\n+/g, ' | ').slice(0, 90)));
}
await b.close();
