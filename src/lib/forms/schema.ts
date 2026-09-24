/**
 * The zod contract for the form JSON (spec/v2.md §8.2).
 *
 * **One schema, three uses** — the builder (`L`), the renderer (`M`, `L`'s
 * preview) and submit validation (`M`) — which is `CLAUDE.md`'s convention and
 * the reason this module is built once, before any of them start.
 *
 * The parse is not a formality. Four properties are guaranteed *here* or they
 * are guaranteed nowhere:
 *
 * 1. **System fields are immutable.** A schema that deletes `contact_email`,
 *    retypes `full_name`, or relaxes either one's `required` is refused
 *    (decision 35, `system-fields.ts`).
 * 2. **Conditions are custom-to-custom.** A condition naming a system field as
 *    source or target is a schema error, not a runtime no-op (decision 37,
 *    `conditions.ts`).
 * 3. **The block composition matches the kind.** A player form has base seats, a
 *    public form has a party repeater and its registrant is seat #1, a feedback
 *    form has no seat blocks at all (§8.1.1, §8.1.2, §13.5, decisions 3 and 36).
 * 4. **Keys are unique and unreserved**, so an answer can only ever land in one
 *    place and a custom answer can never wear a column's name.
 *
 * Everything downstream — the renderer, `answers.ts`, the exporter — reads a
 * `FormSchema` and may assume all four. Nothing downstream re-checks them,
 * which is why they are checked once and loudly.
 */

import { z } from 'zod';
import {
  FIELD_TYPES,
  GRID_FIELD_TYPES,
  OPTION_FIELD_TYPES,
  SCALE_FIELD_TYPES,
  isGridType,
  isOptionType,
  isScaleType,
} from './field-types';
import { CONDITION_OPS, PRESENCE_OPS, type Condition } from './conditions';
import { RESERVED_FIELD_KEYS, systemFieldsFor, type SystemFieldSpec } from './system-fields';

/** The three kinds, from `registration_forms.kind` (spec/v2.md §8.1). */
export const FORM_KINDS = ['PLAYER', 'PUBLIC', 'FEEDBACK'] as const;
export type FormKind = (typeof FORM_KINDS)[number];

/** The five block types (§8.2). */
export const BLOCK_TYPES = [
  'REGISTRANT',
  'GUESTS_BASE',
  'GUESTS_EXTRA',
  'GUESTS_PARTY',
  'CUSTOM',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** The three block types that render a repeater — one row per seat. */
export const REPEATER_BLOCK_TYPES = ['GUESTS_BASE', 'GUESTS_EXTRA', 'GUESTS_PARTY'] as const;
export type RepeaterBlockType = (typeof REPEATER_BLOCK_TYPES)[number];

export function isRepeaterType(type: BlockType): type is RepeaterBlockType {
  return (REPEATER_BLOCK_TYPES as readonly string[]).includes(type);
}

/**
 * Identifiers an admin never types and a URL never carries, so the rule can be
 * strict: lowercase, starts with a letter, no dashes.
 *
 * Custom field keys become object keys in `registrations.custom` and
 * `attendees.custom` (§8.2.3), where they are read back by exports and admin
 * filters. A key that needs quoting in a `->>` is a key that will eventually be
 * quoted wrong.
 */
const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase letters, digits and underscores, starting with a letter')
  .max(64);

const optionSchema = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
});

const conditionSchema = z.object({
  field: identifier,
  op: z.enum(CONDITION_OPS),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .optional(),
});

const fieldSchema = z.object({
  key: identifier,
  label: z.string().min(1).max(300),
  type: z.enum(FIELD_TYPES),
  /**
   * Whether this row is one of the locked system fields. It is not a hint: a
   * field claiming `system` that is not in the catalogue is refused, and a
   * catalogue field that omits the flag is refused too. The flag and the
   * catalogue have to agree, or the flag means nothing.
   */
  system: z.boolean().optional().default(false),
  required: z.boolean().optional().default(false),
  help_md: z.string().max(2000).optional(),
  placeholder: z.string().max(200).optional(),
  /** Choices down the page on a choice field; the **columns** on a grid. */
  options: z.array(optionSchema).max(100).optional(),
  /** A grid's **rows**. Refused on every other type. */
  rows: z.array(optionSchema).max(50).optional(),
  /**
   * The bounds for `scale` and `rating`.
   *
   * `min` is 0 or 1 because those are the only floors a linear scale offers
   * and a rating is always 1; `max` stops at 10 because a row of eleven
   * radio buttons does not fit a phone, which is the surface this is answered
   * on (`surfaces.md` §15).
   */
  scale: z
    .object({
      min: z.number().int().min(0).max(1),
      max: z.number().int().min(2).max(10),
      min_label: z.string().max(100).optional(),
      max_label: z.string().max(100).optional(),
    })
    .optional(),
  condition: conditionSchema.optional(),
});

