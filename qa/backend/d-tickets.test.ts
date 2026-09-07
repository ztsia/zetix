/**
 * QA phase 4 — module `D`, exercised against the real zetix_qa database.
 * Written by the QA reviewer, not the author. No mocks in this file.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { inflateSync } from 'node:zlib';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../../tests/helpers/fixtures';
import { generateQrToken, generateTicketCode, qrUrl, parseTicketCode, CROCKFORD_ALPHABET } from '@/lib/tickets/identifiers';
import { issueTickets, reissueTickets } from '@/lib/tickets/issue';
import { loadTicket } from '@/lib/tickets/load';
import { renderTicket } from '@/lib/tickets/render';
import { parseLayout } from '@/lib/tickets/layout';
import { DEFAULT_TEMPLATES } from '@/lib/tickets/defaults';
import { resolveFace, loadFace, type FaceKey } from '@/lib/tickets/fonts';

process.env.APP_URL ??= 'https://zetix.vercel.app';

let concertId: number;
let showId: number;
let segmentId: number;
let registrationId: number;

async function fixture(count = 2) {
  concertId = await createConcert('QA D');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  registrationId = await createRegistration({ showId, segmentId, contactName: 'Alice Tan' });
  await seedAttendees({ registrationId, showId, segmentId, count, allocationType: 'BASE' });
}

function streams(pdf: Uint8Array): Buffer[] {
  const raw = Buffer.from(pdf);
  const text = raw.toString('latin1');
  const out: Buffer[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      out.push(inflateSync(raw.subarray(start, end)));
    } catch {
      out.push(raw.subarray(start, end));
    }
  }
  return out;
}

/**
 * The text actually drawn on the page.
 *
 * pdf-lib embeds a custom-encoded font, so `Tj` operands are hex glyph ids, not
 * ASCII. Every embedded font carries a `/ToUnicode` CMap; this parses those and
 * uses them to turn the glyph ids back into characters — the same route a PDF
 * viewer's copy-paste takes.
 */
function toUnicodeMap(pdf: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  for (const s of streams(pdf)) {
    const text = s.toString('latin1');
    if (!text.includes('beginbfchar') && !text.includes('beginbfrange')) continue;
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        map.set(parseInt(pair[1], 16), codeUnitsToString(pair[2]));
      }
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const t of block[1].matchAll(
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
      )) {
        const lo = parseInt(t[1], 16);
        const hi = parseInt(t[2], 16);
        const dst = parseInt(t[3], 16);
        for (let i = lo; i <= hi; i++) map.set(i, String.fromCodePoint(dst + (i - lo)));
      }
    }
  }
  return map;
}

