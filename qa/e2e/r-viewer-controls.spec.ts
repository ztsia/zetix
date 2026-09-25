import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { PAGES } from './r-viewer-sweep.spec';

/** Module R — which enabled buttons does a VIEWER still see on each admin screen? (AC-17, Minor if any mutate) */
test('viewer: enabled button labels per admin page', async ({ page }) => {
  test.setTimeout(600_000);
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.252' });
  await page.goto('/login');
  await page.locator('input[name="email"]').fill('mei@example.test');
  await page.locator('input[name="password"]').fill('qa-viewer-pass');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  const out: Record<string, string[]> = {};
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const labels = await page.locator('main button:not([disabled]), main [role="button"]:not([aria-disabled="true"]), main input:not([type="hidden"]):not([disabled]):not([readonly]), main textarea:not([disabled]):not([readonly])').evaluateAll((els) =>
      els.map((e) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('name') || e.tagName).trim().replace(/\s+/g, ' ')).filter(Boolean),
    );
    out[path] = [...new Set(labels)];
  }
  writeFileSync('qa-artifacts/claude-R-roles-accounts/viewer-controls.json', JSON.stringify(out, null, 2));
  for (const [p, l] of Object.entries(out)) console.log(p, '=>', l.join(' | ').slice(0, 400));
});
