import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES } from '@/lib/tickets/defaults';
import { renderTicket } from '@/lib/tickets/render';
import { needsOutline, unprintable } from '@/lib/tickets/render/outline';
import { loadOutlineFace } from '@/lib/tickets/fonts';
import type { TicketData } from '@/lib/tickets/bindings';

/**
 * Chinese names on a ticket (`spec/tickets.md` §10.4).
 *
 * They printed as `|x|` boxes: Inter has no CJK glyph, and a PDF reader draws
 * `.notdef` rather than failing, so every existing test passed while the
 * tickets were unusable. The renderer now draws those characters as outlines —
 * see `render/outline.ts` for why it draws rather than embeds.
 */

const layout = DEFAULT_TEMPLATES[0].layout;

const data = (fullName: string): TicketData => ({
  attendee: { fullName, ticketCode: 'ORC-7K4Q', qrToken: 'aB3xY9zQ1mN7pR4tW2kL6v' },
  registration: { contactName: fullName },
  player: { fullName: '黄美玲', instrument: 'Violin I' },
  show: {
    name: 'RISE',
    startsAt: new Date('2026-09-19T11:30:00Z'),
    doorsOpenAt: new Date('2026-09-19T11:00:00Z'),
    venueName: 'Chang Feng Hall',
    venueAddress: 'Cheras, Selangor',
  },
  concert: { name: 'Lakeside Community Orchestra', timezone: 'Asia/Kuala_Lumpur' },
  appUrl: 'https://zetix.vercel.app',
});

const render = (fullName: string) => renderTicket({ layout, data: data(fullName) });

describe('which face a name needs', () => {
  it('sends a Chinese name to the fallback', () => {
    expect(needsOutline('Inter:600', '陈大文')).toBe(true);
  });

  it('leaves a Latin name on the embedded face', () => {
    expect(needsOutline('Inter:600', 'Loh Kai Xin')).toBe(false);
  });

  /**
   * One face per element, not per character: a mixed name switches wholesale,
   * so every metric stays self-consistent and shrink-to-fit still agrees with
   * what is drawn.
   */
  it('sends a mixed name to the fallback as a whole', () => {
    expect(needsOutline('Inter:600', '陈大文 Tan')).toBe(true);
  });

  it('covers the characters this concert will actually see', () => {
    // Simplified, Traditional and the punctuation a form throws in.
    expect(unprintable('陈大文 黄美玲 臺灣 國樂 鄭賴蕭 · () —')).toEqual([]);
  });
});

describe('rendering a Chinese name', () => {
  it('renders without throwing', async () => {
    const result = await render('陈大文');
    expect(result.pdf.byteLength).toBeGreaterThan(0);
    expect(result.truncated).toEqual([]);
  });

  /**
   * The whole reason outlines were chosen over embedding. The fallback face is
   * 10MB; if it ever reaches the file, a party of four stops fitting in an
   * email long before anyone notices the size.
   */
  it('does not put the fallback font in the PDF', async () => {
    const { pdf } = await render('陈大文');
    const face = loadOutlineFace();
    const needle = Buffer.from(face.subarray(0, 2048));

    expect(Buffer.from(pdf).includes(needle)).toBe(false);
    expect(pdf.byteLength).toBeLessThan(700 * 1024);
  });

  it('costs about the same as a Latin ticket', async () => {
    const [latin, chinese] = await Promise.all([render('Loh Kai Xin'), render('陈大文')]);

    expect(chinese.pdf.byteLength - latin.pdf.byteLength).toBeLessThan(60 * 1024);
  });
});

/**
 * Orientation, read back out of the file rather than trusted.
 *
 * `drawSvgPath` flips the y axis because SVG runs downward, and glyph outlines
 * run upward from the baseline, so the two have to cancel. Get it wrong and the
 * ticket renders perfectly and upside down — the exact failure mode this module
 * has been bitten by before. So this reads the emitted transform and path out
 * of the content stream and checks where the ink actually lands.
 */
describe('the glyphs land the right way up', () => {
  const streamOf = (pdf: Uint8Array): string => {
    const buf = Buffer.from(pdf);
    const text = buf.toString('latin1');
    let found = '';
    const re = /stream\r?\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index + m[0].length;
      const end = text.indexOf('endstream', start);
      if (end < 0) continue;
      try {
        const out = inflateSync(buf.subarray(start, end)).toString('latin1');
        if (out.includes(' cm') || out.includes(' re')) found += out;
      } catch {
        /* not a deflate stream; the font programs are the bulk of these */
      }
    }
    return found;
  };

  it('draws the name above its baseline, inside the page', async () => {
    const { pdf } = await render('陈大文');
    const content = streamOf(pdf);

    /**
     * pdf-lib emits `1 0 0 1 tx ty cm` then `sx 0 0 sy 0 0 cm` for a path. The
     * **negative** sy is the signature of a drawn glyph: it is the flip
     * cancelling the outline's own orientation, and the QR's several hundred
     * little rectangles all carry a positive one, so this picks out the name
     * without matching them. The identity `cm` between the two is pdf-lib
     * emitting a zero rotation, which it does whether or not one was asked for.
     */
    const glyphs = [
      ...content.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) cm\s*(?:1 0 0 1 0 0 cm\s*)?([\d.e-]+) 0 0 (-[\d.e-]+) 0 0 cm/g),
    ];

    // One path per character. Zero would mean the name never reached the
    // fallback at all — the original bug, which every other test survived.
    expect(glyphs).toHaveLength(3);

    const pageHeight = layout.canvas.height_pt;
    const pageWidth = layout.canvas.width_pt;
    for (const glyph of glyphs) {
      const [x, y, sx, sy] = glyph.slice(1).map(Number);

      // The two scales must be equal and opposite: equal, or the glyph is
      // stretched; opposite, or it is upside down.
      expect(sx).toBeCloseTo(-sy, 6);
      // 1000 units per em, so the scale is the font size in points.
      expect(sx * 1000).toBeGreaterThan(6);

      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(pageWidth);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(pageHeight);
    }
  });

  it('leaves a Latin name as embedded text, still selectable', async () => {
    const { pdf } = await render('Loh Kai Xin');
    const content = streamOf(pdf);

    expect(content).toMatch(/\/Inter-SemiBold[^\s]* [\d.]+ Tf/);
    expect([...content.matchAll(/1 0 0 1 [\d.-]+ [\d.-]+ cm\s*(?:1 0 0 1 0 0 cm\s*)?[\d.e-]+ 0 0 -[\d.e-]+ 0 0 cm/g)]).toHaveLength(0);
  });
});
