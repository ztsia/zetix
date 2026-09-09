import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { loginAdmin, SEED } from './qa2-auth';

/**
 * The non-negotiable, end to end: a template edit must not change a ticket
 * somebody already holds. Not "the row is unchanged" — the **rendered PDF**.
 */

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
const listUrl = `/admin/concerts/${SEED.concertId}/tickets/templates`;
const SHOTS = 'qa-artifacts/E-template-editor/screens';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

test.afterAll(async () => {
  await sql.end();
});

/** Every stream in a PDF, inflated, as hashes — the drawn content, nothing else. */
function streamHashes(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body = Buffer.from(raw.slice(start, end), 'latin1');
    try {
      body = inflateSync(body);
    } catch {
      /* plain */
    }
    out.push(`${body.length}:${createHash('sha256').update(body).digest('hex').slice(0, 16)}`);
  }
  return out;
}

test('FLOW-17 an issued ticket renders identically after the template is edited', async ({ page }) => {
  await loginAdmin(page);
  await page.goto(listUrl);
  await page.getByText('Classic Landscape').waitFor();

  const [t] = await sql<{ id: number; version: number }[]>`
    select id, version from ticket_templates
     where concert_id = ${SEED.concertId} and name = 'Classic Landscape'
     order by version desc limit 1`;

  // Give v1 artwork while nothing is issued against it.
  await page.goto(`${listUrl}/${t.id}`);
  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-small.png');
  await expect(page.getByText('Image artwork loaded.')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Still version 1/)).toBeVisible({ timeout: 15_000 });

  // Issue a ticket against it, as a blast would.
  await sql`update attendees
               set ticket_template_id = ${t.id}, ticket_template_version = ${t.version},
                   ticket_code = 'ORC-' || id, qr_token = 'tok-' || id || '-bbbbbbbbbbbbbbbb',
                   ticket_issued_at = now(), ticket_sent_at = now()
             where id = 1`;

  const first = await page.request.get('/api/tickets/1/pdf');
  expect(first.status()).toBe(200);
  const firstBytes = Buffer.from(await first.body());
  const before = streamHashes(firstBytes);
  expect(before.length).toBeGreaterThan(5);
  await shot(page, 'FLOW-17-step-1-ticket-issued');

  // Now edit the template hard: move an element and replace the artwork.
  await page.goto(`${listUrl}/${t.id}`);
  await expect(page.getByText(/1 issued — saving makes v2/)).toBeVisible();
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.28);
  await page.keyboard.press('Shift+ArrowDown');
  await page.locator('input[type=file]').first().setInputFiles('/tmp/qa2-a4-300.png');
  await expect(page.getByText('Image artwork loaded.')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Saved as version 2/)).toBeVisible({ timeout: 15_000 });
  await shot(page, 'FLOW-17-step-2-template-edited');

  const second = await page.request.get('/api/tickets/1/pdf');
  expect(second.status()).toBe(200);
  const secondBytes = Buffer.from(await second.body());
  const after = streamHashes(secondBytes);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  console.log('WHOLE PDF', JSON.stringify({
    beforeBytes: firstBytes.length, afterBytes: secondBytes.length,
    beforeSha: sha(firstBytes), afterSha: sha(secondBytes),
  }));

  // Two renders of the *same* state still differ in two streams: pdf-lib
  // stamps a creation time and a document id. A third render, taken with
  // nothing changed in between, measures that noise floor, so the comparison
  // below is "did the edit move anything the noise does not".
  await page.waitForTimeout(1500); // let the clock tick, so the noise shows
  const third = streamHashes(Buffer.from(await (await page.request.get('/api/tickets/1/pdf')).body()));
  const noise = after.map((v, i) => (v === third[i] ? null : i)).filter((i) => i !== null);
  const moved = before.map((v, i) => (v === after[i] ? null : i)).filter((i) => i !== null);
  console.log('PINNED RENDER STREAMS BEFORE', JSON.stringify(before));
  console.log('PINNED RENDER STREAMS AFTER ', JSON.stringify(after));
  console.log('NOISE STREAM INDEXES', JSON.stringify(noise), 'MOVED', JSON.stringify(moved));
  expect(before.length).toBe(after.length);
  const [pin] = await sql<{ v: number; id: number }[]>`
    select ticket_template_version as v, ticket_template_id as id from attendees where id = 1`;
  const rows = await sql`select id, version, background_asset_path, page_width_pt, page_height_pt
                           from ticket_templates where name = 'Classic Landscape' order by version`;
  console.log('PIN AFTER EDIT', JSON.stringify(pin));
  console.log('TEMPLATE ROWS', JSON.stringify(rows));
  // Everything the edit did not touch — the page content stream and the
  // background image among them — is byte-identical.
  expect(moved.filter((i) => !noise.includes(i))).toEqual([]);

  expect(Number(pin.v)).toBe(1);
  expect(Number(pin.id)).toBe(Number(t.id));
});