export type FormField = z.output<typeof fieldSchema>;

const blockBase = {
  id: identifier,
  title: z.string().min(1).max(300),
  description_md: z.string().max(5000).optional(),
};

const registrantBlockSchema = z.object({
  ...blockBase,
  type: z.literal('REGISTRANT'),
  /**
   * Whether the registrant's own details also produce attendee #1
   * (§8.1.2, decision 36).
   *
   * `true` on a public form and `false` on a player form, and both are checked
   * below rather than left to the builder: a player consumes zero seats in their
   * own show (decision 3), and a public registrant is always one of the N.
   * Getting this wrong is exactly the off-by-one-ticket-per-party failure
   * decision 35 exists to prevent.
   */
  creates_seat: z.boolean(),
  fields: z.array(fieldSchema).max(100),
});

const repeaterBlockSchema = z.object({
  ...blockBase,
  type: z.enum(REPEATER_BLOCK_TYPES),
  /** The label on the "add another" control. Copy, not a cap. */
  add_label: z.string().min(1).max(100).optional(),
  guest_fields: z.array(fieldSchema).max(100),
});

const customBlockSchema = z.object({
  ...blockBase,
  type: z.literal('CUSTOM'),
  fields: z.array(fieldSchema).max(100),
});

const blockSchema = z.discriminatedUnion('type', [
  registrantBlockSchema,
  repeaterBlockSchema,
  customBlockSchema,
]);

export type FormBlock = z.output<typeof blockSchema>;
export type RegistrantBlock = z.output<typeof registrantBlockSchema>;
export type RepeaterBlock = z.output<typeof repeaterBlockSchema>;
export type CustomBlock = z.output<typeof customBlockSchema>;

/** The fields of any block, whichever key holds them. */
export function blockFields(block: FormBlock): readonly FormField[] {
  // `in` rather than a `type` comparison: the three repeater types share one
  // union member, so TypeScript cannot narrow the discriminant to it.
  return 'guest_fields' in block ? block.guest_fields : block.fields;
}

/**
 * Every field of the **flat scope**, in document order across all flat blocks.
 *
 * This is the unit a condition resolves against, not the block — see
 * {@link checkScopes}. The renderer and `answers.ts` both walk it, so a field
 * whose source lives two blocks earlier is drawn and required by the same rule
 * the contract accepted it under.
 */
export function flatScopeFields(schema: FormSchema): FormField[] {
  return schema.blocks
    .filter((block) => !isRepeaterType(block.type))
    .flatMap((block) => [...blockFields(block)]);
}

const formShape = z.object({
  kind: z.enum(FORM_KINDS),
  blocks: z.array(blockSchema).min(1).max(50),
});

/**
 * The contract. Parse with {@link parseFormSchema} rather than calling this
 * directly, so a failure carries a message someone can act on.
 */
export const formSchema = formShape.superRefine(checkForm);

export type FormSchema = z.output<typeof formShape>;

// ---------------------------------------------------------------------------
// Cross-cutting rules. Everything zod cannot say declaratively lives here.
// ---------------------------------------------------------------------------

type Ctx = z.core.$RefinementCtx<z.output<typeof formShape>>;

