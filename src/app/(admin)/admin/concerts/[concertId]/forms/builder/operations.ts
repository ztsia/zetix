/**
 * Every edit the builder can make to a schema, as pure functions
 * (spec/v2.md §8.2, decisions 35 and 37).
 *
 * Separated from the React so the rules are testable without a DOM, and so the
 * component is left holding only "which panel is open". The rules are the
 * interesting part:
 *
 * **A system block is never added, deleted or reordered out of existence.** The
 * blocks are pre-built from `kind` and the builder may only add `CUSTOM` ones
 * alongside them. There is no mapping step anywhere in V2 and this is where
 * that stops being an aspiration (decision 35).
 *
 * **A system field's `key`, `type` and `required` are immutable.** Label, help
 * text and placeholder are the admin's. `K`'s contract refuses a schema that
 * breaks this, so anything here that got it wrong would fail at save — these
 * functions exist so it fails at neither, by never offering the edit.
 *
 * **Conditions read and target custom fields only, within one scope.** The
 * offer list is built by {@link conditionSources}, which is the UI half of the
 * same rule the contract enforces.
 *
 * Nothing here parses: these produce a candidate, and `parseFormSchema` on the
 * server is the boundary that judges it. A builder that trusted its own output
 * would be a second implementation of the contract.
 */

import {
  isGridType,
  isOptionType,
  isScaleType,
  type FieldType,
} from '@/lib/forms/field-types';
import { RESERVED_FIELD_KEYS, systemFieldsFor } from '@/lib/forms/system-fields';
import {
  blockFields,
  isRepeaterType,
  type BlockType,
  type FormBlock,
  type FormField,
  type FormSchema,
} from '@/lib/forms/schema';

/** A block the admin may delete or move. Everything else is structural. */
export function isCustomBlock(block: FormBlock): boolean {
  return block.type === 'CUSTOM';
}

/** Whether this field is one of the locked catalogue rows for its block. */
export function isSystemField(block: FormBlock, field: FormField): boolean {
  return field.system === true && systemFieldsFor(block.type).some((s) => s.key === field.key);
}

/** Whether the admin may remove this field — `contact_phone` and guest `email` only. */
export function canDeleteField(block: FormBlock, field: FormField): boolean {
  if (!field.system) return true;
  const spec = systemFieldsFor(block.type).find((s) => s.key === field.key);
  return spec?.removable === true;
}

/**
 * A system field the admin previously removed, and may put back.
 *
 * Without this, deleting the phone question is irreversible short of recreating
 * the form: the builder cannot offer it as a *new* field, because a custom
 * field may not wear a reserved key. Offering the catalogue row back is the
 * only way to restore it as the system field it was.
 */
export function restorableSystemFields(block: FormBlock): { key: string; label: string }[] {
  const present = new Set(blockFields(block).map((field) => field.key));
  return systemFieldsFor(block.type)
    .filter((spec) => spec.removable && !present.has(spec.key))
    .map((spec) => ({ key: spec.key, label: spec.defaultLabel }));
}

function replaceBlock(schema: FormSchema, index: number, block: FormBlock): FormSchema {
  const blocks = [...schema.blocks];
  blocks[index] = block;
  return { ...schema, blocks };
}

/**
 * Put fields back on a block, under whichever key that block type holds them.
 *
 * The cast is unavoidable and narrow: the three repeater types share one union
 * member, so TypeScript cannot narrow the discriminant to it from
 * `isRepeaterType` — the same reason `blockFields` reaches for `in` rather than
 * a `type` comparison. What is written is always the key the block already had.
 */
