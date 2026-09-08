import { inflateSync } from 'node:zlib';
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { loginAdmin, loginOperator, SEED } from './qa2-auth';

/**
 * QA re-run, phase 5 — the phase-2 flows walked in Chromium.
 * Every step asserts before it screenshots.
 */

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});

const SHOTS = 'qa-artifacts/E-template-editor/screens';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const listUrl = `/admin/concerts/${SEED.concertId}/tickets/templates`;

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await sql.end();
});

async function templateRow(name: string) {
  const rows = await sql<
    { id: number; version: number; layout: unknown; is_default: boolean; supersedes_id: number | null; background_asset_path: string | null; background_kind: string }[]
  >`select id, version, layout, is_default, supersedes_id, background_asset_path, background_kind
      from ticket_templates where concert_id = ${SEED.concertId} and name = ${name}
     order by version desc limit 1`;
  return rows[0];
}

/** Click an element on the Konva stage by its layout coordinates. */
async function clickElement(page: Page, x: number, y: number, w: number, h: number) {
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const widthPt = Number(
    (await page.getByText(/pt\. Drag to move/).innerText()).match(/^(\d+)/)?.[1] ?? '595',
  );
  const scale = box.width / widthPt;
  await page.mouse.click(box.x + (x + w / 2) * scale, box.y + (y + h / 2) * scale);
}

test('FLOW-1 admin opens the template list and the editor', async ({ page }) => {
  await loginAdmin(page);
  await page.goto(listUrl);
  await expect(page.getByText('Classic Landscape')).toBeVisible();
  await expect(page.getByText('Minimal Portrait')).toBeVisible();
  await expect(page.getByText('Wide Banner')).toBeVisible();
  await shot(page, 'FLOW-1-step-1-template-list');

  const template = await templateRow('Classic Landscape');
  await page.goto(`${listUrl}/${template.id}`);
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.getByText(/pt\. Drag to move/)).toBeVisible();
  // AC-25: konva is client-only; the server HTML must not carry a konva error.
  await expect(page.locator('text=Application error')).toHaveCount(0);
  await shot(page, 'FLOW-1-step-2-editor-canvas');
});

