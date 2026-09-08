import { writeFileSync } from 'node:fs';
import { test, expect, request as pwRequest } from '@playwright/test';
import postgres from 'postgres';
import { loginAdmin, loginOperator, SEED } from './qa2-auth';

/**
 * QA re-run, phase 4 — the real HTTP surface of module E.
 * Nothing is mocked: a running `next dev` on :3100 against `zetix_qa`.
 */

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154' +
    '789c6360000002000100ffff0300000600055773d5c30000000049454e44ae426082',
  'hex',
);

let adminState: string;
let operatorState: string;
let templateId: number;

test.beforeAll(async ({ browser }) => {
  const a = await browser.newPage();
  await loginAdmin(a);
  // Visiting the list is what seeds the three default templates.
  await a.goto(`/admin/concerts/${SEED.concertId}/tickets/templates`);
  await a.waitForLoadState('networkidle');
  adminState = JSON.stringify(await a.context().storageState());
  await a.close();

  const o = await browser.newPage();
  await loginOperator(o);
  operatorState = JSON.stringify(await o.context().storageState());
  await o.close();

  const rows = await sql<{ id: number }[]>`
    select id from ticket_templates where concert_id = ${SEED.concertId} order by id limit 1`;
  templateId = Number(rows[0].id);
});

test.afterAll(async () => {
  await sql.end();
});

async function ctx(state?: string) {
  return pwRequest.newContext({
    baseURL: 'http://localhost:3100',
    storageState: state ? JSON.parse(state) : undefined,
  });
}

const layout = {
  canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
  elements: [
    {
      id: 'el_name',
      type: 'TEXT',
      binding: 'attendee.full_name',
      x: 20,
      y: 20,
      w: 120,
      h: 20,
      font_size: 22,
    },
  ],
};

test('AC-43/AC-17 authorization matrix over real HTTP', async () => {
  const anon = await ctx();
  const op = await ctx(operatorState);
  const admin = await ctx(adminState);
  const rows: string[] = [];

  const record = async (label: string, run: () => Promise<number>) => {
    rows.push(`${label}: ${await run()}`);
  };

  const list = `/admin/concerts/${SEED.concertId}/tickets/templates`;
  const editor = `${list}/${templateId}`;

  for (const [who, c] of [
    ['anon', anon],
    ['operator', op],
    ['admin', admin],
  ] as const) {
    await record(`GET list ${who}`, async () => (await c.get(list, { maxRedirects: 0 })).status());
    await record(`GET editor ${who}`, async () =>
      (await c.get(editor, { maxRedirects: 0 })).status(),
    );
    await record(`POST preview ${who}`, async () =>
      (
        await c.post('/api/tickets/preview', {
          data: { concertId: SEED.concertId, showId: SEED.show1, subject: 'FIRST', layout },
        })
      ).status(),
    );
    await record(`POST upload ${who}`, async () =>
      (
        await c.post('/api/ticket-assets', {
          multipart: {
            concertId: String(SEED.concertId),
            file: { name: 'a.png', mimeType: 'image/png', buffer: PNG },
          },
        })
      ).status(),
    );
  }
  console.log('MATRIX\n' + rows.join('\n'));

  // Only the admin cells may succeed.
  expect(rows).toEqual(
    expect.arrayContaining([
      'GET list admin: 200',
      'GET editor admin: 200',
      'POST preview admin: 200',
      'POST upload admin: 200',
    ]),
  );
  for (const row of rows) {
    if (row.includes('admin')) continue;
    const status = Number(row.split(': ')[1]);
    expect(status, row).not.toBe(200);
  }

  // And the body of a refused page never carries a template name.
  const opList = await op.get(list, { maxRedirects: 0 });
  expect(await opList.text()).not.toContain('Classic Landscape');
});

test('AC-13 upload is typed by leading bytes, not by name or declared type', async () => {
  const admin = await ctx(adminState);
  const res = await admin.post('/api/ticket-assets', {
    multipart: {
      concertId: String(SEED.concertId),
      file: {
        name: 'artwork.png',
        mimeType: 'image/png',
        buffer: Buffer.from('this is definitely not a png'),
      },
    },
  });
  console.log('SNIFF', res.status(), await res.text());
  expect(res.status()).toBe(415);
});

test('AC-9/AC-15/AC-16 a real PNG stores, and the kind follows the path', async () => {
  const admin = await ctx(adminState);
  const res = await admin.post('/api/ticket-assets', {
    multipart: {
      concertId: String(SEED.concertId),
      file: { name: '../../../etc/passwd.png', mimeType: 'application/octet-stream', buffer: PNG },
    },
  });
  const body = await res.json();
  console.log('UPLOAD', res.status(), JSON.stringify(body));
  expect(res.status()).toBe(200);
  // AC-14: the stored path is opaque and never derived from the filename.
  expect(body.path).toMatch(/^concerts\/1\/[0-9a-f-]{36}\.png$/);
  expect(body.kind).toBe('IMAGE');

  const fetched = await admin.get(`/api/ticket-assets/${body.path}`);
  expect(fetched.status()).toBe(200);
  expect(fetched.headers()['content-type']).toBe('image/png');
});

test('AC-18 asset fetch refuses a path climbing out of the store', async () => {
  const admin = await ctx(adminState);
  for (const p of [
    '/api/ticket-assets/..%2f..%2f..%2fetc%2fpasswd',
    '/api/ticket-assets/../../../etc/passwd.png',
    '/api/ticket-assets/concerts/../../secret.png',
  ]) {
    const res = await admin.get(p);
    console.log('TRAVERSAL', p, res.status());
    expect(res.status()).toBe(404);
  }
});

