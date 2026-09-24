import { describe, expect, it } from 'vitest';
import {
  addCustomBlock,
  addField,
  canDeleteField,
  conditionSources,
  deleteBlock,
  deleteField,
  dropOrphanedConditions,
  duplicateField,
  keyFromLabel,
  moveBlock,
  moveField,
  reorderBlock,
  reorderField,
  restorableSystemFields,
  restoreSystemField,
  updateField,
} from '@/app/(admin)/admin/concerts/[concertId]/forms/builder/operations';
import { parseFormSchema, blockFields, type FormSchema } from '@/lib/forms/schema';
import { blankFormSchema } from '@/lib/forms/templates';

/**
 * The builder's rules (spec/v2.md §8.2, decisions 35 and 37).
 *
 * **These tests exist to fail if the builder ever offers an edit the contract
 * refuses.** `K`'s own suite already proves the contract rejects a schema that
 * deletes `contact_email`, retypes `full_name`, or conditions on a system
 * field. The risk this module adds is different and one layer up: a builder
 * that *produces* such a schema and meets the refusal at save, on a screen the
 * admin has already spent ten minutes in.
 *
 * So every case below does the same thing — ask the operations to break a rule,
 * then assert both that they refused **and** that what came out still parses.
 * The second half is what would catch a refusal that silently corrupted the
 * schema instead.
 */

/** Every operation must leave something the contract accepts. */
function stillValid(schema: FormSchema, note: string): FormSchema {
  const result = parseFormSchema(schema);
  expect(result.ok ? '' : `${note}: ${result.message}`).toBe('');
  if (!result.ok) throw new Error('unreachable');
  return result.schema;
}

function fieldIndex(schema: FormSchema, blockIndex: number, key: string): number {
  return blockFields(schema.blocks[blockIndex]).findIndex((field) => field.key === key);
}

function blockIndexOfType(schema: FormSchema, type: string): number {
  return schema.blocks.findIndex((block) => block.type === type);
}

describe('system blocks cannot be removed or reordered away', () => {
  it('refuses to delete a system block, whichever kind', () => {
    for (const kind of ['PLAYER', 'PUBLIC'] as const) {
      const schema = blankFormSchema(kind);
      const before = schema.blocks.length;

      for (const [index, block] of schema.blocks.entries()) {
        const after = deleteBlock(schema, index);
        if (block.type === 'CUSTOM') continue;
        expect(after.blocks.length, `${kind} ${block.type} was deleted`).toBe(before);
      }
      stillValid(schema, `${kind} after delete attempts`);
    }
  });

  it('refuses to move a custom block above the system blocks', () => {
    const schema = addCustomBlock(blankFormSchema('PUBLIC'));
    const customIndex = schema.blocks.length - 1;

    // One step up would put it above the party repeater, which is a system
    // block — the swap is refused rather than performed.
    const moved = moveBlock(schema, customIndex, -1);
    expect(moved.blocks[customIndex].type).toBe('CUSTOM');
    stillValid(moved, 'after a refused move');

    // Drag-and-drop's arbitrary move is held to the same rule: dropping it at
    // index 0 clamps to the first position a custom block may hold.
    const dragged = reorderBlock(schema, customIndex, 0);
    expect(dragged.blocks[0].type).not.toBe('CUSTOM');
    stillValid(dragged, 'after a clamped drag');
  });

  it('adds custom blocks that parse, on all three kinds', () => {
    for (const kind of ['PLAYER', 'PUBLIC', 'FEEDBACK'] as const) {
      const schema = addCustomBlock(blankFormSchema(kind), 'Extra questions');
      stillValid(schema, `${kind} with an added block`);
      expect(schema.blocks.at(-1)?.type).toBe('CUSTOM');
    }
  });

  it('gives each added block a distinct id', () => {
    let schema = blankFormSchema('FEEDBACK');
    for (let i = 0; i < 4; i += 1) schema = addCustomBlock(schema);
    const ids = schema.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    stillValid(schema, 'four added blocks');
  });
});

