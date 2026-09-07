import type { Layout } from './layout';

/**
 * The three seeded default layouts (spec/tickets.md §10.3, decision 10).
 *
 * **These exist so the system can render a ticket before anyone opens the
 * editor.** Module `E` builds the canvas editor in parallel against the same
 * §10.2 format; if the defaults were missing, nothing could render until `E`
 * landed and the critical path would run through it. They therefore use **no
 * background asset** — every one is type on paper, so they work with nothing
 * uploaded.
 *
 * They are code, not data, on purpose: a seeded row can be edited or deleted,
 * and the point of a default is that there is always one. `seedTemplates()`
 * writes them as `concert_id = null` global rows.
 */

/**
 * PostScript points per millimetre: 72 points to the inch, 25.4 mm to the inch.
 * A physical unit conversion, not an operational value.
 */
const PT_PER_MM = 72 / 25.4;

/**
 * The smallest QR that reliably scans off paper, from §10.4: **25 mm**.
 *
 * A rendering constraint rather than a design preference. Below this, a
 * version-4 symbol's modules fall under about 0.75 mm and a phone camera starts
 * failing on creased paper or in the low light of a foyer — which is exactly
 * where it will be used. `tests/tickets/defaults.test.ts` holds every seeded
 * layout to it, because the failure appears at the door and nowhere earlier.
 */
export const MIN_QR_PT = 25 * PT_PER_MM;

/** Ink colours shared by the three layouts, so they read as one family. */
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#d8d4cc';

/**
 * Classic Landscape — the §10.2 example, filled out.
 *
 * A5 landscape-ish strip: two to a page, and it reads left to right the way a
 * ticket normally does. QR on the right where a thumb does not cover it.
 */
const classicLandscape: Layout = {
  canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
  elements: [
    {
      id: 'el_rule', type: 'RECT',
      x: 400, y: 24, w: 1, h: 232, rotation: 0,
      fill: RULE, stroke: null, stroke_width: 0, radius: 0,
    },
    {
      id: 'el_concert', type: 'TEXT', binding: 'concert.name',
      x: 40, y: 34, w: 340, h: 20, rotation: 0,
      font_family: 'Inter', font_size: 11, font_weight: 400, color: MUTED,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_show', type: 'TEXT', binding: 'show.name',
      x: 40, y: 62, w: 340, h: 30, rotation: 0,
      font_family: 'Inter', font_size: 20, font_weight: 600, color: INK,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_when', type: 'TEXT', binding: 'show.starts_at',
      format: 'EEE d MMM yyyy, HH:mm',
      x: 40, y: 96, w: 340, h: 20, rotation: 0,
      font_family: 'Inter', font_size: 12, font_weight: 400, color: INK,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_venue', type: 'TEXT', binding: 'show.venue_name',
      x: 40, y: 118, w: 340, h: 18, rotation: 0,
      font_family: 'Inter', font_size: 11, font_weight: 400, color: MUTED,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      // The name is the largest thing on the ticket: it is what an usher reads
      // when the QR will not scan (§10.1 rule 4, the tertiary way in).
      id: 'el_name', type: 'TEXT', binding: 'attendee.full_name',
      x: 40, y: 176, w: 340, h: 34, rotation: 0,
      font_family: 'Inter', font_size: 22, font_weight: 600, color: INK,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_doors', type: 'TEXT', binding: null,
      text: 'Free seating · Doors {{show.doors_open_at}}',
      format: 'HH:mm',
      x: 40, y: 216, w: 340, h: 18, rotation: 0,
      font_family: 'Inter', font_size: 11, font_weight: 400, color: MUTED,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_qr', type: 'QR', binding: 'attendee.qr_url',
      x: 430, y: 56, w: 130, h: 130, rotation: 0,
      ec_level: 'M', margin_modules: 2,
    },
    {
      id: 'el_code', type: 'TEXT', binding: 'attendee.ticket_code',
      x: 430, y: 196, w: 130, h: 18, rotation: 0,
      font_family: 'JetBrains Mono', font_size: 12, font_weight: 400, color: INK,
      align: 'center', valign: 'middle', max_lines: 1, overflow: 'CLIP',
    },
  ],
};

/**
 * Minimal Portrait — A6, four to an A4 sheet.
 *
 * The cheapest thing to print in bulk, and the QR sits centred where a folded
 * ticket still presents it flat.
 */