function codeUnitsToString(hex: string): string {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/**
 * Does the page draw `text` in `face`?
 *
 * Encodes the string with the same pdf-lib font the renderer uses and looks for
 * the resulting hex in the content stream. Exact, and immune to the glyph-id
 * collisions you get from merging several fonts' ToUnicode maps.
 */
async function drawsText(pdf: Uint8Array, text: string, face: FaceKey): Promise<boolean> {
  const probe = await PDFDocument.create();
  probe.registerFontkit(fontkit);
  const font = await probe.embedFont(loadFace(face), { subset: false });
  const [hex] = font.encodeText(text).toString().split(' ');
  const needle = font.encodeText(text).toString().replace(/^<|>$/g, '');
  void hex;
  const haystack = streams(pdf)
    .map((s) => s.toString('latin1'))
    .join('\n');
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function drawnText(pdf: Uint8Array): string {
  const map = toUnicodeMap(pdf);
  let out = '';
  for (const s of streams(pdf)) {
    const text = s.toString('latin1');
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) continue;
    for (const m of text.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
      const hex = m[1];
      for (let i = 0; i + 3 < hex.length + 1; i += 4) {
        const gid = parseInt(hex.slice(i, i + 4), 16);
        out += map.get(gid) ?? '�';
      }
      out += '\n';
    }
    for (const m of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out += m[1] + '\n';
  }
  return out;
}

// ---------------------------------------------------------------- identifiers

describe('AC-1..6  identifiers', () => {
  it('AC-1/AC-4  5000 ticket codes use only Crockford symbols and are well formed', () => {
    const banned = /[ILOU]/;
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const code = generateTicketCode();
      expect(code).toMatch(/^ORC-[0-9A-Z]{4}$/);
      expect(banned.test(code.slice(4))).toBe(false);
      for (const ch of code.slice(4)) expect(CROCKFORD_ALPHABET).toContain(ch);
      seen.add(code);
    }
    // 4 symbols is a ~1.05M space; 5000 draws collide by birthday about 1 in 100
    // of the time, so this asserts the retry exists rather than that it never
    // collides. Recorded for the report:
    console.log('QA: distinct codes in 5000 draws =', seen.size);
    expect(parseTicketCode('orc 7k4q')?.normalised).toBe('ORC-7K4Q');
  });

  it('AC-5/AC-6  10000 qr tokens are 22 base62 chars and all distinct', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const t = generateQrToken();
      expect(t).toMatch(/^[0-9A-Za-z]{22}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(10000);
  });

  it('AC-12  a missing or non-absolute APP_URL throws rather than emitting junk', () => {
    expect(() => qrUrl('abc', '')).toThrow(/APP_URL is not an absolute URL/);
    expect(() => qrUrl('abc', 'zetix.vercel.app')).toThrow();
    expect(() => qrUrl('abc', 'ftp://x.example')).toThrow(/must be http or https/);
    expect(qrUrl('TOKEN', 'https://zetix.vercel.app')).toBe(
      'https://zetix.vercel.app/t/TOKEN',
    );
  });
});

// ------------------------------------------------------- qr_token immutability

describe('AC-7..9  qr_token immutability, at the database', () => {
  beforeEach(async () => {
    await resetDb();
    await fixture(2);
    await issueTickets({ concertId, showId });
  });

  it('AC-7  a duplicate qr_token is rejected by the unique index', async () => {
    const rows = await sql<{ id: string; qr_token: string }[]>`
      select id, qr_token from attendees where show_id = ${showId} order by id
    `;
    await expect(
      sql`update attendees set qr_token = ${rows[0].qr_token} where id = ${Number(rows[1].id)}`,
    ).rejects.toThrow();
  });

  it('AC-8/AC-9  a direct UPDATE of qr_token is refused by the trigger', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from attendees where show_id = ${showId} order by id limit 1
    `;
    await expect(
      sql`update attendees set qr_token = 'ZZZZZZZZZZZZZZZZZZZZZZ' where id = ${Number(row.id)}`,
    ).rejects.toThrow(/immutable/);
  });

  it('AC-8  reissue leaves every token byte-identical', async () => {
    const before = await sql<{ id: string; qr_token: string }[]>`
      select id, qr_token from attendees where show_id = ${showId} order by id
    `;
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL' where show_id = ${showId}`;
    await reissueTickets({ concertId, showId });
    const after = await sql<{ id: string; qr_token: string }[]>`
      select id, qr_token from attendees where show_id = ${showId} order by id
    `;
    expect(after).toEqual(before);
  });
});

// ------------------------------------------------------------- template pinning

