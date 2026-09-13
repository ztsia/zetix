/**
 * The answer shape, and validating a submission against a pinned schema
 * (spec/v2.md §8.2.3, §8.2.4).
 *
 * **The third of the contract's three uses.** The builder writes the schema, the
 * renderer draws it, and this validates what came back — from the same object,
 * so a form cannot accept an answer it never asked for or reject one it did.
 *
 * Pure and database-free. The seat arithmetic that decides whether those
 * answers *become* attendees is `claim_seats()`'s and belongs to `M`; this only
 * decides whether the payload is a valid answer to this form.
 */

import { z } from 'zod';
import { isBlank, type FieldValue } from './field-types';
import { visibleFieldKeys } from './conditions';
import {
  blockFields,
  flatScopeFields,
  isRepeaterType,
  type FormField,
  type FormSchema,
} from './schema';

/** One block's answers: a flat map for a flat block, a list of rows for a repeater. */
export type BlockAnswer =
  | { kind: 'flat'; values: Record<string, FieldValue> }
  | { kind: 'repeater'; rows: Record<string, FieldValue>[] };

/** Every block's answers, keyed by block id. */
export type FormAnswers = Record<string, BlockAnswer>;

/**
 * Errors keyed by the same path the renderer draws with:
 * `<blockId>` for the block itself, `<blockId>.<fieldKey>` for a flat field,
 * `<blockId>.<rowIndex>.<fieldKey>` for a field inside a repeater row.
 *
 * One string key rather than a nested object because both consumers want a
 * lookup, not a walk: the renderer asks "is *this* control invalid?" and the
 * server asks "is anything invalid?".
 */
export type AnswerErrors = Record<string, string>;

export function fieldPathKey(blockId: string, fieldKey: string, rowIndex?: number): string {
  return rowIndex === undefined ? `${blockId}.${fieldKey}` : `${blockId}.${rowIndex}.${fieldKey}`;
}

export type ValidationResult =
  | {
      ok: true;
      /**
       * The answers as they should be stored — coerced to their declared types,
       * with hidden and unknown keys removed.
       *
       * This is what `registrations.custom` and `attendees.custom` are written
       * from. `form_responses.raw` keeps the payload exactly as submitted and is
       * never touched (§8.2.3): `raw` is the receipt of what the person typed,
       * this is the queryable copy of what it meant.
       */
      answers: FormAnswers;
      /**
       * Keys in the payload that the schema does not have.
       *
       * Almost always a schema edited between load and submit. Dropped rather
       * than rejected — the person in front of the form did nothing wrong and
       * `raw` still holds it — but reported, because a surface that silently
       * discards answers is one nobody can debug.
       */
      dropped: string[];
    }
  | { ok: false; errors: AnswerErrors };

export type ValidateOptions = {
  /** Row caps per repeater block id, from `limits.ts`. */
  limits: Readonly<Record<string, number>>;
};

/**
 * Validate a submitted payload against the schema it was answered with.
 *
 * **Always validate against the pinned schema**, `form_responses.form_schema`,
 * not against the form's current one (§8.2.4). An admin renaming a question
 * between load and submit must not turn a correct answer into an error.
 */
export function validateAnswers(
  schema: FormSchema,
  payload: unknown,
  options: ValidateOptions,
): ValidationResult {
  const errors: AnswerErrors = {};
  const dropped: string[] = [];
  const answers: FormAnswers = {};

  const raw = asRecord(payload);
  if (!raw) return { ok: false, errors: { _form: 'The submission was not readable.' } };

  /**
   * **The flat scope is resolved across all flat blocks before anything is
   * validated**, because a condition may read any earlier custom field in it —
   * including one in an earlier block (`schema.ts`). Validating block by block
   * would evaluate every cross-block condition against an empty source: the
   * question would never be required, and an answer to it would be dropped as
   * hidden. Repeater rows are their own scopes and stay per-row.
   */
  const flatBlocks = schema.blocks.filter((block) => !isRepeaterType(block.type));
  const flatSubmitted = new Map<string, Record<string, unknown>>();
  const flatCoerced: Record<string, FieldValue> = {};

  for (const block of flatBlocks) {
    const submitted = asRecord(unwrapFlat(raw[block.id])) ?? {};
    flatSubmitted.set(block.id, submitted);
    for (const field of blockFields(block)) {
      flatCoerced[field.key] = coerce(field, submitted[field.key]);
    }
  }

  const flatVisible = visibleFieldKeys(flatScopeFields(schema), flatCoerced);

  for (const block of schema.blocks) {
    if (isRepeaterType(block.type)) {
      answers[block.id] = validateRepeater(
        block.id,
        blockFields(block),
        raw[block.id],
        options,
        errors,
        dropped,
      );
      continue;
    }

    const submitted = flatSubmitted.get(block.id) ?? {};
    answers[block.id] = {
      kind: 'flat',
      values: validateFields(
        blockFields(block),
        submitted,
        flatCoerced,
        flatVisible,
        (key) => fieldPathKey(block.id, key),
        errors,
        dropped,
        block.id,
      ),
    };
  }

  for (const key of Object.keys(raw)) {
    if (!schema.blocks.some((block) => block.id === key)) dropped.push(key);
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, answers, dropped };
}

