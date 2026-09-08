import { describe, expect, it } from 'vitest';
import {
  MIN_ELEMENT_PT,
  clampSize,
  createElement,
  nextElementId,
  nudgeElement,
  removeElement,
  reorderElement,
  resizeCanvas,
  updateElement,
} from '@/lib/tickets/editor-elements';
import { elementSchema, layoutSchema, type Layout } from '@/lib/tickets/layout';

/**
 * The editor's arithmetic (spec/tickets.md §10.3).
 *
 * Every one of these is a rule the canvas component depends on and cannot state
 * for itself. The one that matters most is the first: **everything the editor
 * creates must satisfy the renderer's `.strict()` schema**, because that schema
 * is the contract between two modules built on separate branches. An element
 * the editor invents a key for is stored, ignored at render time, and shows up
 * as a ticket missing something.
 */

const empty: Layout = {
  canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
  elements: [],
};

describe('createElement', () => {
  it('produces elements the renderer will accept', () => {
    for (const spec of [
      { type: 'TEXT', binding: 'attendee.full_name' },
      { type: 'TEXT', binding: null },
      { type: 'QR' },
      { type: 'IMAGE', src: 'concerts/1/a.png' },
      { type: 'RECT' },
    ] as const) {
      const element = createElement(empty, spec);
      expect(() => elementSchema.parse(element)).not.toThrow();
    }
  });

  it('gives a date binding a format, and a static element some text', () => {
    const date = createElement(empty, { type: 'TEXT', binding: 'show.starts_at' });
    expect(date).toMatchObject({ binding: 'show.starts_at', format: expect.any(String) });

    // §10.2's schema refuses a TEXT element with neither a binding nor text, so
    // a static element that arrived empty would fail on save rather than on
    // creation — with the error pointing at the wrong moment.
    const staticText = createElement(empty, { type: 'TEXT', binding: null });
    expect(staticText).toMatchObject({ binding: null, text: expect.any(String) });
  });

  it('drops a new element inside the canvas', () => {
    const element = createElement(empty, { type: 'QR' });
    expect(element.x).toBeGreaterThanOrEqual(0);
    expect(element.y).toBeGreaterThanOrEqual(0);
    expect(element.x + element.w).toBeLessThanOrEqual(empty.canvas.width_pt);
    expect(element.y + element.h).toBeLessThanOrEqual(empty.canvas.height_pt);
  });

  it('does not stack two new elements exactly on top of each other', () => {
    const first = createElement(empty, { type: 'TEXT', binding: null });
    const layout = { ...empty, elements: [first] };
    const second = createElement(layout, { type: 'TEXT', binding: null });

    // Identical coordinates read as "the button did nothing".
    expect([second.x, second.y]).not.toEqual([first.x, first.y]);
  });

  it('defaults a QR big enough to scan off paper', () => {
    // §10.4 fixes the floor at 25mm ≈ 71pt. A default under it would ship
    // tickets that fail at the door, which is the one failure with no recovery.
    const qr = createElement(empty, { type: 'QR' });
    expect(Math.min(qr.w, qr.h)).toBeGreaterThanOrEqual(71);
  });
});

describe('nextElementId', () => {
  it('never reuses an id already in the layout', () => {
    const layout: Layout = {
      ...empty,
      elements: [
        createElement(empty, { type: 'TEXT', binding: null }),
      ],
    };
    const id = nextElementId(layout, 'TEXT');
    expect(layout.elements.some((element) => element.id === id)).toBe(false);
  });

  it('stays unique after a save and reload, not just within one session', () => {
    // A counter kept in component state restarts at zero on reload, and a
    // duplicate id silently overwrites the wrong element at render time.
    let layout = empty;
    for (let n = 0; n < 5; n += 1) {
      const element = createElement(layout, { type: 'TEXT', binding: null });
      layout = { ...layout, elements: [...layout.elements, element] };
    }
    const reloaded: Layout = layoutSchema.parse(JSON.parse(JSON.stringify(layout)));
    const next = nextElementId(reloaded, 'TEXT');
    expect(reloaded.elements.some((element) => element.id === next)).toBe(false);
  });
});