function reject(ctx: Ctx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

function checkForm(form: z.output<typeof formShape>, ctx: Ctx): void {
  checkBlockIdsUnique(form, ctx);
  checkComposition(form, ctx);

  for (const [index, block] of form.blocks.entries()) {
    checkSystemFields(block, index, ctx);
    for (const [fieldIndex, field] of blockFields(block).entries()) {
      checkFieldShape(field, [...fieldPath(block, index), fieldIndex], ctx);
    }
  }

  checkScopes(form, ctx);
}

/** `blocks.<i>.fields` or `blocks.<i>.guest_fields`, so an issue points at the real JSON. */
function fieldPath(block: FormBlock, index: number): (string | number)[] {
  return ['blocks', index, isRepeaterType(block.type) ? 'guest_fields' : 'fields'];
}

function checkBlockIdsUnique(form: z.output<typeof formShape>, ctx: Ctx): void {
  const seen = new Set<string>();
  for (const [index, block] of form.blocks.entries()) {
    if (seen.has(block.id)) {
      reject(ctx, ['blocks', index, 'id'], `Duplicate block id "${block.id}".`);
    }
    seen.add(block.id);
  }
}

/**
 * Which blocks each kind must, may and may not have (§8.1.1, §8.1.2, §13.5).
 *
 * `GUESTS_EXTRA` is optional on a player form: a round that offers no extras is
 * a real configuration, and `form.extra_rows_max` resolving to zero would
 * otherwise render an empty block with an "add" button that does nothing.
 * Everything else is exact — a public form without its party repeater cannot
 * take a party, and a player form without base seats cannot take the seats the
 * player is entitled to.
 */
const COMPOSITION: Record<
  FormKind,
  { exactlyOne: BlockType[]; atMostOne: BlockType[]; forbidden: BlockType[] }
> = {
  PLAYER: {
    exactlyOne: ['REGISTRANT', 'GUESTS_BASE'],
    atMostOne: ['GUESTS_EXTRA'],
    forbidden: ['GUESTS_PARTY'],
  },
  PUBLIC: {
    exactlyOne: ['REGISTRANT', 'GUESTS_PARTY'],
    atMostOne: [],
    forbidden: ['GUESTS_BASE', 'GUESTS_EXTRA'],
  },
  /**
   * A feedback form creates no seats and asks for no identity: the attendee is
   * resolved from their own `qr_token` before the form is drawn (§13.5). So it
   * carries `CUSTOM` blocks and nothing else — a `REGISTRANT` block here would
   * ask a known person who they are, and its `contact_email` would be a second,
   * unverified copy of an address we already hold.
   */
  FEEDBACK: {
    exactlyOne: [],
    atMostOne: [],
    forbidden: ['REGISTRANT', 'GUESTS_BASE', 'GUESTS_EXTRA', 'GUESTS_PARTY'],
  },
};

function checkComposition(form: z.output<typeof formShape>, ctx: Ctx): void {
  const rules = COMPOSITION[form.kind];
  const count = (type: BlockType) => form.blocks.filter((b) => b.type === type).length;

  for (const type of rules.exactlyOne) {
    const n = count(type);
    if (n !== 1) {
      reject(
        ctx,
        ['blocks'],
        `A ${form.kind} form needs exactly one ${type} block; found ${n}.`,
      );
    }
  }

  for (const type of rules.atMostOne) {
    if (count(type) > 1) {
      reject(ctx, ['blocks'], `A ${form.kind} form may have at most one ${type} block.`);
    }
  }

  for (const [index, block] of form.blocks.entries()) {
    if (rules.forbidden.includes(block.type)) {
      reject(
        ctx,
        ['blocks', index, 'type'],
        `A ${form.kind} form may not have a ${block.type} block.`,
      );
    }
  }

  checkCreatesSeat(form, ctx);
}

/**
 * `creates_seat` is decided by the kind, not by the builder.
 *
 * On a public form the registrant is seat #1 (decision 36). On a player form the
 * player is a performer and holds no attendee row in the player segment of their
 * own show (decision 3) — a `true` here would issue one ticket too many to every
 * player, in a segment whose base quota is already fully committed.
 */
function checkCreatesSeat(form: z.output<typeof formShape>, ctx: Ctx): void {
  for (const [index, block] of form.blocks.entries()) {
    if (block.type !== 'REGISTRANT') continue;
    const expected = form.kind === 'PUBLIC';
    if (block.creates_seat !== expected) {
      reject(
        ctx,
        ['blocks', index, 'creates_seat'],
        form.kind === 'PUBLIC'
          ? 'The public registrant is seat #1, so creates_seat must be true (decision 36).'
          : 'A player consumes no seat in their own show, so creates_seat must be false (decision 3).',
      );
    }
  }
}

/**
 * The system catalogue, checked in both directions.
 *
 * Missing a locked field, altering one, marking a custom field `system`, or
 * failing to mark a catalogue field `system` are all the same bug wearing four
 * faces: the schema no longer says what it means, and the mapping stops being
 * unfalsifiable.
 */
function checkSystemFields(block: FormBlock, index: number, ctx: Ctx): void {
  const catalogue = systemFieldsFor(block.type);
  const byKey = new Map(catalogue.map((spec) => [spec.key, spec]));
  const path = fieldPath(block, index);
  const fields = blockFields(block);
  const present = new Set<string>();

  for (const [fieldIndex, field] of fields.entries()) {
    const spec = byKey.get(field.key);
    const at = [...path, fieldIndex];

    if (spec && !field.system) {
      reject(ctx, [...at, 'system'], `"${field.key}" is a system field and must be marked system.`);
    }
    if (!spec && field.system) {
      reject(
        ctx,
        [...at, 'system'],
        `"${field.key}" is not a system field of a ${block.type} block and may not be marked system.`,
      );
    }
    if (!spec) continue;

    present.add(spec.key);
    checkLocked(field, spec, at, ctx);
  }

  for (const spec of catalogue) {
    if (spec.removable || present.has(spec.key)) continue;
    reject(ctx, path, `A ${block.type} block must keep its "${spec.key}" field; it cannot be removed.`);
  }
}

/**
 * Label, help text and placeholder are the admin's. `key`, `type` and `required`
 * are not (§8.2).
 */
function checkLocked(
  field: FormField,
  spec: SystemFieldSpec,
  at: (string | number)[],
  ctx: Ctx,
): void {
  if (field.type !== spec.type) {
    reject(
      ctx,
      [...at, 'type'],
      `"${spec.key}" is locked to type "${spec.type}" and cannot be changed to "${field.type}".`,
    );
  }
  if (field.required !== spec.required) {
    reject(
      ctx,
      [...at, 'required'],
      `"${spec.key}" is locked to required=${spec.required} and cannot be changed.`,
    );
  }
  if (field.condition) {
    reject(
      ctx,
      [...at, 'condition'],
      `"${spec.key}" is a system field and can never be hidden by a condition (decision 37).`,
    );
  }
  if (field.options) {
    reject(ctx, [...at, 'options'], `"${spec.key}" is a system field and takes no options.`);
  }
}

/** Per-field rules that need nothing but the field itself. */
function checkFieldShape(field: FormField, at: (string | number)[], ctx: Ctx): void {
  if (!field.system && RESERVED_FIELD_KEYS.has(field.key)) {
    reject(
      ctx,
      [...at, 'key'],
      `"${field.key}" is reserved for a system field and cannot be used by a custom field.`,
    );
  }

  /**
   * `options` means "the choices down the page" on a choice field and "the
   * columns" on a grid, so both require it and everything else refuses it.
   */
  if (isOptionType(field.type)) {
    const what = isGridType(field.type) ? 'column' : 'option';
    if (!field.options || field.options.length === 0) {
      reject(ctx, [...at, 'options'], `A "${field.type}" field needs at least one ${what}.`);
    } else {
      const seen = new Set<string>();
      for (const [i, option] of field.options.entries()) {
        if (seen.has(option.value)) {
          reject(ctx, [...at, 'options', i, 'value'], `Duplicate ${what} value "${option.value}".`);
        }
        seen.add(option.value);
      }
    }
  } else if (field.options) {
    reject(
      ctx,
      [...at, 'options'],
      `Only ${OPTION_FIELD_TYPES.join(', ')} fields take options; "${field.type}" does not.`,
    );
  }

  /**
   * `rows` is the grid's other axis. A grid with columns and no rows renders a
   * header and nothing under it, which is a form that cannot be answered —
   * refused here rather than discovered by the first guest.
   */
  if (isGridType(field.type)) {
    if (!field.rows || field.rows.length === 0) {
      reject(ctx, [...at, 'rows'], `A "${field.type}" field needs at least one row.`);
    } else {
      const seen = new Set<string>();
      for (const [i, row] of field.rows.entries()) {
        if (seen.has(row.value)) {
          reject(ctx, [...at, 'rows', i, 'value'], `Duplicate row value "${row.value}".`);
        }
        seen.add(row.value);
      }
    }
  } else if (field.rows) {
    reject(
      ctx,
      [...at, 'rows'],
      `Only ${GRID_FIELD_TYPES.join(', ')} fields take rows; "${field.type}" does not.`,
    );
  }

  /**
   * A scale needs its bounds, and they have to be the right way round. The zod
   * shape already caps each end; what it cannot see is the pair.
   */
  if (isScaleType(field.type)) {
    if (!field.scale) {
      reject(ctx, [...at, 'scale'], `A "${field.type}" field needs a scale.`);
    } else if (field.scale.max <= field.scale.min) {
      reject(
        ctx,
        [...at, 'scale', 'max'],
        `A scale's top (${field.scale.max}) must be above its bottom (${field.scale.min}).`,
      );
    }
  } else if (field.scale) {
    reject(
      ctx,
      [...at, 'scale'],
      `Only ${SCALE_FIELD_TYPES.join(', ')} fields take a scale; "${field.type}" does not.`,
    );
  }
}

/**
 * Key uniqueness and condition wiring, per scope.
 *
 * **Two scopes, and the split is what keeps a condition unambiguous.**
 *
 * - The **flat scope** is every field of every `REGISTRANT` and `CUSTOM` block,
 *   in document order. One answer each, so a condition can name any earlier one.
 * - A **repeater scope** is the `guest_fields` of one repeater block. Those
 *   fields have one answer *per row*, so a condition there reads the same row
 *   and nothing else.
 *
 * Crossing the two is refused in both directions. A flat field reading a
 * repeater field has no answer to read — *which* guest? — and a repeater field
 * reading a flat field would be a rule that hides row 3's question because of
 * something typed at the top of the page, which is not what an admin who wrote
 * "show this when they picked X" meant. §8.2.2 asks only for "an earlier custom
 * field"; this is the reading of "earlier" that has exactly one meaning in a
 * repeater.
 */
function checkScopes(form: z.output<typeof formShape>, ctx: Ctx): void {
  const flat: { field: FormField; at: (string | number)[] }[] = [];

  for (const [index, block] of form.blocks.entries()) {
    const path = fieldPath(block, index);
    const entries = blockFields(block).map((field, fieldIndex) => ({
      field,
      at: [...path, fieldIndex],
    }));

    if (isRepeaterType(block.type)) {
      checkScope(entries, ctx, `the "${block.id}" block`);
    } else {
      flat.push(...entries);
    }
  }

  checkScope(flat, ctx, 'this form');
}

function checkScope(
  entries: { field: FormField; at: (string | number)[] }[],
  ctx: Ctx,
  scopeLabel: string,
): void {
  const seen = new Map<string, FormField>();

  for (const { field, at } of entries) {
    if (seen.has(field.key)) {
      reject(ctx, [...at, 'key'], `Duplicate field key "${field.key}" in ${scopeLabel}.`);
    }

    if (field.condition) checkCondition(field, field.condition, seen, at, scopeLabel, ctx);

    seen.set(field.key, field);
  }
}

function checkCondition(
  field: FormField,
  condition: Condition,
  earlier: ReadonlyMap<string, FormField>,
  at: (string | number)[],
  scopeLabel: string,
  ctx: Ctx,
): void {
  const path = [...at, 'condition'];

  // The target. A system field never carries one; `checkLocked` already says so
  // for a field the catalogue knows, and this catches the rest.
  if (field.system) {
    reject(ctx, path, `"${field.key}" is a system field and can never be a condition's target (decision 37).`);
    return;
  }

  const source = earlier.get(condition.field);
  if (!source) {
    reject(
      ctx,
      [...path, 'field'],
      `A condition may only read a custom field defined earlier in ${scopeLabel}; "${condition.field}" is not one.`,
    );
    return;
  }

  // The source. This is the half that would silently stop a form asking for an
  // email, so it is refused loudly rather than ignored at render time.
  if (source.system) {
    reject(
      ctx,
      [...path, 'field'],
      `A condition may never read the system field "${condition.field}" (decision 37).`,
    );
    return;
  }

  checkConditionValue(condition, source, path, ctx);
}

/** The operator has to make sense against the type of the field it reads. */
function checkConditionValue(
  condition: Condition,
  source: FormField,
  path: (string | number)[],
  ctx: Ctx,
): void {
  const takesValue = !PRESENCE_OPS.includes(condition.op);

  if (!takesValue) {
    if (condition.value !== undefined) {
      reject(ctx, [...path, 'value'], `"${condition.op}" takes no value.`);
    }
    return;
  }

  if (condition.value === undefined) {
    reject(ctx, [...path, 'value'], `"${condition.op}" needs a value.`);
    return;
  }

  if (condition.op === 'in' && !Array.isArray(condition.value)) {
    reject(ctx, [...path, 'value'], '"in" needs an array of values.');
    return;
  }
  if (condition.op !== 'in' && Array.isArray(condition.value)) {
    reject(ctx, [...path, 'value'], `"${condition.op}" takes a single value, not an array.`);
    return;
  }

  if (condition.op === 'contains' && source.type !== 'multiselect') {
    reject(
      ctx,
      [...path, 'op'],
      `"contains" reads a multiselect; "${condition.field}" is a "${source.type}" field.`,
    );
    return;
  }
  if (condition.op !== 'contains' && source.type === 'multiselect') {
    reject(
      ctx,
      [...path, 'op'],
      `"${condition.field}" is a multiselect; read it with "contains", "answered" or "blank".`,
    );
    return;
  }

  checkValueAgainstOptions(condition, source, path, ctx);
}

/**
 * A condition against a choice field must name a value the field actually
 * offers.
 *
 * This is the one rule that catches the common editing accident: renaming an
 * option's value leaves every condition that read it permanently false, and a
 * permanently false condition is a question the form silently never asks.
 */
function checkValueAgainstOptions(
  condition: Condition,
  source: FormField,
  path: (string | number)[],
  ctx: Ctx,
): void {
  if (!source.options) return;

  const offered = new Set(source.options.map((option) => option.value));
  const wanted = Array.isArray(condition.value) ? condition.value : [condition.value];

  for (const [i, value] of wanted.entries()) {
    if (value === undefined || offered.has(String(value))) continue;
    reject(
      ctx,
      Array.isArray(condition.value) ? [...path, 'value', i] : [...path, 'value'],
      `"${String(value)}" is not an option of "${condition.field}".`,
    );
  }
}

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; schema: FormSchema }
  | { ok: false; message: string; issues: z.core.$ZodIssue[] };