function withFields(block: FormBlock, fields: FormField[]): FormBlock {
  return ('guest_fields' in block
    ? { ...block, guest_fields: fields }
    : { ...block, fields }) as FormBlock;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * A block id that is unique, readable and legal.
 *
 * Ids are identifiers in the contract — lowercase, no dashes — and they are
 * also what `form_responses.raw` is keyed by, so they outlive the form. A
 * counter is used rather than a random suffix because a payload someone reads
 * two years later should say `questions2`, not `block_k3f9`.
 */
export function nextBlockId(schema: FormSchema, base = 'questions'): string {
  const taken = new Set(schema.blocks.map((block) => block.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

export function addCustomBlock(schema: FormSchema, title = 'More questions'): FormSchema {
  return {
    ...schema,
    blocks: [
      ...schema.blocks,
      { id: nextBlockId(schema), type: 'CUSTOM', title, fields: [] },
    ],
  };
}

export function deleteBlock(schema: FormSchema, index: number): FormSchema {
  const block = schema.blocks[index];
  if (!block || !isCustomBlock(block)) return schema;

  const blocks = schema.blocks.filter((_, i) => i !== index);
  // A condition may only read a field in its own scope, and a flat scope spans
  // blocks — so deleting a block can orphan a condition two blocks later. The
  // contract would refuse the save; clearing them here means the admin meets
  // the consequence at the moment they cause it.
  return dropOrphanedConditions({ ...schema, blocks });
}

/**
 * Move a block, keeping the system blocks where the kind put them.
 *
 * Only custom blocks move, and they may not be moved above the last system
 * block: a form that asked "anything else?" before it asked who you are reads
 * as broken, and on a public form the registrant block is seat #1, which is not
 * a question that belongs in the middle.
 */
export function moveBlock(schema: FormSchema, index: number, direction: -1 | 1): FormSchema {
  const target = index + direction;
  const block = schema.blocks[index];
  const other = schema.blocks[target];
  if (!block || !other) return schema;
  if (!isCustomBlock(block) || !isCustomBlock(other)) return schema;

  const blocks = [...schema.blocks];
  blocks[index] = other;
  blocks[target] = block;
  return { ...schema, blocks };
}

/** Drag-and-drop's arbitrary move, held to the same rule as the buttons. */
export function reorderBlock(schema: FormSchema, from: number, to: number): FormSchema {
  const block = schema.blocks[from];
  if (!block || !isCustomBlock(block)) return schema;

  const firstCustom = schema.blocks.findIndex(isCustomBlock);
  const clamped = Math.max(firstCustom, Math.min(to, schema.blocks.length - 1));
  if (clamped === from) return schema;

  const blocks = [...schema.blocks];
  blocks.splice(from, 1);
  blocks.splice(clamped, 0, block);
  return { ...schema, blocks };
}

export function updateBlockCopy(
  schema: FormSchema,
  index: number,
  patch: { title?: string; description_md?: string | null; add_label?: string | null },
): FormSchema {
  const block = schema.blocks[index];
  if (!block) return schema;

  const next: FormBlock = { ...block };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description_md !== undefined) {
    if (patch.description_md) next.description_md = patch.description_md;
    else delete next.description_md;
  }
  if (patch.add_label !== undefined && isRepeaterType(next.type)) {
    const repeater = next as Extract<FormBlock, { add_label?: string }>;
    if (patch.add_label) repeater.add_label = patch.add_label;
    else delete repeater.add_label;
  }
  return replaceBlock(schema, index, next);
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * A key for a new custom field.
 *
 * Derived from the label so `registrations.custom` reads like the questions
 * that filled it, and checked against the reserved set: a custom field keyed
 * `contact_email` would sit in the queryable copy under a name that reads
 * exactly like the column it is not.
 */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^([0-9])/, 'q$1')
      .slice(0, 56) || 'question';

  let candidate = base;
  let n = 2;
  while (taken.has(candidate) || RESERVED_FIELD_KEYS.has(candidate)) {
    candidate = `${base}_${n}`;
    n += 1;
  }
  return candidate;
}

/** Every key already used in this field's scope — the uniqueness the contract checks. */
export function keysInScope(schema: FormSchema, blockIndex: number): Set<string> {
  const block = schema.blocks[blockIndex];
  if (!block) return new Set();

  if (isRepeaterType(block.type)) {
    return new Set(blockFields(block).map((field) => field.key));
  }
  return new Set(
    schema.blocks
      .filter((candidate) => !isRepeaterType(candidate.type))
      .flatMap((candidate) => blockFields(candidate).map((field) => field.key)),
  );
}

export function addField(schema: FormSchema, blockIndex: number, label = 'New question'): FormSchema {
  const block = schema.blocks[blockIndex];
  if (!block) return schema;

  const field: FormField = {
    key: keyFromLabel(label, keysInScope(schema, blockIndex)),
    label,
    type: 'text',
    system: false,
    required: false,
  };
  return replaceBlock(schema, blockIndex, withFields(block, [...blockFields(block), field]));
}

/** Put a removed system field back, as the catalogue row it was. */
export function restoreSystemField(
  schema: FormSchema,
  blockIndex: number,
  key: string,
): FormSchema {
  const block = schema.blocks[blockIndex];
  if (!block) return schema;

  const spec = systemFieldsFor(block.type).find((candidate) => candidate.key === key);
  if (!spec || blockFields(block).some((field) => field.key === key)) return schema;

  const field: FormField = {
    key: spec.key,
    label: spec.defaultLabel,
    type: spec.type,
    system: true,
    required: spec.required,
  };

  // System fields sit above custom ones: they are the block's own questions,
  // and the catalogue's order is the order the form was designed in.
  const fields = [...blockFields(block)];
  const firstCustom = fields.findIndex((candidate) => !candidate.system);
  fields.splice(firstCustom === -1 ? fields.length : firstCustom, 0, field);
  return replaceBlock(schema, blockIndex, withFields(block, fields));
}

export function deleteField(schema: FormSchema, blockIndex: number, fieldIndex: number): FormSchema {
  const block = schema.blocks[blockIndex];
  if (!block) return schema;

  const fields = blockFields(block);
  const field = fields[fieldIndex];
  if (!field || !canDeleteField(block, field)) return schema;

  const next = replaceBlock(
    schema,
    blockIndex,
    withFields(
      block,
      fields.filter((_, i) => i !== fieldIndex),
    ),
  );
  return dropOrphanedConditions(next);
}

export function moveField(
  schema: FormSchema,
  blockIndex: number,
  fieldIndex: number,
  direction: -1 | 1,
): FormSchema {
  const block = schema.blocks[blockIndex];
  if (!block) return schema;

  const fields = [...blockFields(block)];
  const target = fieldIndex + direction;
  if (!fields[fieldIndex] || !fields[target]) return schema;

  [fields[fieldIndex], fields[target]] = [fields[target], fields[fieldIndex]];
  // Moving a field above the answer its condition reads would make the rule
  // unreadable, so the move is allowed and the stale condition is cleared —
  // visible, rather than refused with an explanation nobody asked for.
  return dropOrphanedConditions(replaceBlock(schema, blockIndex, withFields(block, fields)));
}

export type FieldPatch = {
  label?: string;
  help_md?: string | null;
  placeholder?: string | null;
  type?: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[] | null;
  rows?: { value: string; label: string }[] | null;
  scale?: FormField['scale'] | null;
  condition?: FormField['condition'] | null;
};

/**
 * Edit one field, refusing the three properties a system field owns.
 *
 * The UI already renders those as locked rows; this refuses them again because
 * "the control was disabled" is not a guarantee, and the difference between a
 * disabled input and an immutable value is the whole of decision 35.
 */
export function updateField(
  schema: FormSchema,
  blockIndex: number,
  fieldIndex: number,
  patch: FieldPatch,
  /**
   * Whether a custom field's `key` may follow its label.
   *
   * **True only while the form is a `DRAFT`.** A key is what an answer is
   * stored under in `registrations.custom` and `attendees.custom` (§8.2.3), so
   * once anyone can have answered, it is frozen: re-deriving it then would
   * leave the answers already given filed under a name nothing looks for.
   *
   * Before that it must follow, or a question added and then written keeps the
   * placeholder it was created with — `new_question`, `new_question_2` — and
   * the export columns and custom payloads read like a form nobody finished.
   */
  rekey = false,
): FormSchema {
  const block = schema.blocks[blockIndex];
  if (!block) return schema;

  const fields = [...blockFields(block)];
  const field = fields[fieldIndex];
  if (!field) return schema;

  const locked = isSystemField(block, field);
  const next: FormField = { ...field };

  if (patch.label !== undefined) next.label = patch.label;

  /**
   * The key follows the label while that is still safe, and every condition
   * that reads this field follows with it.
   *
   * Rewriting the readers is the half that is easy to miss: leaving them
   * pointing at the old key would strand the rule, and `dropOrphanedConditions`
   * would then quietly clear it — an admin would watch their own show/hide rule
   * disappear for renaming a question.
   */
  let renamedFrom: string | null = null;
  if (rekey && !locked && patch.label !== undefined && patch.label.trim() !== '') {
    const taken = keysInScope(schema, blockIndex);
    taken.delete(field.key);
    const candidate = keyFromLabel(patch.label, taken);
    if (candidate !== field.key) {
      renamedFrom = field.key;
      next.key = candidate;
    }
  }
  if (patch.help_md !== undefined) {
    if (patch.help_md) next.help_md = patch.help_md;
    else delete next.help_md;
  }
  if (patch.placeholder !== undefined) {
    if (patch.placeholder) next.placeholder = patch.placeholder;
    else delete next.placeholder;
  }

  if (!locked) {
    if (patch.required !== undefined) next.required = patch.required;

    if (patch.type !== undefined && patch.type !== next.type) {
      next.type = patch.type;
      /**
       * Each of the three config shapes belongs to its own set of types and to
       * no other. Carrying one across a retype would leave a list or a range
       * the renderer ignores and the contract refuses; dropping it is the
       * honest half of the same rule.
       *
       * **Provisioned rather than left empty**, because every one of these is
       * required by the contract the moment the type is chosen — a grid with no
       * rows will not save, and making the admin discover that by pressing Save
       * is a worse introduction to the type than starting them with one row.
       *
       * A list already in hand survives the move: retyping a drop-down to a
       * multiple-choice grid keeps the choices as the grid's columns, which is
       * what an admin who built the list means by the change.
       */
      if (isOptionType(patch.type)) {
        next.options = next.options?.length
          ? next.options
          : [{ value: 'option_1', label: 'Option 1' }];
      } else {
        delete next.options;
      }

      if (isGridType(patch.type)) {
        next.rows = next.rows?.length ? next.rows : [{ value: 'row_1', label: 'Row 1' }];
      } else {
        delete next.rows;
      }

      /**
       * A rating is a scale whose floor is 1, so the bottom is forced rather
       * than carried: a 0–5 linear scale retyped to stars must not become a
       * six-star rating whose first star means nothing.
       */
      if (isScaleType(patch.type)) {
        const carried = next.scale;
        next.scale =
          patch.type === 'rating'
            ? { min: 1, max: carried?.max ?? 5 }
            : (carried ?? { min: 1, max: 5 });
      } else {
        delete next.scale;
      }
    }

    if (patch.options !== undefined) {
      if (patch.options && isOptionType(next.type)) next.options = patch.options;
      else delete next.options;
    }

    if (patch.rows !== undefined) {
      if (patch.rows && isGridType(next.type)) next.rows = patch.rows;
      else delete next.rows;
    }

    if (patch.scale !== undefined) {
      if (patch.scale && isScaleType(next.type)) next.scale = patch.scale;
      else delete next.scale;
    }

    if (patch.condition !== undefined) {
      if (patch.condition) next.condition = patch.condition;
      else delete next.condition;
    }
  }

  fields[fieldIndex] = next;
  const updated = replaceBlock(schema, blockIndex, withFields(block, fields));
  return dropOrphanedConditions(
    renamedFrom === null ? updated : repointConditions(updated, renamedFrom, next.key),
  );
}

/** Follow a renamed key through every condition that reads it. */
function repointConditions(schema: FormSchema, from: string, to: string): FormSchema {
  return {
    ...schema,
    blocks: schema.blocks.map((block) =>
      withFields(
        block,
        blockFields(block).map((field) =>
          field.condition?.field === from
            ? { ...field, condition: { ...field.condition, field: to } }
            : field,
        ),
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export type ConditionSource = {
  key: string;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
};

/**
 * The fields this one's condition may read — the offer list, built to the same
 * rule the contract enforces (decision 37, and `K`'s scope narrowing).
 *
 * Three filters, and each is a rule rather than a nicety:
 *
 * - **custom only**, because a rule that could hide the email question would
 *   put the allocation path under something assembled in a UI
 * - **earlier only**, because a condition reading a later answer has no answer
 *   to read on first render
 * - **same scope only** — the flat scope spans every `REGISTRANT` and `CUSTOM`
 *   block, and each repeater is its own. A repeater field reading a flat one
 *   would hide row 3's question because of something typed at the top of the
 *   page, which is not what an admin who wrote "show this when they picked X"
 *   meant.
 */
export function conditionSources(
  schema: FormSchema,
  blockIndex: number,
  fieldIndex: number,
): ConditionSource[] {
  const block = schema.blocks[blockIndex];
  if (!block) return [];

  const usable = (field: FormField): ConditionSource | null =>
    field.system ? null : { key: field.key, label: field.label, type: field.type, options: field.options };

  if (isRepeaterType(block.type)) {
    return blockFields(block)
      .slice(0, fieldIndex)
      .map(usable)
      .filter((source): source is ConditionSource => source !== null);
  }

  const sources: ConditionSource[] = [];
  for (const [index, candidate] of schema.blocks.entries()) {
    if (isRepeaterType(candidate.type)) continue;
    if (index > blockIndex) break;
    const fields = blockFields(candidate);
    const upTo = index === blockIndex ? fieldIndex : fields.length;
    for (const field of fields.slice(0, upTo)) {
      const source = usable(field);
      if (source) sources.push(source);
    }
  }
  return sources;
}

/**
 * Clear conditions whose source has gone, moved after them, or changed shape.
 *
 * Run after every structural edit. The alternative is a save the contract
 * refuses with a message about a field the admin just deleted on purpose — or,
 * worse for an `eq` against a renamed option, a condition that is permanently
 * false and a question the form silently never asks.
 */
export function dropOrphanedConditions(schema: FormSchema): FormSchema {
  let changed = false;

  const blocks = schema.blocks.map((block, blockIndex) => {
    const fields = blockFields(block);
    let blockChanged = false;

    const next = fields.map((field, fieldIndex) => {
      if (!field.condition) return field;

      const sources = conditionSources(schema, blockIndex, fieldIndex);
      const source = sources.find((candidate) => candidate.key === field.condition?.field);

      const stillValid =
        source !== undefined &&
        !field.system &&
        opAllowed(field.condition.op, source.type) &&
        valueAllowed(field.condition, source);

      if (stillValid) return field;

      changed = true;
      blockChanged = true;
      const stripped: FormField = { ...field };
      delete stripped.condition;
      return stripped;
    });

    return blockChanged ? withFields(block, next) : block;
  });

  return changed ? { ...schema, blocks } : schema;
}

/** Which operators make sense against a source's type — the contract's pairing rule. */
export function opAllowed(op: string, sourceType: FieldType): boolean {
  if (op === 'answered' || op === 'blank') return true;
  if (sourceType === 'multiselect') return op === 'contains';
  return op !== 'contains';
}

function valueAllowed(condition: NonNullable<FormField['condition']>, source: ConditionSource): boolean {
  if (condition.op === 'answered' || condition.op === 'blank') return condition.value === undefined;
  if (condition.value === undefined) return false;
  if (condition.op === 'in' && !Array.isArray(condition.value)) return false;
  if (condition.op !== 'in' && Array.isArray(condition.value)) return false;

  if (!source.options) return true;
  const offered = new Set(source.options.map((option) => option.value));
  const wanted = Array.isArray(condition.value) ? condition.value : [condition.value];
  return wanted.every((value) => offered.has(String(value)));
}

/** What a block is called on screen. The type is jargon; this is not. */
export const BLOCK_LABEL: Record<BlockType, string> = {
  REGISTRANT: 'Your details',
  GUESTS_BASE: 'Base seats',
  GUESTS_EXTRA: 'Extra seats',
  GUESTS_PARTY: 'The party',
  CUSTOM: 'Questions',
};

/** One line saying what a block does and where its answers land. */
export const BLOCK_HELP: Record<BlockType, string> = {
  REGISTRANT: 'The registrant’s own details. Its key questions are fixed, and its answers become the registration’s contact fields.',
  GUESTS_BASE: 'One row per base seat. Each row becomes an attendee with a ticket of their own.',
  GUESTS_EXTRA: 'One row per extra seat requested. Requests join the queue; they are not granted here.',
  GUESTS_PARTY: 'One row per additional guest. The registrant is already seat #1, so this asks for the rest.',
  CUSTOM: 'Your own questions. Answers are stored with the registration and appear in the export.',
};