describe('locked system fields', () => {
  it('refuses to delete contact_email or full_name, and allows the two optional ones', () => {
    const schema = blankFormSchema('PUBLIC');
    const registrant = blockIndexOfType(schema, 'REGISTRANT');
    const party = blockIndexOfType(schema, 'GUESTS_PARTY');

    const emailIndex = fieldIndex(schema, registrant, 'contact_email');
    expect(deleteField(schema, registrant, emailIndex)).toBe(schema);

    const nameIndex = fieldIndex(schema, party, 'full_name');
    expect(deleteField(schema, party, nameIndex)).toBe(schema);

    // `contact_phone` and the guest `email` are removable — a form may
    // legitimately not ask for either.
    const phoneIndex = fieldIndex(schema, registrant, 'contact_phone');
    const withoutPhone = deleteField(schema, registrant, phoneIndex);
    expect(fieldIndex(withoutPhone, registrant, 'contact_phone')).toBe(-1);
    stillValid(withoutPhone, 'without the phone question');
  });

  it('refuses to retype or unrequire a system field, and still accepts a relabel', () => {
    const schema = blankFormSchema('PLAYER');
    const registrant = blockIndexOfType(schema, 'REGISTRANT');
    const emailIndex = fieldIndex(schema, registrant, 'contact_email');

    const attacked = updateField(schema, registrant, emailIndex, {
      type: 'text',
      required: false,
      label: 'Your email',
      condition: { field: 'anything', op: 'answered' },
    });

    const email = blockFields(attacked.blocks[registrant])[emailIndex];
    expect(email.type).toBe('email');
    expect(email.required).toBe(true);
    expect(email.condition).toBeUndefined();
    // The one part of that patch which is the admin's.
    expect(email.label).toBe('Your email');
    stillValid(attacked, 'after an attempted retype');
  });

  it('puts a removed optional system field back as a system field', () => {
    const schema = blankFormSchema('PUBLIC');
    const registrant = blockIndexOfType(schema, 'REGISTRANT');
    const withoutPhone = deleteField(
      schema,
      registrant,
      fieldIndex(schema, registrant, 'contact_phone'),
    );

    expect(restorableSystemFields(withoutPhone.blocks[registrant]).map((f) => f.key)).toEqual([
      'contact_phone',
    ]);

    const restored = restoreSystemField(withoutPhone, registrant, 'contact_phone');
    const phone = blockFields(restored.blocks[registrant]).find((f) => f.key === 'contact_phone');
    expect(phone?.system).toBe(true);
    expect(phone?.type).toBe('tel');
    stillValid(restored, 'after restoring the phone question');
  });

  it('never lets a custom field wear a reserved key', () => {
    // The key is derived from the label, and "Contact email" derives to
    // `contact_email` — which is the column's name, not a question's.
    const key = keyFromLabel('Contact email', new Set());
    expect(key).not.toBe('contact_email');

    const schema = addField(addCustomBlock(blankFormSchema('PUBLIC')), 2, 'Contact email');
    stillValid(schema, 'a custom field named like a column');
  });

  it('reports the locked fields as undeletable', () => {
    const schema = blankFormSchema('PUBLIC');
    const registrant = schema.blocks[blockIndexOfType(schema, 'REGISTRANT')];
    const byKey = Object.fromEntries(
      blockFields(registrant).map((field) => [field.key, canDeleteField(registrant, field)]),
    );
    expect(byKey).toEqual({ contact_name: false, contact_email: false, contact_phone: true });
  });
});