test('FLOW-2 move, nudge, resize, save, reload', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Classic Landscape');
  const layout = template.layout as { elements: { id: string; x: number; y: number; w: number; h: number }[] };
  const el = layout.elements.find((e) => e.id === 'el_name') ?? layout.elements[0];

  await page.goto(`${listUrl}/${template.id}`);
  await expect(page.locator('canvas').first()).toBeVisible();
  await clickElement(page, el.x, el.y, el.w, el.h);
  await expect(page.getByText(el.id, { exact: true })).toBeVisible();
  await shot(page, 'FLOW-2-step-1-element-selected');

  const xField = page.getByLabel('X', { exact: true });
  const startX = Number(await xField.inputValue());
  expect(startX).toBe(el.x);

  // AC-22: 1pt, then 10pt with shift. Focus must not be in a field.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await clickElement(page, el.x, el.y, el.w, el.h);
  await page.keyboard.press('ArrowRight');
  await expect(xField).toHaveValue(String(startX + 1));
  await page.keyboard.press('Shift+ArrowRight');
  await expect(xField).toHaveValue(String(startX + 11));
  await shot(page, 'FLOW-2-step-2-nudged');

  // AC-19: a real mouse drag on the canvas, not just the number fields.
  const canvas = page.locator('canvas').first();
  const cbox = (await canvas.boundingBox())!;
  const widthPt = Number(
    (await page.getByText(/pt\. Drag to move/).innerText()).match(/^(\d+)/)?.[1] ?? '595',
  );
  const scale = cbox.width / widthPt;
  const from = {
    x: cbox.x + (startX + 11 + el.w / 2) * scale,
    y: cbox.y + (el.y + el.h / 2) * scale,
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 25 * scale, { steps: 10 });
  await page.mouse.up();
  const draggedY = Number(await page.getByLabel('Y', { exact: true }).inputValue());
  console.log('DRAG moved y from', el.y, 'to', draggedY);
  expect(draggedY).toBeGreaterThan(el.y + 15);
  await shot(page, 'FLOW-2-step-3-dragged');

  // AC-20: resize through the properties panel.
  const wField = page.getByLabel('Width', { exact: true });
  await wField.fill(String(el.w + 40));
  await wField.blur();
  await expect(wField).toHaveValue(String(el.w + 40));

  // AC-21: rotation.
  const rField = page.getByLabel('Rotation', { exact: true });
  await rField.fill('15');
  await rField.blur();

  // AC-23: z-order — send this element to the back of the element list.
  await page.getByRole('button', { name: 'Send to back' }).click();

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Still version 1/)).toBeVisible();
  await shot(page, 'FLOW-2-step-4-saved-in-place');

  const after = await templateRow('Classic Landscape');
  const savedElements = (after.layout as { elements: { id: string; x: number; y: number; w: number; h: number; rotation: number }[] }).elements;
  const saved = savedElements.find((e) => e.id === el.id)!;
  console.log('SAVED ELEMENT', JSON.stringify({ ...saved, first: savedElements[0].id }));
  expect({
    id: after.id,
    version: after.version,
    x: saved.x,
    w: saved.w,
    y: saved.y,
    rotation: saved.rotation,
    firstInLayout: savedElements[0].id,
  }).toEqual({
    id: template.id,
    version: 1,
    x: startX + 11,
    w: el.w + 40,
    y: draggedY,
    rotation: 15,
    firstInLayout: el.id, // sent to back = drawn first
  });

  await page.reload();
  await expect(page.getByText(/pt\. Drag to move/)).toBeVisible();
  // Click near the element's origin: a rotated group pivots about it, so the
  // geometric centre is no longer where the box is drawn.
  await clickElement(page, saved.x, saved.y, 16, 12);
  await expect(page.getByText('el_name', { exact: true })).toBeVisible();
  await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(startX + 11));
  await expect(page.getByLabel('Rotation', { exact: true })).toHaveValue('15');
  await shot(page, 'FLOW-2-step-5-reloaded');
});

test('FLOW-3 the binding picker offers exactly the spec bindings', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Classic Landscape');
  await page.goto(`${listUrl}/${template.id}`);
  await page.getByRole('button', { name: 'Variable' }).click();
  await expect(page.getByText('TEXT', { exact: true })).toBeVisible();
  await page.locator('#binding').click();
  const options = await page.getByRole('option').allInnerTexts();
  console.log('BINDING OPTIONS', JSON.stringify(options));
  await shot(page, 'FLOW-3-step-1-binding-picker');
  expect(options.length).toBe(13); // §10.2's 12 bindings + "Fixed text"
  expect(options).toEqual([
    'Fixed text', 'Attendee name', 'Ticket code', 'QR link', 'Booked by',
    'Player name', 'Player instrument', 'Show name', 'Show date and time',
    'Doors open', 'Venue', 'Venue address', 'Concert name',
  ]);
  const dateOption = page.getByRole('option', { name: 'Show date and time' });
  if (!(await dateOption.isVisible().catch(() => false))) await page.locator('#binding').click();
  await dateOption.click({ timeout: 10_000 });
  await expect(page.locator('#format')).toBeVisible();
  await shot(page, 'FLOW-3-step-2-date-format');
  await page.keyboard.press('Escape');
});

test('FLOW-4 background upload derives the page size through dpi', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Minimal Portrait');
  await page.goto(`${listUrl}/${template.id}`);
  await expect(page.locator('#page-dpi')).toHaveValue('300');
  await shot(page, 'FLOW-4-step-1-before-upload');

  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-a4-300.png');
  await expect(page.getByText('Image artwork loaded.')).toBeVisible({ timeout: 15_000 });
  // 2480 x 3508 px at 300 dpi is A4: 595 x 842 pt, not 2480 x 3508.
  await expect(page.locator('#page-w')).toHaveValue('595');
  await expect(page.locator('#page-h')).toHaveValue('842');
  await shot(page, 'FLOW-4-step-2-a4-derived');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Still version 1|Saved as version/)).toBeVisible();
  const after = await templateRow('Minimal Portrait');
  expect({
    kind: after.background_kind,
    path: (after.background_asset_path ?? '').replace(/[0-9a-f-]{36}/, '<uuid>'),
  }).toEqual({ kind: 'IMAGE', path: 'concerts/1/<uuid>.png' });
  await shot(page, 'FLOW-4-step-3-saved-with-artwork');
});

