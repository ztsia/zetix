import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { loginAdmin, SEED } from './qa2-auth';

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});

test.afterAll(async () => { await sql.end(); });

function streams(pdf: Buffer): (number | string)[] {
  const raw = pdf.toString('latin1');
  const sizes: (number | string)[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body = Buffer.from(raw.slice(start, end), 'latin1');
    try { body = inflateSync(body); } catch { /* plain */ }
    sizes.push(`${body.length}:${createHash('sha256').update(body).digest('hex').slice(0, 8)}` as unknown as number);
  }
  return sizes;
}

test('the same pinned ticket renders the same way every time', async ({ page }) => {
  await loginAdmin(page);
  const rows = await sql`select id, version, background_asset_path from ticket_templates
                           where name = 'Classic Landscape' order by version`;
  console.log('ROWS', JSON.stringify(rows));
  const results: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await page.request.get('/api/tickets/1/pdf');
    const body = Buffer.from(await res.body());
    results.push(`${i}: status ${res.status()} bytes ${body.length} streams ${JSON.stringify(streams(body))}`);
  }
  console.log('RENDERS\n' + results.join('\n'));
  // The last four streams carry pdf-lib's creation time and document id and
  // change on every render; everything before them is the drawn ticket.
  const drawn = results.map((r) => JSON.stringify(JSON.parse(r.split('streams ')[1]).slice(0, -4)));
  expect(new Set(drawn).size).toBe(1);
});
