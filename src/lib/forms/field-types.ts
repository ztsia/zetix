/**
 * The fifteen field types (spec/v2.md §8.2) and what each one holds.
 *
 * Separated from `schema.ts` so the renderer, the answer validator and the
 * system-field catalogue can all name a type without importing the zod contract
 * — and so the list itself has exactly one home. A field type added here and
 * nowhere else fails to compile in the renderer's exhaustive switch, which is
 * the point.
 *
 * **The set deliberately tracks Google Forms**, because every round of this
 * concert so far has been collected there and an admin moving across should not
 * have to ask which of their questions survive the move. The one type not
 * carried over is **file upload**: it needs a storage bucket, signed upload
 * URLs and a retention policy, and it would put an unauthenticated write
 * endpoint on a URL anyone may open. That is a module, not a field type.
 */

export const FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'tel',
  'number',
  'select',
  'multiselect',
  'checkbox',
  'radio',
  'date',
  'time',
  'scale',
  'rating',
  'grid_radio',
  'grid_checkbox',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * The three types that render a fixed list of choices down the page and
 * therefore **must** carry `options`. Every other non-grid type must not — an
 * admin-authored option list on a free-text field is a builder bug that would
 * render nothing and silently discard the list on the next save.
 */
export const CHOICE_FIELD_TYPES = ['select', 'multiselect', 'radio'] as const;

export type ChoiceFieldType = (typeof CHOICE_FIELD_TYPES)[number];

/**
 * The two grid types. **`options` is the columns and `rows` is the rows** —
 * the same option list, read across instead of down, which is why grids reuse
 * `options` rather than introducing a second parallel shape the builder and
 * the exporter would both have to learn.
 */
export const GRID_FIELD_TYPES = ['grid_radio', 'grid_checkbox'] as const;

export type GridFieldType = (typeof GRID_FIELD_TYPES)[number];

/** Every type that carries an `options` list, in either direction. */
export const OPTION_FIELD_TYPES = [...CHOICE_FIELD_TYPES, ...GRID_FIELD_TYPES] as const;

/**
 * The two types backed by a numeric range rather than a list: a linear scale
 * with its end labels, and a star rating. They share one `scale` config because
 * a rating **is** a scale whose floor is 1 and whose ends are unlabelled — two
 * configs would be two places to get the bounds check wrong.
 */
export const SCALE_FIELD_TYPES = ['scale', 'rating'] as const;

export type ScaleFieldType = (typeof SCALE_FIELD_TYPES)[number];

export function isChoiceType(type: FieldType): type is ChoiceFieldType {
  return (CHOICE_FIELD_TYPES as readonly string[]).includes(type);
}

export function isGridType(type: FieldType): type is GridFieldType {
  return (GRID_FIELD_TYPES as readonly string[]).includes(type);
}

export function isOptionType(type: FieldType): boolean {
  return (OPTION_FIELD_TYPES as readonly string[]).includes(type);
}

export function isScaleType(type: FieldType): type is ScaleFieldType {
  return (SCALE_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * The bounds a `scale` or `rating` field carries.
 *
 * Mirrors the zod shape in `schema.ts` rather than being derived from it, so
 * the builder can name the shape without importing the contract — the same
 * separation the rest of this file exists for. `schema.ts` remains the judge:
 * it is what refuses a top at or below the bottom.
 */
export type FormFieldScale = {
  min: number;
  max: number;
  min_label?: string;
  max_label?: string;
};

/**
 * What a grid answer looks like: one entry per **row that was answered**, keyed
 * by the row's `value`.
 *
 * A row nobody touched is absent rather than present-and-empty, so "skipped the
 * third row" and "answered the third row with nothing" stay distinguishable —
 * the same distinction §8.2.2 asks for between a hidden conditional field and a
 * blank one.
 */
export type GridValue = Record<string, string | string[]>;

/**
 * The shape of an answer, per type.
 *
 * `multiselect` is the only flat type that holds several values; `checkbox` is
 * the only boolean; `scale` and `rating` are numbers. `date` is an ISO
 * `YYYY-MM-DD` string and `time` an ISO `HH:MM` one, rather than a `Date`,
 * because they travel through JSON into `form_responses.raw`, which §8.2.3
 * promises is the exact submitted payload and never mutated — a value that
 * round-trips through a `Date` is not that.
 */
export type FieldValue = string | number | boolean | string[] | GridValue | null;

/** True when a value is a grid's row map rather than a flat answer. */
export function isGridValue(value: FieldValue | undefined): value is GridValue {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/** An answer that is present but empty, for every type. Used by required checks and conditions. */
export function isBlank(value: FieldValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  /**
   * A grid is blank when no row holds an answer. An empty row map, and a map
   * whose every row is an empty array, are both "nobody filled this in" — and
   * a `required` grid means *every* row, which `answers.ts` checks separately
   * because this function cannot see the row list.
   */
  if (isGridValue(value)) {
    return Object.values(value).every((entry) =>
      Array.isArray(entry) ? entry.length === 0 : entry.trim() === '',
    );
  }
  // `false` is a real answer to "did you tick the box?", and `0` is a real
  // number, so neither is blank. **A required checkbox is not handled here** —
  // "required" on a consent box means `true`, not "answered", and
  // `answers.ts` says so explicitly rather than bending this function.
  return false;
}

/**
 * The admin-facing name and one-line description for each type, used by the
 * builder's type picker.
 *
 * **Named the way the admin's other tool names them**, because the person
 * choosing has almost certainly just come from Google Forms: "Paragraph", not
 * "textarea". The stored value is still the internal type, so nothing about the
 * schema bends to the label.
 */
export const FIELD_TYPE_LABELS: Record<FieldType, { label: string; hint: string }> = {
  text: { label: 'Short answer', hint: 'One line of text' },
  textarea: { label: 'Paragraph', hint: 'Several lines of text' },
  radio: { label: 'Multiple choice', hint: 'Pick one from a list' },
  multiselect: { label: 'Checkboxes', hint: 'Pick any number from a list' },
  select: { label: 'Drop-down', hint: 'Pick one, from a menu' },
  scale: { label: 'Linear scale', hint: 'A row of numbers, with labelled ends' },
  rating: { label: 'Rating', hint: 'A row of stars' },
  grid_radio: { label: 'Multiple-choice grid', hint: 'One answer per row' },
  grid_checkbox: { label: 'Tick box grid', hint: 'Any number of answers per row' },
  date: { label: 'Date', hint: 'A calendar date' },
  time: { label: 'Time', hint: 'A time of day' },
  checkbox: { label: 'Single tick box', hint: 'One box to agree or confirm' },
  email: { label: 'Email address', hint: 'Checked for an @' },
  tel: { label: 'Phone number', hint: 'A telephone keypad on a phone' },
  number: { label: 'Number', hint: 'Digits only' },
};

/**
 * The order the picker offers them in, grouped the way Google Forms groups
 * them. The grouping is presentational only — `FIELD_TYPES` remains the set.
 */
export const FIELD_TYPE_GROUPS: { label: string; types: readonly FieldType[] }[] = [
  { label: 'Text', types: ['text', 'textarea'] },
  { label: 'Choice', types: ['radio', 'multiselect', 'select'] },
  { label: 'Scale', types: ['scale', 'rating'] },
  { label: 'Grid', types: ['grid_radio', 'grid_checkbox'] },
  { label: 'Date and time', types: ['date', 'time'] },
  { label: 'Other', types: ['checkbox', 'email', 'tel', 'number'] },
];