/**
 * Parse untrusted form JSON — from the builder, from `registration_forms.schema`,
 * or from a pinned `form_responses.form_schema`.
 *
 * **A failure carries a message someone can act on.** The builder shows it, and
 * a schema read back from a row that predates a rule shows it too rather than
 * rendering half a form: an admin who cannot see *which* field is wrong will
 * work around the boundary instead of fixing the schema, and the boundary is the
 * only thing holding decisions 35 and 37 up.
 */
export function parseFormSchema(value: unknown): ParseResult {
  const result = formSchema.safeParse(value);
  if (result.success) return { ok: true, schema: result.data };
  return {
    ok: false,
    message: formatIssues(result.error.issues),
    issues: result.error.issues,
  };
}

/** Throwing variant, for a schema that has already been validated once. */
export function assertFormSchema(value: unknown): FormSchema {
  const result = parseFormSchema(value);
  if (!result.ok) throw new InvalidFormSchemaError(result.message, result.issues);
  return result.schema;
}

export class InvalidFormSchemaError extends Error {
  constructor(
    message: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(message);
    this.name = 'InvalidFormSchemaError';
  }
}

/**
 * `blocks.1.guest_fields.0.type: …` — the JSON path first, because that is what
 * the reader has to go and change.
 *
 * Every issue is listed, not just the first. A builder save that broke three
 * things should say three things; reporting one at a time turns one fix into
 * three round trips.
 */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) return 'Invalid form schema.';
  return issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('\n');
}