const minimalPortrait: Layout = {
  canvas: { width_pt: 298, height_pt: 420, dpi: 300 },
  elements: [
    {
      id: 'el_show', type: 'TEXT', binding: 'show.name',
      x: 28, y: 34, w: 242, h: 26, rotation: 0,
      font_family: 'Inter', font_size: 16, font_weight: 600, color: INK,
      align: 'center', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_when', type: 'TEXT', binding: 'show.starts_at',
      format: 'EEE d MMM, HH:mm',
      x: 28, y: 62, w: 242, h: 18, rotation: 0,
      font_family: 'Inter', font_size: 11, font_weight: 400, color: MUTED,
      align: 'center', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_qr', type: 'QR', binding: 'attendee.qr_url',
      x: 79, y: 108, w: 140, h: 140, rotation: 0,
      ec_level: 'M', margin_modules: 2,
    },
    {
      id: 'el_code', type: 'TEXT', binding: 'attendee.ticket_code',
      x: 28, y: 258, w: 242, h: 18, rotation: 0,
      font_family: 'JetBrains Mono', font_size: 12, font_weight: 400, color: INK,
      align: 'center', valign: 'middle', max_lines: 1, overflow: 'CLIP',
    },
    {
      id: 'el_rule', type: 'RECT',
      x: 92, y: 292, w: 114, h: 1, rotation: 0,
      fill: RULE, stroke: null, stroke_width: 0, radius: 0,
    },
    {
      // Two lines here: a portrait ticket is narrow, and shrinking a long name
      // to fit one line makes it unreadable at arm's length in a queue.
      id: 'el_name', type: 'TEXT', binding: 'attendee.full_name',
      x: 28, y: 308, w: 242, h: 46, rotation: 0,
      font_family: 'Inter', font_size: 17, font_weight: 600, color: INK,
      align: 'center', valign: 'middle', max_lines: 2, overflow: 'SHRINK',
    },
    {
      id: 'el_doors', type: 'TEXT', binding: null,
      text: 'Free seating · Doors {{show.doors_open_at}}',
      format: 'HH:mm',
      x: 28, y: 366, w: 242, h: 16, rotation: 0,
      font_family: 'Inter', font_size: 10, font_weight: 400, color: MUTED,
      align: 'center', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
  ],
};

/**
 * Wide Banner — a full-width strip, three to an A4 sheet.
 *
 * Everything on one line for guillotine cutting, and the widest name field of
 * the three.
 */
const wideBanner: Layout = {
  canvas: { width_pt: 842, height_pt: 210, dpi: 300 },
  elements: [
    {
      id: 'el_bar', type: 'RECT',
      x: 0, y: 0, w: 10, h: 210, rotation: 0,
      fill: INK, stroke: null, stroke_width: 0, radius: 0,
    },
    {
      id: 'el_concert', type: 'TEXT', binding: 'concert.name',
      x: 40, y: 30, w: 420, h: 18, rotation: 0,
      font_family: 'Inter', font_size: 10, font_weight: 400, color: MUTED,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_name', type: 'TEXT', binding: 'attendee.full_name',
      x: 40, y: 56, w: 420, h: 40, rotation: 0,
      font_family: 'Inter', font_size: 26, font_weight: 600, color: INK,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_show', type: 'TEXT', binding: 'show.name',
      x: 40, y: 106, w: 420, h: 22, rotation: 0,
      font_family: 'Inter', font_size: 14, font_weight: 400, color: INK,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_when', type: 'TEXT', binding: 'show.starts_at',
      format: 'EEE d MMM yyyy, HH:mm',
      x: 40, y: 132, w: 420, h: 18, rotation: 0,
      font_family: 'Inter', font_size: 11, font_weight: 400, color: MUTED,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_venue', type: 'TEXT', binding: 'show.venue_name',
      x: 40, y: 152, w: 420, h: 18, rotation: 0,
      font_family: 'Inter', font_size: 11, font_weight: 400, color: MUTED,
      align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_doors', type: 'TEXT', binding: null,
      text: 'Free seating · Doors {{show.doors_open_at}}',
      format: 'HH:mm',
      x: 520, y: 40, w: 200, h: 18, rotation: 0,
      font_family: 'Inter', font_size: 10, font_weight: 400, color: MUTED,
      align: 'right', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
    },
    {
      id: 'el_qr', type: 'QR', binding: 'attendee.qr_url',
      x: 730, y: 30, w: 96, h: 96, rotation: 0,
      ec_level: 'M', margin_modules: 2,
    },
    {
      id: 'el_code', type: 'TEXT', binding: 'attendee.ticket_code',
      x: 730, y: 134, w: 96, h: 18, rotation: 0,
      font_family: 'JetBrains Mono', font_size: 11, font_weight: 400, color: INK,
      align: 'center', valign: 'middle', max_lines: 1, overflow: 'CLIP',
    },
  ],
};

export type DefaultTemplate = {
  name: string;
  layout: Layout;
  /** The first of the three is the one a fresh concert renders with. */
  isDefault: boolean;
};

export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  { name: 'Classic Landscape', layout: classicLandscape, isDefault: true },
  { name: 'Minimal Portrait', layout: minimalPortrait, isDefault: false },
  { name: 'Wide Banner', layout: wideBanner, isDefault: false },
];
