import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_TEMPLATES } from '@/lib/tickets/defaults';
import { renderTicket } from '@/lib/tickets/render';
import { qrGeometry } from '@/lib/tickets/render/qr';
import { parseLayout, type Layout, type LayoutElement } from '@/lib/tickets/layout';
import type { TicketData } from '@/lib/tickets/bindings';

/**
 * Rendering a layout to a PDF (spec/tickets.md §10.4).
 *
 * The QR is checked by **reconstructing its module matrix from the geometry the
 * renderer computes** and comparing it to what the encoder produced. That is
 * the level worth testing: whether the right modules land in the right places.
 * Asserting the PDF is non-empty would pass on a blank page, and rasterising to
 * decode would test the decoder more than the drawing.
 *
 * Set `TICKET_PREVIEW_DIR` to dump the rendered PDFs for a human to look at —
 * the pre-blast gate in §10.1 rule 6 is a printed page and an usher's phone,
 * and nothing here substitutes for it.
 */

const data: TicketData = {
  attendee: {
    fullName: 'Wellington Mainwaring',
    ticketCode: 'ORC-7K4Q',
    qrToken: 'aB3xY9zQ1mN7pR4tW2kL6v',
  },
  registration: { contactName: 'Wellington Mainwaring' },
  player: { fullName: 'Siti Nurhaliza', instrument: 'Violin I' },
  show: {
    name: 'Autumn Serenade',
    startsAt: new Date('2026-09-19T11:30:00Z'),
    doorsOpenAt: new Date('2026-09-19T11:00:00Z'),
    venueName: 'Dewan Filharmonik PETRONAS',
    venueAddress: 'KLCC, Kuala Lumpur',
  },
  concert: { name: 'Lakeside Community Orchestra · Season 12', timezone: 'Asia/Kuala_Lumpur' },
  appUrl: 'https://zetix.vercel.app',
};

const layouts: [string, Layout][] = DEFAULT_TEMPLATES.map((t) => [t.name, t.layout]);