/**
 * A repeater's rows.
 *
 * **Over the cap is an error, not a truncation.** Silently dropping row four of
 * a party of four is the exact failure the form builder exists to prevent — a
 * person arrives at a door with no ticket and nothing in the system says why.
 * The row cap is advisory to the *form*; the seat truth is `claim_seats()`'s row
 * lock (§8.3), and a submit that loses that race gets the segment's real state
 * back rather than a quiet partial success.
 */
function validateRepeater(
  blockId: string,
  fields: readonly FormField[],
  submitted: unknown,
  options: ValidateOptions,
  errors: AnswerErrors,
  dropped: string[],
): BlockAnswer {
  const rowsInput = unwrapRepeater(submitted);
  if (!Array.isArray(rowsInput)) {
    errors[blockId] = 'Expected a list of seats.';
    return { kind: 'repeater', rows: [] };
  }

  const cap = options.limits[blockId];
  if (cap === undefined) {
    // No cap resolved means the segment is not configured. `limits.ts` refuses
    // before the form is ever drawn; reaching here means a caller skipped that,
    // and guessing a number is the one thing that must not happen.
    errors[blockId] = 'This form is not configured yet.';
    return { kind: 'repeater', rows: [] };
  }
  if (rowsInput.length > cap) {
    errors[blockId] =
      cap === 0
        ? 'No seats are available in this section.'
        : `At most ${cap} ${cap === 1 ? 'seat' : 'seats'} may be added here.`;
    return { kind: 'repeater', rows: [] };
  }

  const rows = rowsInput.map((row, index) => {
    const submitted = asRecord(row) ?? {};
    // Each row is its own scope: a per-seat condition reads the same seat and
    // nothing else, which is the only reading of "earlier" that has one meaning
    // inside a repeater (`schema.ts`).
    const coerced: Record<string, FieldValue> = {};
    for (const field of fields) coerced[field.key] = coerce(field, submitted[field.key]);

    return validateFields(
      fields,
      submitted,
      coerced,
      visibleFieldKeys(fields, coerced),
      (key) => fieldPathKey(blockId, key, index),
      errors,
      dropped,
      `${blockId}.${index}`,
    );
  });

  return { kind: 'repeater', rows };
}

/**
 * The fields of one block, validated against a scope that has already been
 * coerced and resolved for visibility.
 *
 * Visibility is decided by the **scope**, not by the block, which is what lets a
 * flat field depend on one in an earlier block. Answers to hidden fields are
 * **dropped, not rejected**: §8.2.2 says a question that was never shown and one
 * that was shown and skipped are both empty, and no downstream logic may depend
 * on the difference. Someone who answers a question, then changes the answer
 * above it so the question disappears, has not made an error.
 */
function validateFields(
  fields: readonly FormField[],
  submitted: Record<string, unknown>,
  coerced: Readonly<Record<string, FieldValue>>,
  visible: ReadonlySet<string>,
  pathFor: (fieldKey: string) => string,
  errors: AnswerErrors,
  dropped: string[],
  scopeLabel: string,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};

  for (const field of fields) {
    if (!visible.has(field.key)) continue;

    const value = coerced[field.key] ?? null;
    const message = checkValue(field, submitted[field.key], value);
    if (message) {
      errors[pathFor(field.key)] = message;
      continue;
    }
    if (!isBlank(value)) values[field.key] = value;
  }

  for (const key of Object.keys(submitted)) {
    if (!fields.some((field) => field.key === key)) dropped.push(`${scopeLabel}.${key}`);
  }

  return values;
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

/**
 * A submitted value in its declared type.
 *
 * **Coercion is not leniency.** Every value from an HTML form arrives as a
 * string, and `"3"` for a number field is the browser doing what browsers do,
 * not a caller being sloppy. What coercion never does is invent: an
 * uninterpretable value becomes `null` and {@link checkValue} reports it against
 * the original.
 */
function coerce(field: FormField, value: unknown): FieldValue {
  if (value === null || value === undefined) return null;

  switch (field.type) {
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value !== 'string' || value.trim() === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'checkbox': {
      if (typeof value === 'boolean') return value;
      // `"on"` is what an unvalued HTML checkbox posts.
      if (value === 'on' || value === 'true') return true;
      if (value === '' || value === 'false' || value === 'off') return false;
      return null;
    }
    case 'multiselect': {
      if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
      // A single-valued multiselect posts one string, not a list of one.
      if (typeof value === 'string') return value === '' ? [] : [value];
      return null;
    }
    default:
      return typeof value === 'string' ? value.trim() : null;
  }
}

