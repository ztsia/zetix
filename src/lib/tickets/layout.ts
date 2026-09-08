import { z } from 'zod';

/**
 * The ticket layout format (spec/tickets.md §10.2).
 *
 * **This is a contract between two modules that never call each other.** Module
 * `E`'s canvas editor writes this JSON; module `D`'s renderer reads it. They run
 * on separate branches against the written spec, so anything ambiguous here
 * becomes a ticket that looks right in the editor and wrong on paper. The schema
 * is therefore strict — unknown keys are rejected rather than ignored, because a
 * key the editor writes and the renderer silently drops is exactly that failure.
 *
 * Stored in `ticket_templates.layout` (jsonb). Each `ticket_templates` row is
 * one immutable version; editing clones (§10.5).
 */

/**
 * The fields a template may bind, picked from a list and never free-typed
 * (§10.2).
 *
 * The list is closed for two reasons. The editor offers a picker, so a free
 * string could not be validated; and §10.6 flags `needs_reissue` when a **bound**
 * field changes on an already-sent ticket, which requires knowing exactly which
 * fields are bindable. A free-typed binding would silently fall outside that
 * check — the ticket in someone's inbox would drift from the data with nothing
 * to notice.
 *
 * Deliberately absent: email (never printed), and any seat or row number —
 * seating is unreserved, so there is nothing to print.
 */
export const BINDINGS = [
  'attendee.full_name',
  'attendee.ticket_code',
  'attendee.qr_url',
  'registration.contact_name',
  'player.full_name',
  'player.instrument',
  'show.name',
  'show.starts_at',
  'show.doors_open_at',
  'show.venue_name',
  'show.venue_address',
  'concert.name',
] as const;

export type Binding = (typeof BINDINGS)[number];

/** The bindings that carry a timestamp and therefore honour `format`. */
export const DATE_BINDINGS: readonly Binding[] = ['show.starts_at', 'show.doors_open_at'];

const bindingSchema = z.enum(BINDINGS);

/** A hex colour. The renderer parses it; anything else is a template bug. */
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'colour must be #rrggbb');

/** Points, not pixels — the render target is a PDF (§10.2). */
const positionSchema = {
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** Degrees, clockwise. Absent means none. */
  rotation: z.number().default(0),
};

const elementBase = {
  id: z.string().min(1),
  ...positionSchema,
};

/**
 * What to do when text does not fit its box.
 *
 * `SHRINK` reduces the size until it fits, which is what keeps an unusually long
 * name inside the design instead of over the QR. `CLIP` truncates. There is no
 * "overflow visible": a ticket is a fixed rectangle and text escaping it lands
 * on top of something else.
 */
export const OVERFLOW_MODES = ['SHRINK', 'CLIP'] as const;

export const textElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('TEXT'),
    /** Null for a static label, which uses `text` instead. */
    binding: bindingSchema.nullable().default(null),
    /**
     * Static content, with `{{binding}}` placeholders (§10.2's
     * `"Free seating · Doors {{show.doors_open_at}}"`). Only meaningful when
     * `binding` is null.
     *
     * **Bounded, because the text fitter's cost grows with it.** A QA pass fed
     * a one-megabyte string through this and the render never returned — the
     * line breaker measures substrings, so a pathological length hangs the
     * function rather than failing it, and on a blast it would hang holding
     * every ticket behind it. 2,000 characters is far more than a ticket can
     * physically print and far less than enough to stall anything.
     */
    text: z.string().max(2000).optional(),
    /** `date-fns` pattern for a date binding, e.g. `EEE d MMM yyyy, HH:mm`. */
    format: z.string().max(200).optional(),
    font_family: z.string().max(100).default('Inter'),
    font_size: z.number().positive().default(12),
    font_weight: z.number().int().default(400),
    color: colorSchema.default('#1a1a1a'),
    align: z.enum(['left', 'center', 'right']).default('left'),
    valign: z.enum(['top', 'middle', 'bottom']).default('top'),
    max_lines: z.number().int().positive().default(1),
    overflow: z.enum(OVERFLOW_MODES).default('SHRINK'),
  })
  .strict()
  .refine((el) => el.binding !== null || el.text !== undefined, {
    message: 'a TEXT element needs either a binding or static text',
  });

/**
 * Error correction level. §10.4 fixes M for tickets: it recovers ~15% damage,
 * which covers a fold or a thumbprint, without inflating the module count the
 * way Q or H would at a fixed 25mm.
 */
export const EC_LEVELS = ['L', 'M', 'Q', 'H'] as const;

export const qrElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('QR'),
    /** Always the URL form (§10.1); a QR bound to anything else is a bug. */
    binding: z.literal('attendee.qr_url').default('attendee.qr_url'),
    ec_level: z.enum(EC_LEVELS).default('M'),
    /**
     * The quiet zone, in QR modules. Below 2 the scanner may not find the
     * symbol against a busy background; the spec's example uses 2.
     */
    margin_modules: z.number().int().min(1).default(2),
  })
  .strict();

export const imageElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('IMAGE'),
    /** Storage path of the asset. PNG or JPEG — what pdf-lib can embed. */
    src: z.string().min(1),
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();

export const rectElementSchema = z
  .object({
    ...elementBase,
    type: z.literal('RECT'),
    fill: colorSchema.nullable().default(null),
    stroke: colorSchema.nullable().default(null),
    stroke_width: z.number().min(0).default(0),
    radius: z.number().min(0).default(0),
  })
  .strict();

export const elementSchema = z.discriminatedUnion('type', [
  textElementSchema,
  qrElementSchema,
  imageElementSchema,
  rectElementSchema,
]);

export const canvasSchema = z
  .object({
    width_pt: z.number().positive(),
    height_pt: z.number().positive(),
    /** Only meaningful for a raster background; the vector path ignores it. */
    dpi: z.number().positive().default(300),
  })
  .strict();

export const layoutSchema = z
  .object({
    canvas: canvasSchema,
    elements: z.array(elementSchema),
  })
  .strict();

export type Canvas = z.infer<typeof canvasSchema>;
export type TextElement = z.infer<typeof textElementSchema>;
export type QrElement = z.infer<typeof qrElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export type RectElement = z.infer<typeof rectElementSchema>;
export type LayoutElement = z.infer<typeof elementSchema>;
export type Layout = z.infer<typeof layoutSchema>;

/**
 * Parse a layout out of the database, failing loudly.
 *
 * A stored layout is not user input at render time — it was validated when the
 * editor saved it — but it is jsonb, so nothing in the database enforces its
 * shape. Rendering a malformed one would produce a plausible ticket with a
 * missing element, which is worse than an error an admin can see.
 */
export function parseLayout(value: unknown): Layout {
  return layoutSchema.parse(value);
}

/**
 * Every binding a layout actually references, including those inside `{{ }}`
 * placeholders in static text.
 *
 * §10.6 needs this: an edit to a field bound into the template on an attendee
 * with `ticket_sent_at` set flags `needs_reissue`. "Bound into the template"
 * means bound *by this layout*, so the answer has to be derived from the layout
 * rather than from the full list of what is bindable.
 */
export function bindingsUsed(layout: Layout): Set<Binding> {
  const used = new Set<Binding>();
  for (const el of layout.elements) {
    if ('binding' in el && el.binding) used.add(el.binding as Binding);
    if (el.type === 'TEXT' && el.text) {
      for (const match of el.text.matchAll(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g)) {
        const candidate = match[1] as Binding;
        if ((BINDINGS as readonly string[]).includes(candidate)) used.add(candidate);
      }
    }
  }
  return used;
}