test('FLOW-5 a renamed text file is refused in the UI', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Wide Banner');
  await page.goto(`${listUrl}/${template.id}`);
  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-not-an-image.png');
  await expect(
    page.getByText('Only PNG, JPEG and PDF artwork can be used on a ticket.'),
  ).toBeVisible();
  await shot(page, 'FLOW-5-step-1-refused');
  const after = await templateRow('Wide Banner');
  expect(after.background_asset_path).toBeNull();
});

test('FLOW-6 editing a template with issued tickets clones instead of mutating', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Classic Landscape');
  const before = JSON.stringify(template.layout);

  // Pin the party to this exact version, with tokens, as a blast would.
  await sql`update attendees
               set ticket_template_id = ${template.id},
                   ticket_template_version = ${template.version},
                   ticket_code = 'ORC-' || id,
                   qr_token = 'tok-' || id || '-aaaaaaaaaaaaaaaa',
                   ticket_issued_at = now(),
                   ticket_sent_at = now()
             where show_id = ${SEED.show1}`;
  const tokensBefore = await sql`select id, qr_token from attendees where show_id = ${SEED.show1} order by id`;

  await page.goto(`${listUrl}/${template.id}`);
  await expect(page.getByText(/2 issued — saving makes v2/)).toBeVisible();
  await shot(page, 'FLOW-6-step-1-issued-warning');

  const layout = template.layout as { elements: { id: string; type: string; x: number; y: number; w: number; h: number; rotation: number }[] };
  const el = layout.elements.find((e) => e.type === 'TEXT' && !e.rotation)!;
  await clickElement(page, el.x, el.y, 16, 12);
  await expect(page.getByText(el.id, { exact: true })).toBeVisible();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.getByLabel('Y', { exact: true })).toHaveValue(String(el.y + 10));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Saved as version 2/)).toBeVisible({ timeout: 15_000 });
  await shot(page, 'FLOW-6-step-2-cloned-to-v2');

  const v1 = await sql`select layout, is_default from ticket_templates where id = ${template.id}`;
  const v2 = await templateRow('Classic Landscape');
  const pins = await sql`select id, ticket_template_id, ticket_template_version, qr_token from attendees where show_id = ${SEED.show1} order by id`;

  console.log('V1 UNCHANGED', JSON.stringify(v1[0].layout) === before);
  console.log('PINS', JSON.stringify(pins));
  expect(JSON.stringify(v1[0].layout)).toBe(before);            // AC-34
  expect(v2.version).toBe(2);
  expect(Number(v2.supersedes_id)).toBe(Number(template.id));   // AC-37
  // AC-36: the flag moved to the new version, and exactly one row carries it.
  const defaults = await sql<{ id: number; version: number }[]>`
    select id, version from ticket_templates where concert_id = ${SEED.concertId} and is_default`;
  console.log('DEFAULT ROWS', JSON.stringify(defaults));
  expect(defaults.length).toBe(1);
  expect(Number(defaults[0].id)).toBe(Number(v2.id));
  expect(v1[0].is_default).toBe(false);
  expect(pins.every((p) => Number(p.ticket_template_version) === 1)).toBe(true);
  // AC-46
  expect(JSON.stringify(pins.map((p) => p.qr_token))).toBe(
    JSON.stringify(tokensBefore.map((t) => t.qr_token)),
  );
});