/**
 * The longest a single text answer may be.
 *
 * Not an operational value and not a policy an admin tunes: it is a guard, in
 * the same class as the login throttle's `MAX_DOUBLINGS`. The authoring side of
 * the contract caps every string it accepts; without a matching ceiling here a
 * form's *answers* are unbounded, and a 100,000-character name would be stored,
 * exported, and rendered onto a ticket.
 *
 * Set well above any real answer — a paragraph of accessibility notes is a few
 * hundred characters — so a person filling the form honestly can never meet it.
 */
const MAX_ANSWER_LENGTH = 4000;

const emailValue = z.email();
/** `YYYY-MM-DD`, which is what `<input type="date">` posts and what JSON holds. */
const dateValue = z.iso.date();

/** The message to show against a control, or null when the answer is fine. */
function checkValue(field: FormField, submitted: unknown, value: FieldValue): string | null {
  // A value that arrived but did not survive coercion is a wrong type, not a
  // blank one — reporting "this is required" for `{"age": {}}` would be a lie.
  if (value === null && submitted !== null && submitted !== undefined && submitted !== '') {
    return `Enter a valid ${describe(field.type)}.`;
  }

  if (field.type === 'checkbox') {
    // "Required" on a checkbox means ticked. A consent box the reader can
    // satisfy by leaving alone is not a consent box.
    if (field.required && value !== true) return 'Please tick this to continue.';
    return null;
  }

  if (isBlank(value)) return field.required ? 'This is required.' : null;

  if (typeof value === 'string' && value.length > MAX_ANSWER_LENGTH) {
    return `Please keep this under ${MAX_ANSWER_LENGTH} characters.`;
  }

  switch (field.type) {
    case 'email':
      return emailValue.safeParse(value).success ? null : 'Enter a valid email address.';
    case 'date':
      return dateValue.safeParse(value).success ? null : 'Enter a valid date.';
    case 'select':
    case 'radio':
      return offers(field, value) ? null : 'Choose one of the options listed.';
    case 'multiselect': {
      const chosen = Array.isArray(value) ? value : [];
      return chosen.every((entry) => offers(field, entry))
        ? null
        : 'Choose from the options listed.';
    }
    case 'number':
      return typeof value === 'number' ? null : 'Enter a number.';
    default:
      return typeof value === 'string' ? null : `Enter a valid ${describe(field.type)}.`;
  }
}

function offers(field: FormField, value: FieldValue): boolean {
  return (field.options ?? []).some((option) => option.value === value);
}

function describe(type: FormField['type']): string {
  switch (type) {
    case 'email':
      return 'email address';
    case 'tel':
      return 'phone number';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    default:
      return 'answer';
  }
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * A flat block may be posted as `{ values: {…} }` — the shape {@link FormAnswers}
 * uses — or as the bare map. Accepting both means the renderer's own state can
 * be posted straight back without a translation step that could lose a key.
 */
function unwrapFlat(value: unknown): unknown {
  const record = asRecord(value);
  if (record && 'values' in record) return record.values;
  return value;
}

/** The same courtesy for a repeater: `{ rows: [...] }` or a bare array. */
function unwrapRepeater(value: unknown): unknown {
  const record = asRecord(value);
  if (record && 'rows' in record) return record.rows;
  return value;
}

// ---------------------------------------------------------------------------
// Starting state
// ---------------------------------------------------------------------------

/**
 * Empty answers for a schema — what the renderer starts from.
 *
 * Repeaters start with **one row when they have room for one**, because an
 * empty repeater with only an "add" button reads as a section with nothing in
 * it. Where the cap is zero — a player with no base seats left, a party cap of
 * one — it starts empty and the renderer says why.
 */
export function emptyAnswers(
  schema: FormSchema,
  limits: Readonly<Record<string, number>> = {},
): FormAnswers {
  const answers: FormAnswers = {};
  for (const block of schema.blocks) {
    if (isRepeaterType(block.type)) {
      const cap = limits[block.id] ?? 0;
      answers[block.id] = { kind: 'repeater', rows: cap > 0 ? [emptyRow(blockFields(block))] : [] };
    } else {
      answers[block.id] = { kind: 'flat', values: emptyRow(blockFields(block)) };
    }
  }
  return answers;
}

export function emptyRow(fields: readonly FormField[]): Record<string, FieldValue> {
  const row: Record<string, FieldValue> = {};
  for (const field of fields) {
    row[field.key] = field.type === 'multiselect' ? [] : field.type === 'checkbox' ? false : '';
  }
  return row;
}
