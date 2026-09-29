// Module W: the console theme's edges (spec/v3.md §29.5). Needs start-v.sh running.
import { chromium } from '@playwright/test';
const [out, formId] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: 'http://localhost:3100', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
await page.goto('/login');
await page.locator('input[name="email"]').fill('committee@example.test');
await page.locator('input[name="password"]').fill('qa-admin-pass');
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);

const probe = () => page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const btn = document.querySelector('[data-slot="card"]');
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    dark: document.documentElement.classList.contains('dark'),
    primary: root.getPropertyValue('--primary').trim(),
    formAccent: root.getPropertyValue('--form-accent').trim(),
    shadowSm: root.getPropertyValue('--shadow-sm').trim(),
    font: getComputedStyle(document.body).fontFamily.slice(0, 60),
    cardShadow: btn ? getComputedStyle(btn).boxShadow.slice(0, 80) : null,
  };
});

await page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
console.log('default', JSON.stringify(await probe()));

// Choose a theme through the switcher itself.
await page.getByRole('button', { name: /Appearance/ }).click();
await page.getByRole('menuitemradio', { name: 'Supabase' }).click();
await page.getByRole('menuitemradio', { name: 'Dark' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/switcher.png` });
console.log('after pick', JSON.stringify(await probe()));
console.log('stored', await page.evaluate(() => [localStorage.getItem('zetix.console.theme'), localStorage.getItem('zetix.console.mode')]));
await page.keyboard.press('Escape');

await page.reload({ waitUntil: 'networkidle' });
console.log('reloaded', JSON.stringify(await probe()));

await page.goto(`/admin/concerts/3/forms/${formId}`, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${out}/builder-themed.png` });
console.log('builder', JSON.stringify(await probe()));

await page.goto('/f/qa-autumn', { waitUntil: 'networkidle' });
console.log('public form', JSON.stringify(await probe()));
await page.goto('/login', { waitUntil: 'networkidle' });
console.log('login', JSON.stringify(await probe()));

// A client-side navigation out of the console: the provider's cleanup.
await page.goto('/admin/concerts/3/home', { waitUntil: 'networkidle' });
await page.evaluate(() => { window.next?.router?.push('/f/qa-autumn'); });
await page.waitForURL(/\/f\/qa-autumn/);
await page.waitForTimeout(800);
console.log('client nav to form', JSON.stringify(await probe()));
console.log(errs.join('\n'));
await b.close();