test('AC-3/AC-5/AC-8/AC-31 hostile layouts at the preview boundary', async () => {
  const admin = await ctx(adminState);
  const base = { concertId: SEED.concertId, showId: SEED.show1, subject: 'FIRST' as const };
  const cases: [string, unknown][] = [
    ['unknown element type', { ...layout, elements: [{ ...layout.elements[0], type: 'VIDEO' }] }],
    [
      'free-typed binding',
      { ...layout, elements: [{ ...layout.elements[0], binding: 'attendee.secret_notes' }] },
    ],
    ['negative width', { ...layout, elements: [{ ...layout.elements[0], w: -5 }] }],
    ['string x', { ...layout, elements: [{ ...layout.elements[0], x: "1; drop table attendees" }] }],
    [
      'one megabyte of text',
      {
        ...layout,
        elements: [{ ...layout.elements[0], binding: null, text: 'x'.repeat(1024 * 1024) }],
      },
    ],
    [
      'five thousand elements',
      {
        ...layout,
        elements: Array.from({ length: 5000 }, (_, i) => ({
          ...layout.elements[0],
          id: `el_${i}`,
        })),
      },
    ],
    ['canvas missing', { elements: layout.elements }],
    ['sql metacharacters in a binding', { ...layout, elements: [{ ...layout.elements[0], binding: "'; drop table attendees;--" }] }],
  ];

  for (const [label, l] of cases) {
    const started = Date.now();
    const res = await admin.post('/api/tickets/preview', { data: { ...base, layout: l }, timeout: 60_000 });
    const ms = Date.now() - started;
    const body = res.headers()['content-type']?.includes('json') ? await res.text() : '<pdf>';
    console.log(`HOSTILE ${label}: ${res.status()} in ${ms}ms ${body.slice(0, 160)}`);
    expect(res.status(), label).toBeLessThan(500);
    expect(ms, label).toBeLessThan(30_000);
  }

  // Nothing was written and the attendees are still there.
  const [{ count }] = await sql<{ count: string }[]>`select count(*)::text from attendees`;
  expect(count).toBe('3');
});

test('AC-29/AC-30 the draft preview renders the unsaved layout and reports what it clipped', async () => {
  const admin = await ctx(adminState);
  const before = await sql`select layout from ticket_templates where id = ${templateId}`;

  const tight = {
    canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
    elements: [
      {
        id: 'el_name',
        type: 'TEXT',
        binding: 'attendee.full_name',
        x: 10,
        y: 10,
        w: 40,
        h: 12,
        font_size: 22,
        max_lines: 1,
        overflow: 'CLIP',
      },
    ],
  };
  const res = await admin.post('/api/tickets/preview', {
    data: {
      concertId: SEED.concertId,
      showId: SEED.show1,
      subject: 'LONGEST_NAME',
      layout: tight,
    },
  });
  console.log('CLIP', res.status(), res.headers()['x-ticket-truncated'], res.headers()['x-ticket-skipped']);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect(JSON.parse(res.headers()['x-ticket-truncated'])).toContain('el_name');

  const after = await sql`select layout from ticket_templates where id = ${templateId}`;
  expect(JSON.stringify(after[0].layout)).toBe(JSON.stringify(before[0].layout));
});

test('the preview route renders a date-bound layout (AC-45 is proved in FLOW-10)', async () => {
  const admin = await ctx(adminState);
  const withDate = {
    canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
    elements: [
      {
        id: 'el_when',
        type: 'TEXT',
        binding: 'show.starts_at',
        format: 'HH:mm',
        x: 10,
        y: 10,
        w: 300,
        h: 30,
        font_size: 20,
      },
    ],
  };
  const res = await admin.post('/api/tickets/preview', {
    data: { concertId: SEED.concertId, showId: SEED.show1, subject: 'FIRST', layout: withDate },
  });
  expect(res.status()).toBe(200);
  const pdf = Buffer.from(await res.body());
  writeFileSync('/tmp/qa2-tz.pdf', pdf);
  console.log('TZ pdf bytes', pdf.byteLength);
});

test('AC-46 nothing in this module touches qr_token', async () => {
  // The seed leaves tokens unminted; give the party real ones, then exercise
  // the module's write paths and prove they are untouched.
  await sql`update attendees set qr_token = 'tok-' || id || '-cccccccccccccccc'`;
  const before = await sql<{ id: number; qr_token: string }[]>`
    select id, qr_token from attendees order by id`;

  const admin = await ctx(adminState);
  const upload = await admin.post('/api/ticket-assets', {
    multipart: {
      concertId: String(SEED.concertId),
      file: { name: 'a.png', mimeType: 'image/png', buffer: PNG },
    },
  });
  expect(upload.status()).toBe(200);
  const preview = await admin.post('/api/tickets/preview', {
    data: {
      concertId: SEED.concertId,
      showId: SEED.show1,
      subject: 'LONGEST_NAME',
      layout,
      backgroundAssetPath: (await upload.json()).path,
    },
  });
  expect(preview.status()).toBe(200);

  const after = await sql<{ id: number; qr_token: string }[]>`
    select id, qr_token from attendees order by id`;
  console.log('QR TOKENS', JSON.stringify(after));
  expect(after).toEqual(before);
});
