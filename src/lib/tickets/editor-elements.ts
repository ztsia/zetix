import { DATE_BINDINGS, type Binding, type Layout, type LayoutElement } from './layout';

/**
 * The pure half of the canvas editor (spec/tickets.md §10.3).
 *
 * Creating, moving, resizing and reordering elements is arithmetic on a layout,
 * and none of it needs Konva, a canvas or a browser. Keeping it here means the
 * rules that matter — a resize never produces a zero-width box, a new element
 * lands somewhere visible, an id is never reused — are unit-testable, while the
 * component that imports it stays a thin layer over pointer events.
 */

/**
 * A fresh element id.
 *
 * Prefixed by type so a layout stays readable to whoever opens the jsonb later,
 * and suffixed with a counter that is derived from the layout rather than kept
 * in component state: after a save-and-reload the counter would restart, and a
 * duplicate id silently overwrites the wrong element at render time.
 */
export function nextElementId(layout: Layout, type: LayoutElement['type']): string {
  const prefix = `el_${type.toLowerCase()}`;
  const taken = new Set(layout.elements.map((element) => element.id));
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? prefix : `${prefix}_${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Where a new element lands: the middle of the canvas, nudged clear of whatever
 * is already there.
 *
 * Dropping every new element at the same coordinates makes the third one look
 * like it did not appear at all, because it is exactly behind the second.
 */
function freeSpot(layout: Layout, w: number, h: number): { x: number; y: number } {
  const centre = {
    x: Math.max(0, Math.round(layout.canvas.width_pt / 2 - w / 2)),
    y: Math.max(0, Math.round(layout.canvas.height_pt / 2 - h / 2)),
  };
  const step = 12;
  for (let n = 0; n < 24; n += 1) {
    const spot = { x: centre.x + n * step, y: centre.y + n * step };
    if (spot.x + w > layout.canvas.width_pt || spot.y + h > layout.canvas.height_pt) break;
    const occupied = layout.elements.some(
      (element) => Math.abs(element.x - spot.x) < 2 && Math.abs(element.y - spot.y) < 2,
    );
    if (!occupied) return spot;
  }
  return centre;
}

export type NewElement =
  | { type: 'TEXT'; binding: Binding | null }
  | { type: 'QR' }
  | { type: 'IMAGE'; src: string }
  | { type: 'RECT' };

/**
 * Build an element with defaults an admin will mostly keep.
 *
 * The sizes are chosen to be usable immediately rather than to be neutral: a
 * QR defaults to a square that clears §10.4's 25 mm minimum, and a bound text
 * box defaults wide enough for a long name. A "correct" 10×10 default would
 * make every new element a resize job before it could be judged.
 */
export function createElement(layout: Layout, spec: NewElement): LayoutElement {
  const id = nextElementId(layout, spec.type);

  switch (spec.type) {
    case 'TEXT': {
      const w = 240;
      const h = 28;
      return {
        id,
        type: 'TEXT',
        binding: spec.binding,
        ...(spec.binding
          ? DATE_BINDINGS.includes(spec.binding)
            ? { format: 'EEE d MMM yyyy, HH:mm' }
            : {}
          : { text: 'Text' }),
        ...freeSpot(layout, w, h),
        w,
        h,
        rotation: 0,
        font_family: 'Inter',
        font_size: 14,
        font_weight: 400,
        color: '#1a1a1a',
        align: 'left',
        valign: 'middle',
        max_lines: 1,
        overflow: 'SHRINK',
      };
    }
    case 'QR': {
      // 96pt ≈ 33.9mm, comfortably over the 25mm floor §10.4 sets, and a size
      // that still leaves room on an A6 ticket.
      const side = 96;
      return {
        id,
        type: 'QR',
        binding: 'attendee.qr_url',
        ...freeSpot(layout, side, side),
        w: side,
        h: side,
        rotation: 0,
        ec_level: 'M',
        margin_modules: 2,
      };
    }
    case 'IMAGE': {
      const w = 120;
      const h = 120;
      return {
        id,
        type: 'IMAGE',
        src: spec.src,
        ...freeSpot(layout, w, h),
        w,
        h,
        rotation: 0,
        opacity: 1,
      };
    }
    case 'RECT': {
      const w = 160;
      const h = 4;
      return {
        id,
        type: 'RECT',
        ...freeSpot(layout, w, h),
        w,
        h,
        rotation: 0,
        fill: '#d8d4cc',
        stroke: null,
        stroke_width: 0,
        radius: 0,
      };
    }
  }
}

/**
 * The smallest an element may be dragged down to, in points.
 *
 * Not an operational value — a usability floor. Below about this, the Konva
 * transform handles overlap each other and the element can no longer be grabbed
 * to make it bigger again, which reads as "the editor ate my element".
 */
export const MIN_ELEMENT_PT = 4;

/** Clamp a resize so it stays selectable and never inverts. */
export function clampSize(w: number, h: number): { w: number; h: number } {
  return { w: Math.max(MIN_ELEMENT_PT, w), h: Math.max(MIN_ELEMENT_PT, h) };
}

/** Replace one element, leaving z-order untouched. */
export function updateElement(
  layout: Layout,
  id: string,
  patch: Partial<LayoutElement>,
): Layout {
  return {
    ...layout,
    elements: layout.elements.map((element) =>
      element.id === id ? ({ ...element, ...patch } as LayoutElement) : element,
    ),
  };
}

export function removeElement(layout: Layout, id: string): Layout {
  return { ...layout, elements: layout.elements.filter((element) => element.id !== id) };
}

/**
 * Move an element one step through the paint order, or all the way.
 *
 * The array *is* the z-order — the renderer draws in order, so the last element
 * is on top — which is why this is a reorder rather than a `z` property to
 * maintain. §10.2's format has no z field, and inventing one would put the
 * editor and the renderer's `.strict()` schema in disagreement.
 */
export function reorderElement(
  layout: Layout,
  id: string,
  direction: 'FRONT' | 'FORWARD' | 'BACKWARD' | 'BACK',
): Layout {
  const index = layout.elements.findIndex((element) => element.id === id);
  if (index < 0) return layout;

  const elements = [...layout.elements];
  const [element] = elements.splice(index, 1);
  const target =
    direction === 'FRONT'
      ? elements.length
      : direction === 'BACK'
        ? 0
        : direction === 'FORWARD'
          ? Math.min(elements.length, index + 1)
          : Math.max(0, index - 1);
  elements.splice(target, 0, element);
  return { ...layout, elements };
}

/**
 * Nudge, in points (§10.3: "arrow-key nudge (1pt, 10pt with shift)").
 *
 * Clamped to the canvas so an element cannot be walked off the page and lost:
 * it would still be in the layout and still render, just nowhere anybody would
 * look for it.
 */
export function nudgeElement(
  layout: Layout,
  id: string,
  dx: number,
  dy: number,
): Layout {
  const element = layout.elements.find((candidate) => candidate.id === id);
  if (!element) return layout;
  return updateElement(layout, id, {
    x: clamp(element.x + dx, -element.w / 2, layout.canvas.width_pt - element.w / 2),
    y: clamp(element.y + dy, -element.h / 2, layout.canvas.height_pt - element.h / 2),
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Fit the canvas to a background's real dimensions (§10.3: "canvas dimensions
 * derive from the asset; for PDF the page box in points is authoritative").
 *
 * Elements are **left where they are** rather than scaled with the canvas. A
 * background swap is usually a corrected export of the same artwork at the same
 * size, where rescaling would move everything for no reason; and where it is
 * genuinely a different size, an admin can see what moved and fix it, which is
 * not true of a silent transform applied to every element at once.
 */
export function resizeCanvas(layout: Layout, width_pt: number, height_pt: number): Layout {
  return {
    ...layout,
    canvas: { ...layout.canvas, width_pt, height_pt },
  };
}