test('FLOW-7 duplicate starts a fresh lineage', async ({ page }) => {
  await loginAdmin(page);
  await page.goto(listUrl);
  const source = await templateRow('Classic Landscape');
  await page
    .getByRole('row', { name: /Classic Landscape/ })
    .first()
    .getByRole('button', { name: /duplicate/i })
    .click()
    .catch(async () => {
      await page.getByRole('button', { name: /duplicate/i }).first().click();
    });
  await expect(page.getByText(/Classic Landscape copy/)).toBeVisible({ timeout: 15_000 });
  await shot(page, 'FLOW-7-step-1-duplicated');

  const copy = await templateRow('Classic Landscape copy');
  console.log('COPY', JSON.stringify({ version: copy.version, supersedes: copy.supersedes_id, isDefault: copy.is_default }));
  expect({ version: copy.version, supersedes: copy.supersedes_id, isDefault: copy.is_default }).toEqual({
    version: 1,
    supersedes: null,
    isDefault: false,
  });
  expect(Number(copy.id)).not.toBe(Number(source.id));
});

test('FLOW-8 the longest-name preview reports the clip, and saves nothing', async ({ page }) => {
  await loginAdmin(page);
  const template = await templateRow('Wide Banner');
  const before = JSON.stringify(template.layout);
  // Shows are listed by start time, so the editor opens on the matinee; the
  // longest name lives in the evening show.
  await page.goto(`${listUrl}/${template.id}?show=${SEED.show1}`);
  await expect(page.locator('#show')).toContainText('Evening Show');

  const layout = template.layout as { elements: { id: string; type: string; x: number; y: number; w: number; h: number }[] };
  const el = layout.elements.find((e) => e.type === 'TEXT')!;
  await clickElement(page, el.x, el.y, el.w, el.h);
  await page.getByLabel('Width', { exact: true }).fill('40');
  await page.getByLabel('Width', { exact: true }).blur();
  await page.locator('#overflow').click();
  await page.getByRole('option', { name: 'Cut it off' }).click();

  await page.locator('#subject').click();
  await expect(page.getByRole('option', { name: 'Longest name in this show' })).toBeVisible();
  await page.getByRole('option', { name: 'Longest name in this show' }).click();
  await shot(page, 'FLOW-8-step-1-longest-name-selected');

  await page.getByRole('button', { name: 'Preview PDF' }).click();
  await expect(page.getByText(/Clipped:/)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-8-step-2-clip-reported');

  // Nothing was written: the preview is of the unsaved layout.
  const after = await templateRow('Wide Banner');
  expect(JSON.stringify(after.layout)).toBe(before);
});

test('FLOW-9 an operator is refused the editor in the browser', async ({ page }) => {
  await loginOperator(page);
  await shot(page, 'FLOW-9-step-1-operator-signed-in');
  await page.goto(listUrl);
  await expect(page).not.toHaveURL(new RegExp(`${listUrl}$`));
  const body = await page.locator('body').innerText();
  console.log('OPERATOR LANDED ON', page.url());
  expect(body).not.toContain('Classic Landscape');
  expect(body).not.toContain(SEED.longestName);
  await shot(page, 'FLOW-9-step-2-refused');
});

test('FLOW-10 a rendered timestamp is the concert timezone, whatever the browser says', async ({ browser }) => {
  /**
   * The render is server-side, so the honest question is not "did the browser's
   * zone move it" but "which zone did it use". Answered by rendering the binding
   * and a static literal into the same box with the same font, and comparing the
   * PDF's text-drawing content stream: identical glyph runs mean identical text.
   * 12:00Z is 20:00 in Asia/Kuala_Lumpur, the concert's zone.
   */
  const box = (extra: Record<string, unknown>) => ({
    canvas: { width_pt: 400, height_pt: 120, dpi: 300 },
    elements: [
      {
        id: 'el_when',
        type: 'TEXT',
        x: 10,
        y: 10,
        w: 380,
        h: 40,
        font_size: 18,
        font_family: 'Inter',
        font_weight: 400,
        rotation: 0,
        align: 'left',
        valign: 'middle',
        max_lines: 1,
        overflow: 'SHRINK',
        color: '#1a1a1a',
        ...extra,
      },
    ],
  });
  const bound = box({ binding: 'show.starts_at', format: 'yyyy-MM-dd HH:mm' });
  const kualaLumpur = box({ binding: null, text: '2026-09-19 20:00' });
  const utc = box({ binding: null, text: '2026-09-19 12:00' });

  const streams: Record<string, string> = {};
  for (const timezoneId of ['UTC', 'Pacific/Kiritimati']) {
    const context = await browser.newContext({ timezoneId });
    const page = await context.newPage();
    await loginAdmin(page);
    const template = await templateRow('Wide Banner');
    await page.goto(`${listUrl}/${template.id}?show=${SEED.show1}`);
    await expect(page.locator('canvas').first()).toBeVisible();

    const render = async (layout: unknown) => {
      const res = await page.request.post('/api/tickets/preview', {
        data: { concertId: SEED.concertId, showId: SEED.show1, subject: 'FIRST', layout },
      });
      expect(res.status()).toBe(200);
      return textStream(Buffer.from(await res.body()));
    };

    streams[`${timezoneId}:bound`] = await render(bound);
    if (timezoneId === 'UTC') {
      streams['literal:KL'] = await render(kualaLumpur);
      streams['literal:UTC'] = await render(utc);
    }
    await shot(page, `FLOW-10-step-${timezoneId === 'UTC' ? 1 : 2}-${timezoneId.replace('/', '-')}`);
    await context.close();
  }

  console.log('TZ STREAMS', JSON.stringify(streams, null, 2));
  // The binding rendered the Kuala Lumpur wall clock, not UTC...
  expect(streams['UTC:bound']).toBe(streams['literal:KL']);
  expect(streams['UTC:bound']).not.toBe(streams['literal:UTC']);
  // ...and the browser's own zone made no difference to it.
  expect(streams['Pacific/Kiritimati:bound']).toBe(streams['UTC:bound']);
});

/** The text-drawing content stream of a pdf-lib PDF, as a stable string. */
function textStream(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const chunks: string[] = [];
  const re = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body = Buffer.from(raw.slice(start, end), 'latin1');
    try {
      body = inflateSync(body);
    } catch {
      /* already plain */
    }
    const text = body.toString('latin1');
    if (text.includes('Tj')) chunks.push(text.replace(/\/Inter-\S+/g, '/Inter'));
  }
  return chunks.join('\n');
}

