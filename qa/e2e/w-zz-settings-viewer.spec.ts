import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { OUT, SHOTS, newPage } from './w-helpers';
test('FLOW-7c viewer on Settings › System defaults (same SettingRow)', async ({ browser }) => {
  const { ctx, page } = await newPage(browser, 'viewer');
  await page.goto('/admin/settings', { waitUntil: 'networkidle' });
  const controls = page.locator('div.border-b input, div.border-b select');
  let editable = 0;
  for (const el of await controls.all()) if (await el.isEditable()) editable++;
  const saves = await page.getByRole('button', { name: 'Save', exact: true }).count();
  await page.screenshot({ path: `${SHOTS}/FLOW-7c-step-1-viewer-settings.png` });
  writeFileSync(`${OUT}/settings-viewer.json`, JSON.stringify({ controls: await controls.count(), editable, saves }));
  await ctx.close();
});