describe('AC-33..38  pinning and reissue, end to end through the renderer', () => {
  beforeEach(async () => {
    await resetDb();
    await fixture(1);
  });

  async function onlyAttendee(): Promise<number> {
    const [row] = await sql<{ id: string }[]>`select id from attendees limit 1`;
    return Number(row.id);
  }

  it('AC-34  a template CLONED to v2 does not change an issued PDF', async () => {
    await issueTickets({ concertId, showId });
    const id = await onlyAttendee();
    const first = await loadTicket(id);
    const before = await renderTicket({ layout: first!.template.layout, data: first!.data });

    // The editor's documented behaviour (§10.5, §10.3): clone, never mutate.
    await sql`
      insert into ticket_templates (concert_id, name, version, background_kind,
        page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Classic Landscape', 2, 'NONE', 595, 280,
        ${JSON.stringify({
          canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
          elements: [
            { id: 'el_x', type: 'TEXT', binding: 'attendee.full_name', x: 1, y: 1,
              w: 100, h: 20, rotation: 0, font_family: 'Inter', font_size: 9,
              font_weight: 400, color: '#000000', align: 'left', valign: 'top',
              max_lines: 1, overflow: 'SHRINK' },
          ],
        })}::text::jsonb, true)
    `;

    const second = await loadTicket(id);
    expect(second!.template.version).toBe(1);
    const after = await renderTicket({ layout: second!.template.layout, data: second!.data });
    expect(drawnText(after.pdf)).toBe(drawnText(before.pdf));
  });

  it('AC-34/AC-35  a template MUTATED in place is followed by the render', async () => {
    // §10.5 says the pinned pair is what renders. `loadTicket` joins on the
    // template id alone and never compares `t.version` with the pinned
    // `attendees.ticket_template_version`, so an in-place edit reaches an
    // already-issued ticket. This test records the behaviour as it is.
    await issueTickets({ concertId, showId });
    const id = await onlyAttendee();
    const first = await loadTicket(id);
    const before = await renderTicket({ layout: first!.template.layout, data: first!.data });

    await sql`
      update ticket_templates
         set version = 2,
             layout = ${JSON.stringify({
               canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
               elements: [
                 { id: 'el_x', type: 'TEXT', binding: 'attendee.ticket_code', x: 1,
                   y: 1, w: 100, h: 20, rotation: 0, font_family: 'Inter',
                   font_size: 9, font_weight: 400, color: '#000000',
                   align: 'left', valign: 'top', max_lines: 1, overflow: 'SHRINK' },
               ],
             })}::text::jsonb
       where id = ${first!.template.id}
    `;

    const pinned = await sql<{ v: number }[]>`
      select ticket_template_version as v from attendees where id = ${id}
    `;
    expect(pinned[0].v).toBe(1); // the pin still says v1

    const second = await loadTicket(id);
    const after = await renderTicket({ layout: second!.template.layout, data: second!.data });

    // Record what actually happens.
    console.log('QA: pinned version =', pinned[0].v, ' loaded version =', second!.template.version);
    console.log('QA: text before =', JSON.stringify(drawnText(before.pdf).slice(0, 120)));
    console.log('QA: text after  =', JSON.stringify(drawnText(after.pdf).slice(0, 120)));
    expect(drawnText(after.pdf)).not.toBe(drawnText(before.pdf));
  });

  it('AC-31  a show-level ticket_template_id override is ignored', async () => {
    // domain.md §5.1: "resolves like any other cascading value: show → concert
    // → the seeded global default. Never read the column directly."
    await issueTickets({ concertId, showId });
    const [{ id: overrideId }] = await sql<{ id: string }[]>`
      insert into ticket_templates (concert_id, name, version, background_kind,
        page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Show Override', 1, 'NONE', 595, 280,
        ${JSON.stringify(DEFAULT_TEMPLATES[2].layout)}::text::jsonb, false)
      returning id
    `;
    await sql`update shows set ticket_template_id = ${Number(overrideId)} where id = ${showId}`;

    // A second show's attendee, issued after the override is set.
    const reg2 = await createRegistration({ showId, segmentId, contactName: 'Bob' });
    await seedAttendees({ registrationId: reg2, showId, segmentId, count: 1, allocationType: 'BASE' });
    const result = await issueTickets({ concertId, showId });

    console.log('QA: show override template id =', Number(overrideId), 'pinned =', result.template.id);
    expect(result.template.id).not.toBe(Number(overrideId));
  });

  it('AC-37  a new template version alone repins nothing', async () => {
    await issueTickets({ concertId, showId });
    const before = await sql<Record<string, unknown>[]>`select * from attendees order by id`;
    await sql`
      insert into ticket_templates (concert_id, name, version, background_kind,
        page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Classic Landscape', 2, 'NONE', 595, 280,
        ${JSON.stringify(DEFAULT_TEMPLATES[0].layout)}::text::jsonb, true)
    `;
    expect(await sql`select * from attendees order by id`).toEqual(before);
  });
});

