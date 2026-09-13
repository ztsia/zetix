/**
 * The ten field types (spec/v2.md §8.2) and what each one holds.
 *
 * Separated from `schema.ts` so the renderer, the answer validator and the
 * system-field catalogue can all name a type without importing the zod contract
 * — and so the list itself has exactly one home. A field type added here and
 * nowhere else fails to compile in the renderer's exhaustive switch, which is
 * the point.
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
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * The three types that render a fixed list of choices and therefore **must**
 * carry `options`. Every other type must not — an admin-authored option list on
 * a free-text field is a builder bug that would render nothing and silently
 * discard the list on the next save.
 */
export const CHOICE_FIELD_TYPES = ['select', 'multiselect', 'radio'] as const;

export type ChoiceFieldType = (typeof CHOICE_FIELD_TYPES)[number];

export function isChoiceType(type: FieldType): type is ChoiceFieldType {
  return (CHOICE_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * The shape of an answer, per type.
 *
 * `multiselect` is the only one that holds several values; `checkbox` is the
 * only boolean. `date` is an ISO `YYYY-MM-DD` string rather than a `Date`,
 * because it travels through JSON into `form_responses.raw`, which §8.2.3
 * promises is the exact submitted payload and never mutated — a value that
 * round-trips through a `Date` is not that.
 */
export type FieldValue = string | number | boolean | string[] | null;

/** An answer that is present but empty, for every type. Used by required checks and conditions. */
export function isBlank(value: FieldValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  // `false` is a real answer to "did you tick the box?", and `0` is a real
  // number, so neither is blank. **A required checkbox is not handled here** —
  // "required" on a consent box means `true`, not "answered", and
  // `answers.ts` says so explicitly rather than bending this function.
  return false;
}
