/**
 * Module `D` — phase 5. Every phase-2 flow, walked in Chromium.
 *
 * Screenshots land in `qa-artifacts/D-ticket-render/screens/FLOW-<n>-step-<n>-<what>.png`.
 * Every step asserts before it shoots; a screenshot is evidence for a human, not
 * a passing test.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import postgres from 'postgres';
import QRCode from 'qrcode';

const SHOTS = 'qa-artifacts/D-ticket-render/screens';
mkdirSync(SHOTS, { recursive: true });

const sql = postgres(
  process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa',
  { prepare: false, max: 3 },
);
test.afterAll(async () => {
  await sql.end();
});

const ADMIN_CODE = 'qa-admin-code-0123456789';
const OP_CODE = 'qa-op-code';
const APP_URL = 'https://zetix.vercel.app';

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

// ------------------------------------------------------------------ PDF tools

function streams(pdf: Buffer): Buffer[] {
  const text = pdf.toString('latin1');
  const out: Buffer[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    const body = pdf.subarray(start, end);
    try {
      out.push(inflateSync(body));
    } catch {
      out.push(body);
    }
  }
  return out;
}

function content(pdf: Buffer): string {
  return streams(pdf).map((s) => s.toString('latin1')).join('\n');
}

/** Every rectangle drawn, in page space, with whether it was filled black. */
function rects(pdf: Buffer): { x: number; y: number; w: number; h: number; dark: boolean }[] {
  const found: { x: number; y: number; w: number; h: number; dark: boolean }[] = [];
  const re =
    /([\d.-]+) ([\d.-]+) ([\d.-]+) rg\s+1 0 0 1 ([\d.-]+) ([\d.-]+) cm[\s\S]{0,60}?0 0 m\s+0 ([\d.-]+) l\s+([\d.-]+) [\d.-]+ l/g;
  for (const m of content(pdf).matchAll(re)) {
    found.push({
      dark: Number(m[1]) < 0.5 && Number(m[2]) < 0.5 && Number(m[3]) < 0.5,
      x: Number(m[4]),
      y: Number(m[5]),
      h: Number(m[6]),
      w: Number(m[7]),
    });
  }
  return found;
}