describe('clampSize', () => {
  it('keeps an element big enough to grab again', () => {
    // Dragged to nothing, an element is still in the layout but can never be
    // resized back — it reads as "the editor ate it".
    expect(clampSize(0, -5)).toEqual({ w: MIN_ELEMENT_PT, h: MIN_ELEMENT_PT });
    expect(clampSize(120, 40)).toEqual({ w: 120, h: 40 });
  });
});

describe('reorderElement', () => {
  const three: Layout = {
    ...empty,
    elements: ['a', 'b', 'c'].map((id) => ({
      ...createElement(empty, { type: 'RECT' }),
      id,
    })),
  };
  const ids = (layout: Layout) => layout.elements.map((element) => element.id);

  it('treats the array as the paint order, because the renderer does', () => {
    expect(ids(reorderElement(three, 'a', 'FRONT'))).toEqual(['b', 'c', 'a']);
    expect(ids(reorderElement(three, 'c', 'BACK'))).toEqual(['c', 'a', 'b']);
    expect(ids(reorderElement(three, 'a', 'FORWARD'))).toEqual(['b', 'a', 'c']);
    expect(ids(reorderElement(three, 'c', 'BACKWARD'))).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at the ends and for an unknown id', () => {
    expect(ids(reorderElement(three, 'a', 'BACK'))).toEqual(['a', 'b', 'c']);
    expect(ids(reorderElement(three, 'zz', 'FRONT'))).toEqual(['a', 'b', 'c']);
  });
});

describe('nudgeElement', () => {
  it('moves by the step given', () => {
    const element = createElement(empty, { type: 'RECT' });
    const layout = { ...empty, elements: [element] };
    const moved = nudgeElement(layout, element.id, 10, -1);
    expect(moved.elements[0].x).toBe(element.x + 10);
    expect(moved.elements[0].y).toBe(element.y - 1);
  });

  it('will not let an element be walked off the page and lost', () => {
    const element = { ...createElement(empty, { type: 'RECT' }), x: 0, y: 0 };
    let layout: Layout = { ...empty, elements: [element] };
    for (let n = 0; n < 200; n += 1) layout = nudgeElement(layout, element.id, -10, -10);

    // Half out is still findable and draggable back; fully out is not.
    expect(layout.elements[0].x).toBeGreaterThanOrEqual(-element.w / 2);
    expect(layout.elements[0].y).toBeGreaterThanOrEqual(-element.h / 2);
  });
});

describe('updateElement and removeElement', () => {
  it('changes one element and leaves the order alone', () => {
    const a = { ...createElement(empty, { type: 'RECT' }), id: 'a' };
    const b = { ...createElement(empty, { type: 'RECT' }), id: 'b' };
    const layout: Layout = { ...empty, elements: [a, b] };

    const updated = updateElement(layout, 'b', { x: 42 });
    expect(updated.elements.map((element) => element.id)).toEqual(['a', 'b']);
    expect(updated.elements[1].x).toBe(42);
    expect(updated.elements[0]).toEqual(a);

    expect(removeElement(updated, 'a').elements.map((e) => e.id)).toEqual(['b']);
  });
});

describe('resizeCanvas', () => {
  it('resizes the page without moving the elements on it', () => {
    // A background swap is usually the same artwork re-exported. Scaling every
    // element to match would move a layout that was already correct.
    const element = createElement(empty, { type: 'RECT' });
    const layout: Layout = { ...empty, elements: [element] };
    const resized = resizeCanvas(layout, 842, 210);

    expect(resized.canvas).toMatchObject({ width_pt: 842, height_pt: 210, dpi: 300 });
    expect(resized.elements[0]).toEqual(element);
  });
});
