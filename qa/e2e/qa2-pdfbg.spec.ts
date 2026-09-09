import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { loginAdmin, SEED } from './qa2-auth';

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
const listUrl = `/admin/concerts/${SEED.concertId}/tickets/templates`;

test.afterAll(async () => { await sql.end(); });

test('why does a PDF background not draw on the canvas', async ({ page }) => {
  const log: string[] = [];
  page.on('console', (m) => log.push(`console.${m.type()}: ${m.text().slice(0, 400)}`));
  page.on('pageerror', (e) => log.push(`pageerror: ${String(e).slice(0, 400)}`));
  page.on('requestfailed', (r) => log.push(`requestfailed: ${r.url().slice(0, 200)} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) log.push(`response ${r.status()}: ${r.url().slice(0, 200)}`);
  });

  page.on('worker', (w) => log.push(`worker: ${w.url().slice(0, 200)}`));
  page.on('request', (r) => {
    const u = r.url();
    if (/pdf|worker|ticket-assets/i.test(u)) log.push(`request: ${u.slice(0, 200)}`);
  });
  page.on('requestfinished', async (r) => {
    const u = r.url();
    if (/pdf|worker/i.test(u)) log.push(`finished ${(await r.response())?.status()}: ${u.slice(0, 200)}`);
  });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  await page.addInitScript(() => {
    const w = window as any;
    w.__probe = [] as string[];
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args: any[]) {
      w.__probe.push(`toBlob ${this.width}x${this.height}`);
      return (origToBlob as any).apply(this, args);
    };
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = function (obj: any) {
      const url = origCreate.call(URL, obj);
      w.__probe.push(`createObjectURL ${obj?.type ?? typeof obj} ${obj?.size ?? ''}`);
      return url;
    };
    const origRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url: string) {
      w.__probe.push(`revokeObjectURL`);
      return origRevoke.call(URL, url);
    };
    const OrigImage = window.Image;
    w.Image = function (this: any, ...args: any[]) {
      const img = new OrigImage(...args);
      img.addEventListener('load', () => w.__probe.push(`img load ${img.naturalWidth}x${img.naturalHeight} ${String(img.src).slice(0, 40)}`));
      img.addEventListener('error', () => w.__probe.push(`img error ${String(img.src).slice(0, 60)}`));
      return img;
    };
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  await loginAdmin(page);
  await page.goto(listUrl);
  await page.getByText('Classic Landscape').waitFor();
  const [t] = await sql<{ id: number }[]>`
    select id from ticket_templates where concert_id = ${SEED.concertId} and name = 'Minimal Portrait' order by version desc limit 1`;
  await page.goto(`${listUrl}/${t.id}`);
  await expect(page.locator('canvas').first()).toBeVisible();
  log.length = 0;

  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-a5.pdf');
  await expect(page.getByText('PDF artwork loaded.')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(6000);

  const stats = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 100) dark += 1;
    }
    return { w: canvas.width, h: canvas.height, darkFraction: dark / (data.length / 4) };
  });
  console.log('CANVAS', JSON.stringify(stats));
  console.log('BROWSER LOG\n' + log.join('\n'));
  console.log('PROBE\n' + JSON.stringify(await page.evaluate(() => (window as unknown as { __probe: string[] }).__probe), null, 1));
  // The A5 fixture is a near-black page: if it were drawn, most pixels are dark.
  expect(stats.darkFraction).toBeGreaterThan(0.5);
});

test('the server render, unlike the canvas, does use the PDF artwork', async ({ page }) => {
  await loginAdmin(page);
  const upload = await page.request.post('/api/ticket-assets', {
    multipart: {
      concertId: String(SEED.concertId),
      file: { name: 'a5.pdf', mimeType: 'application/pdf', buffer: readFileSync('/tmp/qa2-a5.pdf') },
    },
  });
  expect(upload.status()).toBe(200);
  const { path, kind } = await upload.json();

  const res = await page.request.post('/api/tickets/preview', {
    data: {
      concertId: SEED.concertId,
      showId: SEED.show1,
      subject: 'FIRST',
      backgroundAssetPath: path,
      layout: {
        canvas: { width_pt: 420, height_pt: 595, dpi: 300 },
        elements: [
          {
            id: 'el_name',
            type: 'TEXT',
            binding: 'attendee.full_name',
            x: 20,
            y: 20,
            w: 200,
            h: 24,
            font_size: 14,
          },
        ],
      },
    },
  });
  expect(res.status()).toBe(200);
  const bytes = Buffer.from(await res.body());
  const doc = await PDFDocument.load(bytes);
  const size = doc.getPage(0).getSize();
  console.log('SERVER RENDER OVER PDF ARTWORK', JSON.stringify({
    kind, path, pages: doc.getPageCount(), size, bytes: bytes.length,
  }));
  // Drawn onto the original vector page: one page, the A5 fixture's own box.
  expect(kind).toBe('PDF');
  expect([Math.round(size.width), Math.round(size.height)]).toEqual([420, 595]);
  expect(doc.getPageCount()).toBe(1);
});

test('canvas dimensions are derived from the browser MIME type, not the bytes', async ({ page }) => {
  await loginAdmin(page);
  await page.goto(listUrl);
  await page.getByText('Classic Landscape').waitFor();
  const [t] = await sql<{ id: number; page_width_pt: number }[]>`
    select id, page_width_pt from ticket_templates where concert_id = ${SEED.concertId}
       and name = 'Classic Landscape' order by version desc limit 1`;
  await page.goto(`${listUrl}/${t.id}`);
  const before = await page.locator('#page-w').inputValue();

  // The same A5 PDF, offered with the content type a file manager that does not
  // know the extension would send. §10.3: artwork is typed by its leading bytes.
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'artwork.pdf',
    mimeType: 'application/octet-stream',
    buffer: readFileSync('/tmp/qa2-a5.pdf'),
  });
  await expect(page.getByText('PDF artwork loaded.')).toBeVisible({ timeout: 20_000 });
  const after = await page.locator('#page-w').inputValue();
  const message = await page.locator('[role=alert]').first().innerText().catch(() => '');
  console.log('MIME-TYPED MEASUREMENT', JSON.stringify({ before, after, message }));
  await page.screenshot({ path: 'qa-artifacts/E-template-editor/screens/FLOW-16-step-1-mime-typed-measure.png', fullPage: true });
  expect(after).toBe('420');
});