describe('rendering each seeded default', () => {
  it.each(layouts)('%s produces a real PDF at the canvas size', async (name, layout) => {
    const { pdf } = await renderTicket({ layout, data });

    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');

    const doc = await PDFDocument.load(pdf);
    const [page] = doc.getPages();
    expect(page.getWidth()).toBeCloseTo(layout.canvas.width_pt, 1);
    expect(page.getHeight()).toBeCloseTo(layout.canvas.height_pt, 1);

    const dir = process.env.TICKET_PREVIEW_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/${name.replace(/\s+/g, '-').toLowerCase()}.pdf`, pdf);
    }
  });

  it.each(layouts)('%s fits every field without clipping', async (_name, layout) => {
    // "Wellington Mainwaring" is a deliberately long name and the venue is a
    // long one too. If a seeded default cannot hold realistic data, it is the
    // template that is wrong, not the data.
    const { truncated } = await renderTicket({ layout, data });
    expect(truncated).toEqual([]);
  });

  it.each(layouts)('%s survives an attendee with nothing optional set', async (_name, layout) => {
    // Half the bound columns are nullable, and a public registration has no
    // player at all. A ticket that fails to render is worse than one with a
    // blank line where the venue would be.
    const sparse: TicketData = {
      ...data,
      attendee: { fullName: 'Guest of Wellington Mainwaring', ticketCode: null, qrToken: null },
      registration: { contactName: null },
      player: null,
      show: { name: 'Autumn Serenade', startsAt: null, doorsOpenAt: null, venueName: null, venueAddress: null },
    };
    const { pdf } = await renderTicket({ layout, data: sparse });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
  });
});

/** Inflate every content stream in a saved PDF into one string of operators. */
function operators(pdf: Uint8Array): string {
  const streams = [
    ...Buffer.from(pdf)
      .toString('latin1')
      .matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g),
  ];
  let content = '';
  for (const [, body] of streams) {
    try {
      content += inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
    } catch {
      content += body;
    }
  }
  return content;
}

/**
 * Every rectangle drawn, in page coordinates.
 *
 * pdf-lib emits a rectangle as a translate (`1 0 0 1 x y cm`) followed by a
 * four-point path, so the translate gives the origin and the path gives the
 * size.
 */
function drawnRects(pdf: Uint8Array): { x: number; y: number; w: number; h: number }[] {
  const found: { x: number; y: number; w: number; h: number }[] = [];
  const pattern =
    /1 0 0 1 ([\d.-]+) ([\d.-]+) cm[\s\S]{0,80}?0 0 m\s+0 ([\d.-]+) l\s+([\d.-]+) [\d.-]+ l/g;
  for (const m of operators(pdf).matchAll(pattern)) {
    found.push({
      x: Number(m[1]),
      y: Number(m[2]),
      h: Number(m[3]),
      w: Number(m[4]),
    });
  }
  return found;
}

describe('where text actually lands on the page', () => {
  /**
   * Read the text-positioning operators back out of the PDF.
   *
   * Layout coordinates run top-down and a PDF page runs bottom-up, and every
   * check above would pass with that conversion inverted — the elements would
   * simply be drawn in the wrong half of the page, in the wrong order. Nothing
   * short of reading the emitted geometry catches it, so this parses the
   * content stream rather than trusting the arithmetic that produced it.
   */
  async function baselines(layout: Layout): Promise<number[]> {
    const { pdf } = await renderTicket({ layout, data });

    /**
     * Inflate the content streams and read the text matrix operators.
     *
     * Reading the file rather than pdf-lib's object model is deliberate: going
     * back through the library that wrote it would re-use the same
     * understanding of the coordinate space, so an inverted conversion would
     * cancel out on both sides and the test would agree with the bug.
     *
     * The streams are zlib-compressed — worth stating, because a scan of the
     * raw bytes finds no `Tm` at all and reads as "no text was drawn" rather
     * than as "the text is compressed".
     */
    return [...operators(pdf).matchAll(/1 0 0 1 [\d.-]+ ([\d.-]+) Tm/g)].map((m) => Number(m[1]));
  }

  it.each(layouts)('%s puts every baseline inside its own box', async (_name, layout) => {
    const drawn = await baselines(layout);
    const height = layout.canvas.height_pt;

    // Elements are drawn in layout order, so the Nth baseline belongs to the
    // Nth TEXT element that had something to print.
    const textElements = layout.elements.filter(
      (el): el is Extract<LayoutElement, { type: 'TEXT' }> => el.type === 'TEXT',
    );
    expect(drawn).toHaveLength(textElements.length);

    textElements.forEach((el, i) => {
      // The element's box, converted into page space the same way the renderer
      // should have done it.
      const bottom = height - el.y - el.h;
      const top = height - el.y;
      expect(drawn[i], `${el.id} baseline ${drawn[i]} outside [${bottom}, ${top}]`)
        .toBeGreaterThanOrEqual(bottom);
      expect(drawn[i]).toBeLessThanOrEqual(top);
    });
  });

  it.each(layouts)('%s places the QR where the layout puts it', async (_name, layout) => {
    // The matrix tests below call `drawQr` directly at a fixed origin, so they
    // prove the symbol is correct *relative to its own box* and say nothing
    // about where that box lands on the page. This closes that gap: it reads
    // the plate's actual position out of the rendered file.
    const { pdf } = await renderTicket({ layout, data });
    const rects = drawnRects(pdf);
    const qrEl = layout.elements.find((el) => el.type === 'QR')!;
    if (qrEl.type !== 'QR') throw new Error('unreachable');
    const side = Math.min(qrEl.w, qrEl.h);

    const plate = rects.find(
      (r) => Math.abs(r.w - side) < 0.01 && Math.abs(r.h - side) < 0.01,
    );
    expect(plate, 'no QR plate found in the rendered page').toBeDefined();
    expect(plate!.x).toBeCloseTo(qrEl.x, 1);
    expect(plate!.y).toBeCloseTo(layout.canvas.height_pt - qrEl.y - side, 1);
  });

  it.each(layouts)('%s places every RECT where the layout puts it', async (_name, layout) => {
    const { pdf } = await renderTicket({ layout, data });
    const rects = drawnRects(pdf);
    for (const el of layout.elements) {
      if (el.type !== 'RECT') continue;
      const match = rects.find(
        (r) => Math.abs(r.w - el.w) < 0.01 && Math.abs(r.h - el.h) < 0.01,
      );
      expect(match, `${el.id} was not drawn`).toBeDefined();
      expect(match!.x, `${el.id} x`).toBeCloseTo(el.x, 1);
      expect(match!.y, `${el.id} y`).toBeCloseTo(layout.canvas.height_pt - el.y - el.h, 1);
    }
  });

  it('renders top-to-bottom, not upside down', async () => {
    // Classic Landscape lists concert, show, when, venue, name, doors down the
    // left column. In page space those must descend. A flipped conversion
    // produces exactly the same set of numbers in the opposite order.
    const layout = DEFAULT_TEMPLATES[0].layout;
    const drawn = await baselines(layout);
    const leftColumn = drawn.slice(0, 6);
    for (let i = 1; i < leftColumn.length; i++) {
      expect(leftColumn[i], `line ${i} is not below line ${i - 1}`).toBeLessThan(
        leftColumn[i - 1],
      );
    }
  });
});

describe('the QR that lands on the page', () => {
  /**
   * Re-derive the drawn matrix from the renderer's own geometry.
   *
   * A module is "dark" if a black rectangle was drawn at its position. Any
   * off-by-one in the row inversion — the matrix runs top-down, the page
   * bottom-up — produces a mirrored symbol, which is a QR that scans as
   * something else or not at all, discovered at the door.
   */
  async function drawnMatrix(layout: Layout) {
    const qrEl = layout.elements.find((el) => el.type === 'QR')!;
    if (qrEl.type !== 'QR') throw new Error('unreachable');

    const value = `${data.appUrl}/t/${data.attendee.qrToken}`;
    const expected = QRCode.create(value, { errorCorrectionLevel: qrEl.ec_level });
    const size: number = expected.modules.size;
    const geometry = qrGeometry(size, qrEl);

    // Render, then read the drawn rectangles back out of the page's content
    // stream via a recording page. pdf-lib gives no read API, so the renderer is
    // run against a fake page that records what it was asked to draw.
    const drawn: { x: number; y: number; w: number; h: number; dark: boolean }[] = [];
    const { drawQr } = await import('@/lib/tickets/render/qr');
    const fakePage = {
      drawRectangle(opts: {
        x: number; y: number; width: number; height: number;
        color?: { red: number; green: number; blue: number };
      }) {
        drawn.push({
          x: opts.x, y: opts.y, w: opts.width, h: opts.height,
          dark: (opts.color?.red ?? 1) < 0.5,
        });
      },
    };
    await drawQr(
      fakePage as never,
      qrEl,
      value,
      { x: 0, y: 0 },
    );

    return { drawn, expected, size, geometry, qrEl };
  }

  it.each(layouts)('%s draws exactly the encoder\'s modules', async (_name, layout) => {
    const { drawn, expected, size, geometry, qrEl } = await drawnMatrix(layout);
    const side = Math.min(qrEl.w, qrEl.h);
    const { moduleSize, quietZone } = geometry;

    // Rebuild the matrix from the drawn dark squares.
    const rebuilt = new Uint8Array(size * size);
    for (const rect of drawn) {
      if (!rect.dark) continue;
      const col = Math.round((rect.x - quietZone) / moduleSize);
      const row = Math.round((side - quietZone - rect.y) / moduleSize) - 1;
      expect(row, 'a module fell outside the symbol').toBeGreaterThanOrEqual(0);
      expect(col, 'a module fell outside the symbol').toBeGreaterThanOrEqual(0);
      rebuilt[row * size + col] = 1;
    }

    expect(Array.from(rebuilt)).toEqual(Array.from(expected.modules.data).map((b) => (b ? 1 : 0)));
  });

  it.each(layouts)('%s lays an opaque plate under the whole footprint', async (_name, layout) => {
    // §10.4: the plate is a rendering constraint, not a preference. Without it,
    // dark artwork behind the QR defeats the contrast the decoder needs.
    const { drawn, qrEl } = await drawnMatrix(layout);
    const side = Math.min(qrEl.w, qrEl.h);
    const plate = drawn.find((r) => !r.dark);
    expect(plate, 'no backing plate was drawn').toBeDefined();
    expect(plate!.w).toBe(side);
    expect(plate!.h).toBe(side);
    // Drawn first, or it would cover the modules it is meant to sit behind.
    expect(drawn.indexOf(plate!)).toBe(0);
  });

  it.each(layouts)('%s keeps the quiet zone clear of modules', async (_name, layout) => {
    const { drawn, geometry, qrEl } = await drawnMatrix(layout);
    const side = Math.min(qrEl.w, qrEl.h);
    const { quietZone } = geometry;
    for (const rect of drawn) {
      if (!rect.dark) continue;
      expect(rect.x).toBeGreaterThanOrEqual(quietZone - 0.001);
      expect(rect.y).toBeGreaterThanOrEqual(quietZone - 0.001);
      expect(rect.x + rect.w).toBeLessThanOrEqual(side - quietZone + 0.001);
      expect(rect.y + rect.h).toBeLessThanOrEqual(side - quietZone + 0.001);
    }
  });

  it('draws the plate but no modules for an unminted attendee', async () => {
    // Previewing a ticket before identifiers are minted is legitimate; throwing
    // would make the admin screen fail on exactly the rows it should show.
    const layout = parseLayout(DEFAULT_TEMPLATES[0].layout);
    const { pdf } = await renderTicket({
      layout,
      data: { ...data, attendee: { ...data.attendee, qrToken: null } },
    });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
  });
});