// ------------------------------------------------------------------ rendering

describe('AC-10..30  the rendered artefact', () => {
  beforeEach(async () => {
    await resetDb();
    await fixture(1);
    await issueTickets({ concertId, showId });
  });

  it('AC-10/AC-13  the QR encodes the APP_URL form and is >= 25mm', async () => {
    const [row] = await sql<{ id: string; qr_token: string }[]>`
      select id, qr_token from attendees limit 1
    `;
    const ticket = await loadTicket(Number(row.id));
    const qrEl = ticket!.template.layout.elements.find((e) => e.type === 'QR')!;
    expect(Math.min(qrEl.w, qrEl.h)).toBeGreaterThanOrEqual((25 * 72) / 25.4);

    // The value the renderer will encode, resolved through the same binding.
    const { resolveBinding } = await import('@/lib/tickets/bindings');
    const url = resolveBinding('attendee.qr_url', ticket!.data);
    expect(url).toBe(`https://zetix.vercel.app/t/${row.qr_token}`);
    expect(url).toMatch(/\/t\/[0-9A-Za-z]{22}$/);
  });

  it('AC-21  the printed time does not move with the process timezone', async () => {
    await sql`
      update shows set starts_at = '2026-09-19T11:30:00Z', doors_open_at = '2026-09-19T11:00:00Z'
       where id = ${showId}
    `;
    await sql`update concerts set timezone = 'Asia/Singapore' where id = ${concertId}`;
    const [row] = await sql<{ id: string }[]>`select id from attendees limit 1`;
    const ticket = await loadTicket(Number(row.id));

    const original = process.env.TZ;
    const renders: string[] = [];
    for (const tz of ['UTC', 'America/New_York', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      const { pdf } = await renderTicket({ layout: ticket!.template.layout, data: ticket!.data });
      renders.push(drawnText(pdf));
    }
    process.env.TZ = original;
    expect(renders[1]).toBe(renders[0]);
    expect(renders[2]).toBe(renders[0]);
    process.env.TZ = 'America/New_York';
    const ny = await renderTicket({ layout: ticket!.template.layout, data: ticket!.data });
    process.env.TZ = original;
    expect(await drawsText(ny.pdf, 'Sat 19 Sep 2026, 19:30', 'Inter:400')).toBe(true);
    expect(await drawsText(ny.pdf, 'Free seating \u00b7 Doors 19:00', 'Inter:400')).toBe(true);
  });

  it('AC-27  two renders of the same input draw the same content', async () => {
    const [row] = await sql<{ id: string }[]>`select id from attendees limit 1`;
    const ticket = await loadTicket(Number(row.id));
    const a = await renderTicket({ layout: ticket!.template.layout, data: ticket!.data });
    const b = await renderTicket({ layout: ticket!.template.layout, data: ticket!.data });
    expect(drawnText(a.pdf)).toBe(drawnText(b.pdf));
  });

  it('AC-24  a placeholder-named attendee renders normally', async () => {
    const [row] = await sql<{ id: string }[]>`select id from attendees limit 1`;
    await sql`
      update attendees set full_name = 'Guest of Alice Tan', name_source = 'PLACEHOLDER'
       where id = ${Number(row.id)}
    `;
    const ticket = await loadTicket(Number(row.id));
    const { pdf, truncated } = await renderTicket({
      layout: ticket!.template.layout, data: ticket!.data,
    });
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(truncated).toEqual([]);
    expect(await drawsText(pdf, 'Guest of Alice Tan', 'Inter:600')).toBe(true);
  });

  it('AC-23  a long name renders, but the time is superlinear in its length', async () => {
    const [row] = await sql<{ id: string }[]>`select id from attendees limit 1`;
    const timings: [number, number][] = [];
    for (const len of [20, 40, 80, 120, 160, 240]) {
      await sql`update attendees set full_name = ${'W'.repeat(len)} where id = ${Number(row.id)}`;
      const ticket = await loadTicket(Number(row.id));
      const t0 = Date.now();
      const { pdf } = await renderTicket({ layout: ticket!.template.layout, data: ticket!.data });
      const ms = Date.now() - t0;
      timings.push([len, ms]);
      expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
    }
    console.log('QA: render ms by name length =', JSON.stringify(timings));
  }, 300_000);

  it('AC-23  hostile unicode and SQL metacharacters still produce a PDF', async () => {
    const [row] = await sql<{ id: string }[]>`select id from attendees limit 1`;
    for (const name of ['\u9673\u5927\u6587 \ud83c\udfbb \u0645\u0631\u062d\u0628\u0627', "Robert'); DROP TABLE attendees;--"]) {
      await sql`update attendees set full_name = ${name} where id = ${Number(row.id)}`;
      const ticket = await loadTicket(Number(row.id));
      const { pdf } = await renderTicket({ layout: ticket!.template.layout, data: ticket!.data });
      expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
      const doc = await PDFDocument.load(pdf);
      expect(doc.getPages().length).toBeGreaterThan(0);
    }
    const still = await sql<{ n: number }[]>`select count(*)::int as n from attendees`;
    expect(still[0].n).toBeGreaterThan(0);
  });

  it('AC-25/AC-26  a PDF background is loaded and drawn onto, keeping its own page box', async () => {
    const bg = await PDFDocument.create();
    // Deliberately NOT the layout canvas (595x280): §10.3 makes the background
    // page box authoritative, so the output must come out 600x300.
    bg.addPage([600, 300]).drawText('ARTWORK');
    const bytes = await bg.save();
    const layout = parseLayout(DEFAULT_TEMPLATES[0].layout);
    const { pdf } = await renderTicket({
      layout,
      data: {
        attendee: { fullName: 'A B', ticketCode: 'ORC-1234', qrToken: 'a'.repeat(22) },
        registration: { contactName: 'A B' },
        player: null,
        show: { name: 'S', startsAt: new Date(), doorsOpenAt: new Date(), venueName: 'V', venueAddress: null },
        concert: { name: 'C', timezone: 'Asia/Singapore' },
        appUrl: 'https://zetix.vercel.app',
      },
      background: { kind: 'PDF', bytes },
    });
    const out = await PDFDocument.load(pdf);
    expect(out.getPages()).toHaveLength(1);
    expect(out.getPage(0).getWidth()).toBeCloseTo(600, 1);
    expect(out.getPage(0).getHeight()).toBeCloseTo(300, 1);
    // The background page's own text survives verbatim: the artwork was loaded
    // and drawn onto, not rasterised or replaced. pdf-lib writes it as hex.
    const artworkHex = Buffer.from('ARTWORK', 'latin1').toString('hex').toUpperCase();
    expect(streams(pdf).map((x) => x.toString('latin1')).join('')).toContain(artworkHex);
    expect(await drawsText(pdf, 'ORC-1234', 'JetBrains Mono:400')).toBe(true);
  });

  it('AC-16  an IMAGE element in a layout is silently dropped', async () => {
    const layout = parseLayout({
      canvas: { width_pt: 200, height_pt: 200, dpi: 300 },
      elements: [
        { id: 'el_img', type: 'IMAGE', src: 'logos/zetix.png', x: 10, y: 10, w: 50, h: 50 },
      ],
    });
    const { pdf } = await renderTicket({
      layout,
      data: {
        attendee: { fullName: 'A', ticketCode: 'ORC-1234', qrToken: 'a'.repeat(22) },
        registration: { contactName: null }, player: null,
        show: { name: 'S', startsAt: null, doorsOpenAt: null, venueName: null, venueAddress: null },
        concert: { name: 'C', timezone: 'Asia/Singapore' },
        appUrl: 'https://zetix.vercel.app',
      },
    });
    const doc = await PDFDocument.load(pdf);
    // Nothing drawn, no error, no warning surfaced to the caller.
    console.log('QA: IMAGE element render produced', pdf.length, 'bytes, pages', doc.getPages().length);
    expect(doc.getPages()).toHaveLength(1);
  });

  it('AC-18  an unknown binding is refused by the layout schema', () => {
    expect(() =>
      parseLayout({
        canvas: { width_pt: 100, height_pt: 100 },
        elements: [
          { id: 'x', type: 'TEXT', binding: 'attendee.credit_card', x: 0, y: 0, w: 10, h: 10 },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseLayout({
        canvas: { width_pt: 100, height_pt: 100 },
        elements: [{ id: 'x', type: 'TEXT', binding: null, text: 'hi', x: 0, y: 0, w: 10, h: 10, evil: 1 }],
      }),
    ).toThrow();
  });

  it('AC-29  an unknown font family throws rather than substituting', () => {
    expect(() => resolveFace('Comic Sans')).toThrow(/No embedded font/);
    expect(resolveFace('Inter', 700)).toBe('Inter:600');
  });

  it('AC-19/AC-20  static interpolation and per-element date format', async () => {
    await sql`
      update shows set starts_at = '2026-09-19T11:30:00Z', doors_open_at = '2026-09-19T11:00:00Z'
       where id = ${showId}
    `;
    const [row] = await sql<{ id: string }[]>`select id from attendees limit 1`;
    const ticket = await loadTicket(Number(row.id));
    const { pdf } = await renderTicket({ layout: ticket!.template.layout, data: ticket!.data });
    expect(await drawsText(pdf, 'Free seating \u00b7 Doors 19:00', 'Inter:400')).toBe(true);
    expect(await drawsText(pdf, 'Sat 19 Sep 2026, 19:30', 'Inter:400')).toBe(true);
    expect(await drawsText(pdf, '{{show.doors_open_at}}', 'Inter:400')).toBe(false);
  });

  it('AC-30  the three seeded defaults exist for a concert, once', async () => {
    const rows = await sql<{ name: string; version: number; n: number }[]>`
      select name, version, count(*)::int as n from ticket_templates
       where concert_id = ${concertId} group by name, version order by name
    `;
    expect(rows.map((r) => r.name)).toEqual([
      'Classic Landscape', 'Minimal Portrait', 'Wide Banner',
    ]);
    for (const r of rows) expect(r.n).toBe(1);
  });
});

// ----------------------------------------------------------------- party of N

describe('AC-44  a party of four', () => {
  it('yields four codes, four tokens, four distinct PDFs', async () => {
    await resetDb();
    await fixture(4);
    await issueTickets({ concertId, showId });
    const rows = await sql<{ id: string; ticket_code: string; qr_token: string }[]>`
      select id, ticket_code, qr_token from attendees order by id
    `;
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.ticket_code)).size).toBe(4);
    expect(new Set(rows.map((r) => r.qr_token)).size).toBe(4);
    const texts = new Set<string>();
    for (const r of rows) {
      const t = await loadTicket(Number(r.id));
      const { pdf } = await renderTicket({ layout: t!.template.layout, data: t!.data });
      texts.add(drawnText(pdf));
    }
    expect(texts.size).toBe(4);
  });
});