describe('conditions are custom-to-custom, within one scope', () => {
  /** A public form with two custom questions in the flat scope. */
  function withCustomFields(): FormSchema {
    let schema = addCustomBlock(blankFormSchema('PUBLIC'), 'Extras');
    const index = schema.blocks.length - 1;
    schema = addField(schema, index, 'Dietary needs');
    schema = addField(schema, index, 'Tell us more');
    return schema;
  }

  it('never offers a system field as a source', () => {
    const schema = withCustomFields();
    const index = schema.blocks.length - 1;
    const sources = conditionSources(schema, index, 1);

    expect(sources.map((source) => source.key)).toEqual(['dietary_needs']);
    // Every registrant field is a system field, so none of them may be read.
    expect(sources.some((source) => source.key.startsWith('contact_'))).toBe(false);
  });

  it('offers only earlier fields', () => {
    const schema = withCustomFields();
    const index = schema.blocks.length - 1;
    expect(conditionSources(schema, index, 0)).toEqual([]);
  });

  it('does not let a repeater field read the flat scope, or the reverse', () => {
    let schema = blankFormSchema('PUBLIC');
    const party = blockIndexOfType(schema, 'GUESTS_PARTY');
    schema = addField(schema, party, 'Seat note');
    schema = addCustomBlock(schema, 'Extras');
    const custom = schema.blocks.length - 1;
    schema = addField(schema, custom, 'Anything else');

    // A repeater field sees only its own block's fields.
    const inRepeater = conditionSources(schema, party, blockFields(schema.blocks[party]).length - 1);
    expect(inRepeater.every((source) => source.key !== 'anything_else')).toBe(true);

    // And a flat field never sees into a repeater.
    const inFlat = conditionSources(schema, custom, 0);
    expect(inFlat.every((source) => source.key !== 'seat_note')).toBe(true);
  });

  it('clears a condition when its source is deleted', () => {
    let schema = withCustomFields();
    const index = schema.blocks.length - 1;

    schema = updateField(schema, index, 1, {
      condition: { field: 'dietary_needs', op: 'answered' },
    });
    expect(blockFields(schema.blocks[index])[1].condition).toBeDefined();

    // Deleting the source would leave a condition the contract refuses, so it
    // goes with it rather than blocking the save.
    const after = deleteField(schema, index, 0);
    expect(blockFields(after.blocks[index])[0].condition).toBeUndefined();
    stillValid(after, 'after deleting a condition source');
  });

  it('clears a condition when its source moves after it', () => {
    let schema = withCustomFields();
    const index = schema.blocks.length - 1;
    schema = updateField(schema, index, 1, {
      condition: { field: 'dietary_needs', op: 'answered' },
    });

    const after = moveField(schema, index, 0, 1);
    expect(blockFields(after.blocks[index]).find((f) => f.condition)).toBeUndefined();
    stillValid(after, 'after moving a source below its reader');
  });

  it('clears a condition whose option no longer exists', () => {
    let schema = withCustomFields();
    const index = schema.blocks.length - 1;

    schema = updateField(schema, index, 0, {
      type: 'select',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    });
    schema = updateField(schema, index, 1, {
      condition: { field: 'dietary_needs', op: 'eq', value: 'yes' },
    });
    expect(blockFields(schema.blocks[index])[1].condition).toBeDefined();

    // Renaming the option's value leaves the rule permanently false, which is a
    // question the form silently never asks — so it is dropped, visibly.
    const after = updateField(schema, index, 0, {
      options: [
        { value: 'always', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    });
    expect(blockFields(after.blocks[index])[1].condition).toBeUndefined();
    stillValid(after, 'after renaming an option value');
  });

  it('drops a condition that a block deletion orphaned two blocks later', () => {
    let schema = addCustomBlock(blankFormSchema('PUBLIC'), 'First');
    const first = schema.blocks.length - 1;
    schema = addField(schema, first, 'Coming by car');

    schema = addCustomBlock(schema, 'Second');
    const second = schema.blocks.length - 1;
    schema = addField(schema, second, 'Parking needed');
    schema = updateField(schema, second, 0, {
      condition: { field: 'coming_by_car', op: 'answered' },
    });

    const after = deleteBlock(schema, first);
    const survivor = after.blocks.find((block) => block.title === 'Second');
    expect(blockFields(survivor!)[0].condition).toBeUndefined();
    stillValid(after, 'after deleting a block another block read');
  });

  it('leaves a valid condition alone', () => {
    let schema = withCustomFields();
    const index = schema.blocks.length - 1;
    schema = updateField(schema, index, 1, {
      condition: { field: 'dietary_needs', op: 'answered' },
    });

    expect(dropOrphanedConditions(schema)).toBe(schema);
  });
});

describe('field types and their options', () => {
  it('gives a choice type options, and takes them away again on retype', () => {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = schema.blocks.length - 1;
    schema = addField(schema, index, 'How did you hear about us');

    const asSelect = updateField(schema, index, 0, { type: 'select' });
    expect(blockFields(asSelect.blocks[index])[0].options?.length).toBeGreaterThan(0);
    stillValid(asSelect, 'a select with default options');

    // Carrying the list onto a text field would leave options the renderer
    // ignores and the contract refuses.
    const asText = updateField(asSelect, index, 0, { type: 'text' });
    expect(blockFields(asText.blocks[index])[0].options).toBeUndefined();
    stillValid(asText, 'back to text');
  });

  it('keeps custom field keys unique within a scope', () => {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = schema.blocks.length - 1;
    for (let i = 0; i < 3; i += 1) schema = addField(schema, index, 'Comments');

    const keys = blockFields(schema.blocks[index]).map((field) => field.key);
    expect(new Set(keys).size).toBe(3);
    stillValid(schema, 'three questions with the same label');
  });
});

describe('a draft question’s key follows its label', () => {
  /** A form's keys are what answers are stored under, so this is only safe before any exist. */
  function draftWithQuestion(): { schema: FormSchema; index: number } {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = schema.blocks.length - 1;
    schema = addField(schema, index);
    return { schema, index };
  }

  it('re-derives the key while the form is a draft', () => {
    const { schema, index } = draftWithQuestion();
    expect(blockFields(schema.blocks[index])[0].key).toBe('new_question');

    const renamed = updateField(schema, index, 0, { label: 'Coming by car' }, true);
    expect(blockFields(renamed.blocks[index])[0].key).toBe('coming_by_car');
    stillValid(renamed, 'after a rename in draft');
  });

  it('freezes the key once the form can take answers', () => {
    const { schema, index } = draftWithQuestion();
    // The default, and what an open or closed form passes: answers already
    // given are filed under the old key and must stay findable.
    const renamed = updateField(schema, index, 0, { label: 'Coming by car' });
    expect(blockFields(renamed.blocks[index])[0].key).toBe('new_question');
    expect(blockFields(renamed.blocks[index])[0].label).toBe('Coming by car');
  });

  it('never re-derives a system field’s key', () => {
    const schema = blankFormSchema('PUBLIC');
    const registrant = blockIndexOfType(schema, 'REGISTRANT');
    const emailIndex = fieldIndex(schema, registrant, 'contact_email');

    const renamed = updateField(schema, registrant, emailIndex, { label: 'Your email' }, true);
    expect(blockFields(renamed.blocks[registrant])[emailIndex].key).toBe('contact_email');
    stillValid(renamed, 'after relabelling a system field in draft');
  });

  it('carries a condition that read the old key across the rename', () => {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = schema.blocks.length - 1;
    schema = addField(schema, index, 'Source');
    schema = addField(schema, index, 'Follow up');
    schema = updateField(schema, index, 1, { condition: { field: 'source', op: 'answered' } });

    const renamed = updateField(schema, index, 0, { label: 'How did you hear' }, true);
    const fields = blockFields(renamed.blocks[index]);

    expect(fields[0].key).toBe('how_did_you_hear');
    // The rule follows the question rather than being silently cleared, which
    // is what dropping the orphan would have done.
    expect(fields[1].condition?.field).toBe('how_did_you_hear');
    stillValid(renamed, 'after renaming a condition source');
  });

  it('keeps keys unique when two questions are given the same label', () => {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = schema.blocks.length - 1;
    schema = addField(schema, index, 'One');
    schema = addField(schema, index, 'Two');

    const renamed = updateField(schema, index, 1, { label: 'One' }, true);
    const keys = blockFields(renamed.blocks[index]).map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    stillValid(renamed, 'after a colliding rename');
  });
});

describe('the Google-Forms-shaped edits: insert, duplicate, drag', () => {
  function questions(): { schema: FormSchema; index: number } {
    let schema = addCustomBlock(blankFormSchema('FEEDBACK'), 'Questions');
    const index = schema.blocks.length - 1;
    schema = addField(schema, index, 'First');
    schema = addField(schema, index, 'Second');
    schema = addField(schema, index, 'Third');
    return { schema, index };
  }

  const labels = (schema: FormSchema, index: number) =>
    blockFields(schema.blocks[index]).map((field) => field.label);

  it('adds a question straight after the one being edited', () => {
    const { schema, index } = questions();
    const next = addField(schema, index, 'Inserted', 0);
    expect(labels(next, index)).toEqual(['First', 'Inserted', 'Second', 'Third']);
    stillValid(next, 'after inserting mid-block');
  });

  it('duplicates a custom question under a key of its own', () => {
    const { schema, index } = questions();
    const withOptions = updateField(schema, index, 1, { type: 'radio' });
    const next = duplicateField(withOptions, index, 1);
    const fields = blockFields(next.blocks[index]);

    expect(fields.map((field) => field.label)).toEqual(['First', 'Second', 'Second', 'Third']);
    expect(fields[2].key).not.toBe(fields[1].key);
    expect(fields[2].options).toEqual(fields[1].options);
    // A copy, not a shared reference: editing it must not edit the original.
    expect(fields[2].options).not.toBe(fields[1].options);
    stillValid(next, 'after duplicating');
  });

  it('refuses to duplicate a system field, which would be a second email question', () => {
    const schema = blankFormSchema('PUBLIC');
    const registrant = blockIndexOfType(schema, 'REGISTRANT');
    const email = fieldIndex(schema, registrant, 'contact_email');
    expect(duplicateField(schema, registrant, email)).toBe(schema);
  });

  it('drags a question to a new place in its block', () => {
    const { schema, index } = questions();
    const next = reorderField(schema, index, 0, 2);
    expect(labels(next, index)).toEqual(['Second', 'Third', 'First']);
    stillValid(next, 'after dragging');
  });

  it('clears a condition dragged above the question it reads', () => {
    let { schema } = questions();
    const { index } = questions();
    schema = updateField(schema, index, 1, { condition: { field: 'first', op: 'answered' } });

    const next = reorderField(schema, index, 1, 0);
    expect(blockFields(next.blocks[index])[0].condition).toBeUndefined();
    stillValid(next, 'after dragging a rule above its source');
  });
});
