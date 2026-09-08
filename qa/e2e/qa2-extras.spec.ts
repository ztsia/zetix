import { execSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { loginAdmin, SEED } from './qa2-auth';

/** QA re-run — the corners the flows do not reach. */

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
const SHOTS = 'qa-artifacts/E-template-editor/screens';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const listUrl = `/admin/concerts/${SEED.concertId}/tickets/templates`;

test.describe.configure({ mode: 'serial' });

// Visiting the list is what seeds the three default templates (decision 10).
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAdmin(page);
  await page.goto(listUrl);
  await page.getByText('Classic Landscape').waitFor();
  await page.close();
});

test.afterAll(async () => {
  await sql.end();
});

async function templateRow(name: string) {
  const rows = await sql<{ id: number; version: number; layout: unknown; background_kind: string; page_width_pt: number; page_height_pt: number }[]>`
    select id, version, layout, background_kind, page_width_pt, page_height_pt
      from ticket_templates where concert_id = ${SEED.concertId} and name = ${name}
     order by version desc limit 1`;
  return rows[0];
}

test('AC-10/AC-12 a PDF background: page box in points is authoritative', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await loginAdmin(page);
  const template = await templateRow('Wide Banner');
  await page.goto(`${listUrl}/${template.id}`);
  await expect(page.locator('canvas').first()).toBeVisible();

  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-a5.pdf');
  await expect(page.getByText('PDF artwork loaded.')).toBeVisible({ timeout: 20_000 });
  // The MediaBox is 420 x 595 pt. Not a rasterised pixel size, and not divided
  // by dpi the way an image is.
  await expect(page.locator('#page-w')).toHaveValue('420');
  await expect(page.locator('#page-h')).toHaveValue('595');
  await shot(page, 'FLOW-13-step-1-pdf-page-box');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Still version|Saved as version/)).toBeVisible({ timeout: 15_000 });
  const after = await templateRow('Wide Banner');
  console.log('PDF BACKGROUND', JSON.stringify({
    kind: after.background_kind,
    w: after.page_width_pt,
    h: after.page_height_pt,
  }));
  expect(after.background_kind).toBe('PDF');
  expect([after.page_width_pt, after.page_height_pt]).toEqual([420, 595]);

  // Whether the rasterised page then draws on the canvas is asserted in
  // qa2-pdfbg.spec.ts, which is where that finding's evidence lives.
  console.log('PDF console errors:', JSON.stringify(errors.slice(0, 3)));
});

test('AC-32 the editor draws the QR backing plate', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Minimal Portrait');
  await page.goto(`${listUrl}/${template.id}`);
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-dark.png');
  await expect(page.getByText('Image artwork loaded.')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'QR', exact: true }).click();
  await page.waitForTimeout(1500);
  await shot(page, 'FLOW-14-step-1-qr-on-dark-artwork');

  // The QR lands in the middle of the canvas. Sample there: without a plate the
  // dark artwork shows through and the symbol would not scan.
  const sample = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const mean = (x: number, y: number, w: number, h: number) => {
      const { data } = ctx.getImageData(x, y, w, h);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
      return sum / (data.length / 4) / 3;
    };
    return {
      corner: mean(2, 2, 30, 30),
      qr: mean(Math.round(canvas.width / 2) - 20, Math.round(canvas.height / 2) - 20, 40, 40),
    };
  });
  console.log('CANVAS SAMPLES (0-255)', JSON.stringify(sample));
  // The dark artwork drew...
  expect(sample.corner).toBeLessThan(90);
  // ...and the QR sits on an opaque light plate over it (§10.4).
  expect(sample.qr).toBeGreaterThan(140);
});

test('AC-26 the decision-33 affordances are absent, and the page says how it works', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Classic Landscape');
  await page.goto(`${listUrl}/${template.id}`);
  await expect(page.locator('canvas').first()).toBeVisible();
  // Select something so the element panel, where a lock/duplicate would live,
  // is on screen.
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.28);
  const body = await page.locator('body').innerText();
  const absent = ['undo', 'redo', 'snap', 'guides', 'lock', 'duplicate element', 'select all'];
  const present = absent.filter((word) => new RegExp(word, 'i').test(body));
  console.log('DECISION-33 AFFORDANCES FOUND IN UI:', JSON.stringify(present));
  // z-order, delete and nudge are the ones §10.3 keeps.
  await expect(page.getByRole('button', { name: 'Bring to front' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Send to back' })).toHaveCount(1);
  await shot(page, 'FLOW-15-step-1-affordances');
  expect(present).toEqual([]);
});

test('AC-31b an element count nothing bounds is accepted and slows the renderer', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Classic Landscape');
  await page.goto(`${listUrl}/${template.id}`);
  const sizes = [200, 1000];
  const timings: string[] = [];
  for (const n of sizes) {
    const layout = {
      canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
      elements: Array.from({ length: n }, (_, i) => ({
        id: `el_${i}`,
        type: 'TEXT',
        binding: 'attendee.full_name',
        x: 10,
        y: 10,
        w: 60,
        h: 14,
        font_size: 12,
      })),
    };
    const started = Date.now();
    const res = await page.request.post('/api/tickets/preview', {
      data: { concertId: SEED.concertId, showId: SEED.show1, subject: 'FIRST', layout },
      timeout: 120_000,
    });
    const ms = Date.now() - started;
    const truncated = JSON.parse(res.headers()['x-ticket-truncated'] ?? '[]');
    timings.push(`${n} elements -> ${res.status()} in ${ms}ms, truncated header lists ${truncated.length}, header bytes ${(res.headers()['x-ticket-truncated'] ?? '').length}`);
  }
  console.log('ELEMENT COUNT\n' + timings.join('\n'));
});

test('AC-47 the branch adds no schema or migration file', async () => {
  const files = execSync('git diff --name-only origin/main...HEAD', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const schema = files.filter((f: string) => f.startsWith('src/db/') || f.startsWith('drizzle/'));
  console.log('SCHEMA FILES TOUCHED', JSON.stringify(schema));
  expect(schema).toEqual([]);
});
