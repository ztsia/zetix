/**
 * Module `E` — phase 5. The phase-2 flows, walked in Chromium.
 *
 * Screenshots land in `qa-artifacts/E-template-editor/screens/FLOW-<n>-step-<n>-<what>.png`.
 * Every step asserts before it shoots.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import postgres from 'postgres';

const SHOTS = 'qa-artifacts/E-template-editor/screens';
mkdirSync(SHOTS, { recursive: true });

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 3 },
);
test.afterAll(async () => {
  await sql.end();
});

const ADMIN_CODE = 'qa-admin-code';
const OP_CODE = 'qa-op-code';
const CONCERT = 1;
const LONGEST = 'Wilhelmina Aurelia Constance Featherstonehaugh-Villanueva';

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function asAdmin(browser: Browser, opts = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill(ADMIN_CODE);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

async function asOperator(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Access code').fill(OP_CODE);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

/** Templates are seeded lazily by the list page; make sure they exist. */
async function ensureSeeded(browser: Browser) {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${CONCERT}/tickets/templates`);
  await expect(page.getByRole('heading', { name: 'Ticket templates' })).toBeVisible();
  await ctx.close();
}

async function defaultTemplateRow() {
  const [row] = await sql<{ id: number; version: number; name: string }[]>`
    select id, version, name from ticket_templates
     where concert_id = ${CONCERT} and is_default and deleted_at is null
     order by version desc limit 1`;
  return row;
}

/** The biggest element in a layout — the one a click can reliably land on. */
function biggest(elements: { id: string; x: number; y: number; w: number; h: number }[]) {
  return [...elements].sort((a, b) => b.w * b.h - a.w * a.h)[0];
}

/** Click an element's box on the Konva stage, in layout points. */
async function selectElement(page: Page, templateId: number, el: { x: number; y: number; w: number; h: number }) {
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  const [w] = await sql<{ page_width_pt: number }[]>`
    select page_width_pt from ticket_templates where id = ${templateId}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const box = (await canvas.boundingBox())!;
    const scale = box.width / w.page_width_pt;
    await page.mouse.click(box.x + (el.x + el.w / 2) * scale, box.y + (el.y + el.h / 2) * scale);
    if (await page.locator('#field-x').count()) return;
    await page.waitForTimeout(500);
  }
  throw new Error('could not select an element on the canvas');
}

async function unpinAll() {
  await sql`update attendees set ticket_template_id = null, ticket_template_version = null,
                                  ticket_issued_at = null`;
}


// Not serial: each of these is a documented defect, and one failing must not
// hide the next.

// ─────────────────────────────────────────────────── canvas from artwork
test('a 300 dpi background gives a ticket-sized canvas, not a poster', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  const [saved] = await sql<{ id: number; page_width_pt: number; page_height_pt: number }[]>`
    select id, page_width_pt, page_height_pt from ticket_templates
     where concert_id = ${CONCERT} and background_asset_path is not null
     order by id desc limit 1`;
  await page.goto(`/admin/concerts/${CONCERT}/tickets/templates/${saved.id}?show=1`);
  await expect(page.locator('canvas').first()).toBeVisible();
  await shot(page, 'FLOW-14-step-1-canvas-after-300dpi-upload');
  // 1240 x 1754 px of A5 artwork at 300 dpi is 420 x 595 pt.
  expect({ width: saved.page_width_pt, height: saved.page_height_pt }).toEqual({
    width: 420,
    height: 595,
  });
  await ctx.close();
});

// ─────────────────────────────────────────────────── select labels
test('the preview pickers show labels, not raw values', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  const row = await defaultTemplateRow();
  await page.goto(`/admin/concerts/${CONCERT}/tickets/templates/${row.id}?show=1`);
  await expect(page.getByLabel('Preview against')).toBeVisible();
  const subjectTrigger = (await page.getByLabel('Preview against').innerText()).trim();
  const showTrigger = (await page.locator('#show').innerText()).trim();
  await shot(page, 'FLOW-13-step-1-raw-select-values');
  expect({ subjectTrigger, showTrigger }).toEqual({
    subjectTrigger: 'A real attendee',
    showTrigger: 'Evening Show',
  });
  await ctx.close();
});

// ─────────────────────────────────────────────────── §10.3 affordances
test('§10.3 affordances the editor is required to have', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  const row = await defaultTemplateRow();
  await page.goto(`/admin/concerts/${CONCERT}/tickets/templates/${row.id}`);
  await expect(page.locator('canvas').first()).toBeVisible();

  const present: Record<string, boolean> = {};
  for (const [label, locator] of [
    ['undo', page.getByRole('button', { name: /undo/i })],
    ['redo', page.getByRole('button', { name: /redo/i })],
    ['lock', page.getByRole('button', { name: /lock/i })],
    ['duplicate element', page.getByRole('button', { name: /duplicate/i })],
    ['snap to grid', page.getByText(/snap/i)],
    ['alignment guides', page.getByText(/align.*guide|guides/i)],
  ] as const) {
    present[label] = (await locator.count()) > 0;
  }
  console.log('affordances', JSON.stringify(present));
  await shot(page, 'FLOW-12-step-1-affordances');

  expect(present).toEqual({
    undo: true,
    redo: true,
    lock: true,
    'duplicate element': true,
    'snap to grid': true,
    'alignment guides': true,
  });

  await ctx.close();
});

// ─────────────────────────────────────────────────── unbounded text
// Runs last: the render it triggers blocks the dev server's event loop, so
// anything after it would time out for the wrong reason.
test('a text element with no length bound does not pin the renderer', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  const started = Date.now();
  let outcome: string;
  try {
    const response = await page.request.post('/api/tickets/preview', {
      timeout: 45_000,
      data: {
        concertId: CONCERT,
        showId: 1,
        subject: 'FIRST',
        layout: {
          canvas: { width_pt: 200, height_pt: 100 },
          elements: [
            { id: 'x', type: 'TEXT', binding: null, text: 'A'.repeat(1_000_000), x: 0, y: 0, w: 100, h: 20 },
          ],
        },
      },
    });
    outcome = `${response.status()} in ${Date.now() - started}ms`;
  } catch (error) {
    outcome = `no response after ${Date.now() - started}ms: ${(error as Error).message.slice(0, 60)}`;
  }
  console.log('1 MB text element:', outcome);
  await ctx.close();
  expect(outcome).toMatch(/^(200|400|413) in \d+ms$/);
});
