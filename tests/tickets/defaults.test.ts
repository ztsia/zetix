import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, MIN_QR_PT } from '@/lib/tickets/defaults';
import { bindingsUsed, parseLayout, type Layout } from '@/lib/tickets/layout';

/**
 * The three seeded layouts (spec/tickets.md §10.3, decision 10).
 *
 * They exist so the system renders before module `E`'s editor lands, which
 * means nobody will look at them in a canvas first — the editor is what makes a
 * bad layout visible, and it does not exist yet. So the properties that a human
 * would otherwise catch by eye are asserted here instead.
 */

const layouts: [string, Layout][] = DEFAULT_TEMPLATES.map((t) => [t.name, t.layout]);

describe('every seeded default', () => {
  it.each(layouts)('%s validates against the §10.2 schema', (_name, layout) => {
    expect(() => parseLayout(layout)).not.toThrow();
  });

  it.each(layouts)('%s needs no background asset', (_name, layout) => {
    // Decision 10: the system must be usable before anyone uploads artwork. An
    // IMAGE element pointing at an asset nobody has uploaded renders a hole.
    expect(layout.elements.filter((el) => el.type === 'IMAGE')).toEqual([]);
  });

  it.each(layouts)('%s carries exactly one QR', (_name, layout) => {
    const qrs = layout.elements.filter((el) => el.type === 'QR');
    expect(qrs).toHaveLength(1);
  });

  it.each(layouts)('%s prints its QR at 25mm or larger', (_name, layout) => {
    // §10.4. Below this the modules fall under ~0.75mm and a phone starts
    // failing on creased paper in foyer light — which is the only place it is
    // ever used. The failure surfaces at the door and nowhere earlier, so it is
    // a test rather than a note.
    const qr = layout.elements.find((el) => el.type === 'QR')!;
    expect(qr.w).toBeGreaterThanOrEqual(MIN_QR_PT);
    expect(qr.h).toBeGreaterThanOrEqual(MIN_QR_PT);
    // Square, or the symbol distorts and the modules stop being readable.
    expect(qr.w).toBe(qr.h);
  });

  it.each(layouts)('%s uses error correction M', (_name, layout) => {
    const qr = layout.elements.find((el) => el.type === 'QR')!;
    expect(qr.type === 'QR' && qr.ec_level).toBe('M');
  });

  it.each(layouts)('%s prints the name and the ticket code', (_name, layout) => {
    // §10.1 rule 4: three independent ways in. The QR is the first, the printed
    // code is the second, and the name is the third — a layout missing either
    // of the last two quietly removes a fallback the door depends on.
    const used = bindingsUsed(layout);
    expect(used.has('attendee.full_name')).toBe(true);
    expect(used.has('attendee.ticket_code')).toBe(true);
    expect(used.has('attendee.qr_url')).toBe(true);
  });

  it.each(layouts)('%s tells the holder when and where to turn up', (_name, layout) => {
    const used = bindingsUsed(layout);
    expect(used.has('show.name')).toBe(true);
    expect(used.has('show.starts_at')).toBe(true);
    expect(used.has('show.doors_open_at')).toBe(true);
  });

  it.each(layouts)('%s keeps every element inside the canvas', (_name, layout) => {
    // An element positioned off the page renders nothing and looks like a
    // missing feature rather than a bad coordinate.
    for (const el of layout.elements) {
      expect(el.x, `${el.id} starts left of the page`).toBeGreaterThanOrEqual(0);
      expect(el.y, `${el.id} starts above the page`).toBeGreaterThanOrEqual(0);
      expect(el.x + el.w, `${el.id} runs off the right edge`).toBeLessThanOrEqual(
        layout.canvas.width_pt,
      );
      expect(el.y + el.h, `${el.id} runs off the bottom edge`).toBeLessThanOrEqual(
        layout.canvas.height_pt,
      );
    }
  });

  it.each(layouts)('%s does not overlap the QR with anything', (_name, layout) => {
    // §10.4 draws an opaque backing plate under the QR, so an overlapping
    // element would be hidden rather than corrupting the scan — but it would be
    // invisible with no error, which is its own kind of wrong.
    const qr = layout.elements.find((el) => el.type === 'QR')!;
    for (const el of layout.elements) {
      if (el.id === qr.id) continue;
      const disjoint =
        el.x + el.w <= qr.x ||
        qr.x + qr.w <= el.x ||
        el.y + el.h <= qr.y ||
        qr.y + qr.h <= el.y;
      expect(disjoint, `${el.id} overlaps the QR`).toBe(true);
    }
  });

  it.each(layouts)('%s gives every element a unique id', (_name, layout) => {
    const ids = layout.elements.map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(layouts)('%s names only fonts that are vendored', (_name, layout) => {
    // An unknown family throws at render rather than substituting (§10.4), so a
    // typo here would fail every ticket the template ever issues.
    const available = new Set(['Inter', 'JetBrains Mono']);
    for (const el of layout.elements) {
      if (el.type !== 'TEXT') continue;
      expect(available.has(el.font_family), `${el.id} uses ${el.font_family}`).toBe(true);
    }
  });

  it.each(layouts)('%s gives every date binding a format', (_name, layout) => {
    // Without one the renderer has no instruction and would fall back to a raw
    // timestamp — "2026-09-19T19:30:00.000Z" printed on a ticket.
    for (const el of layout.elements) {
      if (el.type !== 'TEXT') continue;
      const isDate =
        el.binding === 'show.starts_at' ||
        el.binding === 'show.doors_open_at' ||
        (el.text?.includes('{{show.doors_open_at}}') ?? false) ||
        (el.text?.includes('{{show.starts_at}}') ?? false);
      if (isDate) expect(el.format, `${el.id} has no format`).toBeTruthy();
    }
  });
});

describe('the set of defaults', () => {
  it('is the three §10.3 names', () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.name)).toEqual([
      'Classic Landscape',
      'Minimal Portrait',
      'Wide Banner',
    ]);
  });

  it('marks exactly one as the default', () => {
    // Two would make "which one renders a fresh concert" arbitrary; none would
    // leave a fresh concert with nothing to render.
    expect(DEFAULT_TEMPLATES.filter((t) => t.isDefault)).toHaveLength(1);
  });

  it('offers a landscape, a portrait and a wide strip', () => {
    const [landscape, portrait, banner] = DEFAULT_TEMPLATES.map((t) => t.layout.canvas);
    expect(landscape.width_pt).toBeGreaterThan(landscape.height_pt);
    expect(portrait.height_pt).toBeGreaterThan(portrait.width_pt);
    expect(banner.width_pt / banner.height_pt).toBeGreaterThan(
      landscape.width_pt / landscape.height_pt,
    );
  });
});
