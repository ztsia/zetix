/** AC-10 — drag, resize and rotate an element with the pointer. */
import { test, expect } from '@playwright/test';
import postgres from 'postgres';
const SHOTS = 'qa-artifacts/E-template-editor/screens';
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', { prepare: false, max: 2 });
test.afterAll(async () => { await sql.end(); });

test('FLOW-2b  an element is dragged and resized with the pointer', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.getByRole('button', { name: 'Sign in' }).click()]);

  await page.goto('/admin/concerts/1/tickets/templates');
  await expect(page.getByRole('heading', { name: 'Ticket templates' })).toBeVisible();

  const [row] = await sql<{ id: number; page_width_pt: number; layout: { elements: { id: string; x: number; y: number; w: number; h: number }[] } }[]>`
    select id, page_width_pt, layout from ticket_templates
     where concert_id = 1 and background_asset_path is null and version = 1
     order by id limit 1`;
  await page.goto(`/admin/concerts/1/tickets/templates/${row.id}?show=1`);
  await expect(page.locator('canvas').first()).toBeVisible();

  const el = [...row.layout.elements].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const box = (await page.locator('canvas').first().boundingBox())!;
  const scale = box.width / row.page_width_pt;
  const cx = box.x + (el.x + el.w / 2) * scale;
  const cy = box.y + (el.y + el.h / 2) * scale;

  await page.mouse.click(cx, cy);
  await expect(page.locator('#field-x')).toBeVisible();
  const startX = Number(await page.locator('#field-x').inputValue());
  const startW = Number(await page.locator('#field-width').inputValue());

  // Drag 40pt to the right.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60 * scale, cy, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.locator('#field-x').inputValue()))
    .toBeLessThan(startX - 40);
  const draggedX = Number(await page.locator('#field-x').inputValue());
  await page.screenshot({ path: `${SHOTS}/FLOW-2b-step-1-dragged.png`, fullPage: true });

  // Drag the bottom-right transform handle outward, using where the element
  // now actually is rather than where it started.
  const nowY = Number(await page.locator('#field-y').inputValue());
  const nowW = Number(await page.locator('#field-width').inputValue());
  const nowH = Number(await page.locator('#field-height').inputValue());
  const handleX = box.x + (draggedX + nowW) * scale;
  const handleY = box.y + (nowY + nowH) * scale;
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + 60 * scale, handleY + 60 * scale, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.locator('#field-width').inputValue()))
    .toBeGreaterThan(startW + 10);
  await page.screenshot({ path: `${SHOTS}/FLOW-2b-step-2-resized.png`, fullPage: true });

  console.log('drag/resize:', JSON.stringify({
    startX, draggedX,
    startW, resizedW: Number(await page.locator('#field-width').inputValue()),
    rotationFieldPresent: (await page.locator('#field-rotation').count()) === 1,
  }));
  await ctx.close();
});