test('FLOW-12 replacing a background keeps the artwork a pinned version renders from', async ({ page }) => {
  await loginAdmin(page);
  // Classic Landscape v1 is pinned by FLOW-6; give it artwork, then replace it on v2.
  await sql<{ id: number }[]>`
    select id from ticket_templates where concert_id = ${SEED.concertId}
      and name = 'Classic Landscape' and version = 1`;
  const v2 = await templateRow('Classic Landscape');

  await page.goto(`${listUrl}/${v2.id}`);
  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-small.png');
  await expect(page.getByText('Image artwork loaded.')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Still version 2|Saved as version/)).toBeVisible({ timeout: 15_000 });
  const withArt = await templateRow('Classic Landscape');
  const firstPath = withArt.background_asset_path!;
  expect(firstPath).toBeTruthy();

  // Pin an attendee to v2 so v2 becomes frozen and the next save clones to v3.
  await sql`update attendees set ticket_template_id = ${withArt.id}, ticket_template_version = ${withArt.version}
             where show_id = ${SEED.show1}`;

  await page.goto(`${listUrl}/${withArt.id}`);
  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-a4-300.png');
  await expect(page.getByText('Image artwork loaded.')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Saved as version/)).toBeVisible({ timeout: 15_000 });
  await shot(page, 'FLOW-12-step-1-background-replaced');

  // The pinned version still names the first file, and the file still resolves.
  const pinned = await sql<{ background_asset_path: string }[]>`
    select background_asset_path from ticket_templates where id = ${withArt.id}`;
  expect(pinned[0].background_asset_path).toBe(firstPath);
  const fetched = await page.request.get(`/api/ticket-assets/${firstPath}`);
  console.log('PINNED ARTWORK', firstPath, fetched.status());
  expect(fetched.status()).toBe(200);
  await shot(page, 'FLOW-12-step-2-pinned-artwork-intact');
});