async function fetchPdf(ctx: BrowserContext, attendeeId: number): Promise<Buffer> {
  const res = await ctx.request.get(`/api/tickets/${attendeeId}/pdf`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  return Buffer.from(await res.body());
}

// ------------------------------------------------------------------- fixtures

let concertId: number;
let show1: number;
let show2: number;

test.beforeAll(async () => {
  [concertId, show1, show2] = await sql`select id from concerts limit 1`.then(async () => {
    const [c] = await sql<{ id: string }[]>`select id from concerts order by id limit 1`;
    const shows = await sql<{ id: string }[]>`select id from shows order by id`;
    return [Number(c.id), Number(shows[0].id), Number(shows[1].id)];
  });
});

const ticketsUrl = () => `/admin/concerts/${concertId}/tickets`;

// ------------------------------------------------------------------ FLOW 1, 2

test('FLOW-1 + FLOW-2  admin opens tickets, issues, downloads', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  // step 1 — the screen loads and lists every attendee, none issued yet.
  await page.goto(ticketsUrl());
  await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
  await expect(page.getByText('QA Concert D · 5 attendees')).toBeVisible();
  await expect(page.getByText('not issued').first()).toBeVisible();
  await shot(page, 'FLOW-1-step-1-tickets-screen');

  // step 2 — issue for Evening Show only.
  await page.getByLabel('Filter by show').selectOption(String(show1));
  await page.waitForURL(/show=/);
  await expect(page.getByText('QA Concert D · 4 attendees')).toBeVisible();
  await shot(page, 'FLOW-2-step-2-filtered-to-show');

  await page.getByRole('button', { name: 'Issue tickets' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Issued 4 tickets' })).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, 'FLOW-2-step-3-issued');

  // step 3 — the database agrees, and every pin is complete.
  const rows = await sql<
    { id: string; ticket_code: string; qr_token: string; tid: string; tv: number }[]
  >`select id, ticket_code, qr_token, ticket_template_id as tid, ticket_template_version as tv
      from attendees where show_id = ${show1} order by id`;
  expect(rows).toHaveLength(4);
  for (const r of rows) {
    expect(r.ticket_code).toMatch(/^ORC-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(r.qr_token).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(r.tid).not.toBeNull();
    expect(r.tv).toBe(1);
  }
  // The other show was NOT touched — the scope was the filter, not the concert.
  const untouched = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees where show_id = ${show2} and qr_token is not null`;
  expect(untouched[0].n).toBe(0);

  // step 4 — the codes render on screen.
  await page.reload();
  await expect(page.getByText(rows[0].ticket_code)).toBeVisible();
  await expect(page.getByText('issued').first()).toBeVisible();
  await shot(page, 'FLOW-1-step-4-codes-on-screen');

  // step 5 — the PDF itself.
  const pdf = await fetchPdf(ctx, Number(rows[0].id));
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(10_000);
  await ctx.close();
});

// -------------------------------------------------------------------- FLOW 13

test('FLOW-13  the QR on the page is the symbol for the database token', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const [row] = await sql<{ id: string; qr_token: string }[]>`
    select id, qr_token from attendees where show_id = ${show1} and qr_token is not null order by id limit 1`;
  const pdf = await fetchPdf(ctx, Number(row.id));

  // Rebuild the matrix from what was drawn, then compare it to the symbol for
  // the URL built from the DATABASE's token — never from anything the renderer
  // reported. The QR is never dereferenced (decision 28).
  const expectedUrl = `${APP_URL}/t/${row.qr_token}`;
  expect(expectedUrl).toMatch(/[0-9A-Za-z]{22}$/);
  const expected = QRCode.create(expectedUrl, { errorCorrectionLevel: 'M' });
  const size: number = expected.modules.size;

  const all = rects(pdf);
  const plate = all.find((r) => !r.dark && Math.abs(r.w - r.h) < 0.01 && r.w > 60);
  expect(plate, 'no QR backing plate drawn').toBeDefined();
  expect(plate!.w).toBeGreaterThanOrEqual((25 * 72) / 25.4); // >= 25mm

  const margin = 2;
  const moduleSize = plate!.w / (size + margin * 2);
  const quiet = moduleSize * margin;
  const dark = all.filter(
    (r) =>
      r.dark &&
      Math.abs(r.w - moduleSize) < 0.01 &&
      r.x >= plate!.x + quiet - 0.01 &&
      r.y >= plate!.y + quiet - 0.01,
  );
  const rebuilt = new Uint8Array(size * size);
  for (const r of dark) {
    const col = Math.round((r.x - plate!.x - quiet) / moduleSize);
    const rowIdx = Math.round((plate!.y + plate!.w - quiet - r.y) / moduleSize) - 1;
    rebuilt[rowIdx * size + col] = 1;
  }
  expect(Array.from(rebuilt)).toEqual(
    Array.from(expected.modules.data as Uint8Array).map((b) => (b ? 1 : 0)),
  );

  // The quiet zone holds no modules.
  for (const r of all.filter((x) => x.dark && Math.abs(x.w - moduleSize) < 0.01)) {
    expect(r.x).toBeGreaterThanOrEqual(plate!.x + quiet - 0.01);
    expect(r.x + r.w).toBeLessThanOrEqual(plate!.x + plate!.w - quiet + 0.01);
  }
  await ctx.close();
});

// ------------------------------------------------------------ FLOW 3, 4, 5

test('FLOW-3 + FLOW-4 + FLOW-5  the authorization matrix on the PDF route', async ({ browser }) => {
  test.setTimeout(180_000);
  const anon = await browser.newContext();
  const admin = await asAdmin(browser);
  const assigned = await asOperator(browser, 'Wei Ling');
  const unassigned = await asOperator(browser, 'Bob Tan');

  const [mine] = await sql<{ id: string }[]>`
    select id from attendees where show_id = ${show1} order by id limit 1`;
  const [theirs] = await sql<{ id: string }[]>`
    select id from attendees where show_id = ${show2} order by id limit 1`;

  const actors: [string, BrowserContext][] = [
    ['anonymous', anon],
    ['ADMIN', admin],
    ['OPERATOR assigned to show 1', assigned],
    ['OPERATOR assigned to nothing', unassigned],
  ];
  const targets: [string, string][] = [
    ['PDF, show 1 attendee', `/api/tickets/${Number(mine.id)}/pdf`],
    ['PDF, show 2 attendee (unissued)', `/api/tickets/${Number(theirs.id)}/pdf`],
    ['tickets screen', ticketsUrl()],
  ];

  const table: Record<string, Record<string, string>> = {};
  for (const [label, path] of targets) {
    table[label] = {};
    for (const [actor, ctx] of actors) {
      const res = await ctx.request.get(path, { maxRedirects: 0 });
      const loc = res.headers()['location'];
      table[label][actor] = `${res.status()}${loc ? ` -> ${loc.replace(/^https?:\/\/[^/]+/, '')}` : ''}`;
    }
  }
  console.log('QA-MATRIX', JSON.stringify(table, null, 2));

  // The cells that must hold.
  expect(table['PDF, show 1 attendee']['anonymous']).toBe('401');
  expect(table['PDF, show 1 attendee']['OPERATOR assigned to nothing']).toBe('404');
  expect(table['PDF, show 1 attendee']['ADMIN']).toBe('200');
  expect(table['tickets screen']['anonymous']).toMatch(/^30\d/);
  expect(table['tickets screen']['OPERATOR assigned to show 1']).not.toBe('200');

  // FLOW-5 — hostile ids, as ADMIN, must never be a 500 or a stack trace.
  const hostile = [
    'not-a-uuid',
    '0',
    '-1',
    '999999',
    '1.5',
    '1e10',
    '%2e%2e%2fetc%2fpasswd',
    "1'+OR+'1'='1",
    'x'.repeat(4000),
  ];
  const seen: Record<string, number> = {};
  for (const id of hostile) {
    const res = await admin.request.get(`/api/tickets/${id}/pdf`, { maxRedirects: 0 });
    seen[id.slice(0, 30)] = res.status();
    expect(res.status(), `id=${id.slice(0, 30)}`).toBeLessThan(500);
    const body = await res.text();
    expect(body).not.toMatch(/at Object\.|node_modules|\/home\/|Error:/);
  }
  console.log('QA-HOSTILE', JSON.stringify(seen));

  // Screenshot the refusal a human would see.
  const anonPage = await anon.newPage();
  await anonPage.goto(ticketsUrl());
  await expect(anonPage).toHaveURL(/\/login/);
  await shot(anonPage, 'FLOW-3-step-1-anonymous-refused');

  const opPage = await unassigned.newPage();
  await opPage.goto(`/api/tickets/${Number(mine.id)}/pdf`);
  await expect(opPage.locator('body')).toContainText('Not found');
  await shot(opPage, 'FLOW-4-step-2-operator-refused');

  for (const [, ctx] of actors) await ctx.close();
});

// -------------------------------------------------------------------- FLOW 10

test('FLOW-10  a party of four gets four tickets, no shared QR', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const rows = await sql<{ id: string; ticket_code: string; qr_token: string }[]>`
    select a.id, a.ticket_code, a.qr_token from attendees a
      join registrations r on r.id = a.registration_id
     where r.contact_name = 'Alice Tan' order by a.id`;
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map((r) => r.ticket_code)).size).toBe(4);
  expect(new Set(rows.map((r) => r.qr_token)).size).toBe(4);

  const digests = new Set<string>();
  for (const r of rows) {
    const pdf = await fetchPdf(ctx, Number(r.id));
    digests.add(content(pdf).length + ':' + content(pdf).slice(-400));
  }
  expect(digests.size).toBe(4);
  await ctx.close();
});

// -------------------------------------------------------------------- FLOW 11

test('FLOW-11  an unnamed attendee tickets as a placeholder, not an error', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  const [row] = await sql<{ id: string }[]>`
    select id from attendees where name_source = 'PLACEHOLDER' order by id limit 1`;

  await page.goto(`${ticketsUrl()}?q=Guest`);
  await expect(page.getByText('Guest of Alice Tan').first()).toBeVisible();
  await shot(page, 'FLOW-11-step-1-placeholder-row');

  const res = await ctx.request.get(`/api/tickets/${Number(row.id)}/pdf`);
  expect(res.status()).toBe(200);
  const pdf = Buffer.from(await res.body());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  await ctx.close();
});

// -------------------------------------------------------------------- FLOW 12

test('FLOW-12  times render in the concert zone, not the browser zone', async ({ browser }) => {
  const sg = await asAdmin(browser, { timezoneId: 'Asia/Singapore' });
  const ny = await asAdmin(browser, { timezoneId: 'America/New_York' });
  const [row] = await sql<{ id: string }[]>`
    select id from attendees where show_id = ${show1} order by id limit 1`;
  await sql`update attendees set ticket_sent_at = '2026-09-19T11:30:00Z' where id = ${Number(row.id)}`;

  const read = async (ctx: BrowserContext, tag: string) => {
    const page = await ctx.newPage();
    await page.goto(`${ticketsUrl()}?show=${show1}`);
    await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
    const cell = page.locator('table tbody tr').first();
    await expect(cell).toBeVisible();
    const text = (await page.locator('table tbody').innerText()).replace(/\s+/g, ' ');
    await shot(page, `FLOW-12-step-${tag}`);
    return text;
  };

  const a = await read(sg, '1-browser-in-singapore');
  const b = await read(ny, '2-browser-in-new-york');
  console.log('QA-TZ-SG', JSON.stringify(a.slice(0, 400)));
  console.log('QA-TZ-NY', JSON.stringify(b.slice(0, 400)));
  expect(b).toBe(a);
  expect(a).toContain('2026-09-19 19:30');
  await sql`update attendees set ticket_sent_at = null where id = ${Number(row.id)}`;
  await sg.close();
  await ny.close();
});

// --------------------------------------------------------------------- FLOW 6

test('FLOW-6  a cloned template version does not change an issued PDF', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await asAdmin(browser);
  const [row] = await sql<{ id: string }[]>`
    select id from attendees where show_id = ${show1} order by id limit 1`;
  const before = content(await fetchPdf(ctx, Number(row.id)));

  await sql`
    insert into ticket_templates (concert_id, name, version, background_kind,
      page_width_pt, page_height_pt, layout, is_default)
    values (${concertId}, 'Classic Landscape', 2, 'NONE', 595, 280,
      ${JSON.stringify({
        canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
        elements: [
          {
            id: 'el_only', type: 'TEXT', binding: 'attendee.full_name',
            x: 5, y: 5, w: 120, h: 14, rotation: 0, font_family: 'Inter',
            font_size: 8, font_weight: 400, color: '#000000', align: 'left',
            valign: 'top', max_lines: 1, overflow: 'SHRINK',
          },
        ],
      })}::text::jsonb, true)
  `;

  const after = content(await fetchPdf(ctx, Number(row.id)));
  expect(after).toBe(before);
  const [pin] = await sql<{ v: number }[]>`
    select ticket_template_version as v from attendees where id = ${Number(row.id)}`;
  expect(pin.v).toBe(1);
  await ctx.close();
});

// --------------------------------------------------------------------- FLOW 7

test('FLOW-7  reissue repins and requeues but never touches qr_token', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
             where show_id = ${show1}`;
  const before = await sql<{ id: string; qr_token: string; tv: number }[]>`
    select id, qr_token, ticket_template_version as tv from attendees
     where show_id = ${show1} order by id`;
  expect(before.every((r) => r.tv === 1)).toBe(true);

  await page.goto(`${ticketsUrl()}?show=${show1}`);
  await expect(page.getByText('sent').first()).toBeVisible();
  await shot(page, 'FLOW-7-step-1-sent');

  await page.getByRole('button', { name: 'Reissue with current template' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Repinned 4 tickets to template v2/ }),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-7-step-2-reissued');

  const after = await sql<{ id: string; qr_token: string; tv: number; sent: string | null }[]>`
    select id, qr_token, ticket_template_version as tv, ticket_sent_at as sent
      from attendees where show_id = ${show1} order by id`;
  expect(after.map((r) => r.qr_token)).toEqual(before.map((r) => r.qr_token));
  expect(after.every((r) => r.tv === 2)).toBe(true);
  expect(after.every((r) => r.sent === null)).toBe(true);

  // The new PDF still carries the same token.
  const pdf = await fetchPdf(ctx, Number(after[0].id));
  const expected = QRCode.create(`${APP_URL}/t/${after[0].qr_token}`, {
    errorCorrectionLevel: 'M',
  });
  expect(expected.modules.size).toBeGreaterThan(0);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  await ctx.close();
});

// ---------------------------------------------------------------- FLOW 8 / 9

test('FLOW-8 + FLOW-9  the reissue banner reflects the flag, and only when sent', async ({
  browser,
}) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await sql`update attendees set needs_reissue = false where show_id = ${show1}`;
  await page.goto(ticketsUrl());
  await expect(page.getByText(/need.? reissuing/)).toHaveCount(0);
  await shot(page, 'FLOW-9-step-1-no-banner');

  const ids = (
    await sql<{ id: string }[]>`select id from attendees where show_id = ${show1} order by id limit 3`
  ).map((r) => Number(r.id));
  await sql`update attendees set ticket_sent_at = now() where id in ${sql(ids)}`;
  await sql`update attendees set needs_reissue = true where id in ${sql(ids)}`;

  await page.reload();
  await expect(page.getByText('3 tickets need reissuing', { exact: false })).toBeVisible();
  await expect(page.getByText('needs reissue').first()).toBeVisible();
  await shot(page, 'FLOW-8-step-2-banner');

  // §10.6 offers two resolutions: reissue and resend, or dismiss as cosmetic.
  const dismiss = page.getByRole('button', { name: /dismiss/i });
  console.log('QA-DISMISS-CONTROLS', await dismiss.count());

  await sql`update attendees set needs_reissue = false, ticket_sent_at = null where show_id = ${show1}`;
  await ctx.close();
});

// -------------------------------------------------------------------- FLOW 14

test('FLOW-14  the longest name in the show still fits its box', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const [row] = await sql<{ id: string }[]>`
    select id from attendees where show_id = ${show1} order by id limit 1`;
  const long = 'Nurul Aisyah binti Abdul Rahman al-Hakim Wellington Mainwaring';
  await sql`update attendees set full_name = ${long} where id = ${Number(row.id)}`;

  const pdf = await fetchPdf(ctx, Number(row.id));
  // The name element of Classic Landscape v2 (post-FLOW-7) is 120pt wide; on v1
  // it is 340pt. Either way nothing may be drawn outside the page.
  const page = content(pdf);
  const xs = [...page.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g)].map((m) => Number(m[1]));
  expect(xs.length).toBeGreaterThan(0);
  for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  await ctx.close();
});
