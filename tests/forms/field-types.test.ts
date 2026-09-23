import { describe, expect, it } from 'vitest';
import { parseFormSchema, type FormField, type FormSchema } from '@/lib/forms/schema';
import { validateAnswers } from '@/lib/forms/answers';
import { updateField } from '@/app/(admin)/admin/concerts/[concertId]/forms/builder/operations';
import { FIELD_TYPES, FIELD_TYPE_GROUPS, FIELD_TYPE_LABELS, isBlank } from '@/lib/forms/field-types';
import { clone, FEEDBACK_FORM } from './fixtures';

/**
 * The five types added so the builder covers what Google Forms covers
 * (spec/v2.md §8.2): linear scale, rating, time, and the two grids.
 *
 * **The interesting cases are the config rules and the bounds**, not that a
 * type parses. A grid with columns and no rows, a scale whose top is below its
 * bottom, an answer outside the range the admin set — each of those is a form
 * that renders but cannot be answered honestly, and each is refused here.
 */

/** A FEEDBACK form carrying one custom field, which is the smallest thing that holds a type. */
function formWith(field: Partial<FormField> & { type: FormField['type'] }): FormSchema {
  const form = clone(FEEDBACK_FORM);
  const block = form.blocks[0];
  if (!('fields' in block)) throw new Error('fixture changed shape');
  block.fields = [
    {
      key: 'q',
      label: 'A question',
      system: false,
      required: false,
      ...field,
    } as FormField,
  ];
  return form;
}

function refuse(value: unknown): string {
  const result = parseFormSchema(value);
  expect(result.ok, 'expected a refusal, got a valid schema').toBe(false);
  return result.ok ? '' : result.message;
}

function accept(value: unknown): FormSchema {
  const result = parseFormSchema(value);
  expect(result.ok ? '' : result.message).toBe('');
  if (!result.ok) throw new Error('unreachable');
  return result.schema;
}

/** Answer the single field of a `formWith` schema. */
function answer(schema: FormSchema, value: unknown) {
  return validateAnswers(schema, { evening: { q: value } }, { limits: {} });
}

describe('the catalogue', () => {
  it('offers every type in the picker, and names every one', () => {
    const grouped = FIELD_TYPE_GROUPS.flatMap((group) => group.types);
    // A type added to FIELD_TYPES and not to a group is a type no admin can
    // choose; one in two groups appears twice. Both are silent in the UI.
    expect([...grouped].sort()).toEqual([...FIELD_TYPES].sort());
    for (const type of FIELD_TYPES) {
      expect(FIELD_TYPE_LABELS[type].label, type).toBeTruthy();
    }
  });

  it('never shows the internal name to an admin', () => {
    // "textarea" is the one that would read worst; the rule is general.
    for (const type of FIELD_TYPES) {
      expect(FIELD_TYPE_LABELS[type].label).not.toBe(type);
    }
  });
});

describe('scale and rating', () => {
  it('accepts a scale with bounds and end labels', () => {
    const schema = accept(
      formWith({ type: 'scale', scale: { min: 1, max: 5, min_label: 'Poor', max_label: 'Great' } }),
    );
    expect(schema.blocks[0]).toBeTruthy();
  });

  it('refuses a scale with no bounds at all', () => {
    expect(refuse(formWith({ type: 'scale' }))).toMatch(/needs a scale/i);
  });

  it('accepts the tightest scale the bounds allow', () => {
    // `min` caps at 1 and `max` floors at 2, so a top below a bottom cannot be
    // expressed — the cross-field check in the contract is defence for a future
    // change to those caps, not a reachable refusal today. Asserting the pair
    // is *accepted* is the honest test; asserting a refusal would pass only
    // because the zod shape rejected it for an unrelated reason.
    accept(formWith({ type: 'scale', scale: { min: 1, max: 2 } }));
  });

  it('refuses a top beyond what fits a phone', () => {
    expect(refuse(formWith({ type: 'scale', scale: { min: 1, max: 11 } }))).toBeTruthy();
  });

  it('refuses bounds on a type that has none', () => {
    expect(refuse(formWith({ type: 'text', scale: { min: 1, max: 5 } }))).toMatch(
      /take a scale/i,
    );
  });

  it('takes a number, and a numeric string from a form post', () => {
    const schema = accept(formWith({ type: 'scale', scale: { min: 1, max: 5 } }));
    for (const submitted of [4, '4']) {
      const result = answer(schema, submitted);
      expect(result.ok, String(submitted)).toBe(true);
      if (result.ok) expect(result.answers.evening).toMatchObject({ values: { q: 4 } });
    }
  });

  it('refuses an answer outside the bounds the admin set', () => {
    const schema = accept(formWith({ type: 'scale', scale: { min: 1, max: 5 } }));
    const result = answer(schema, 9);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors['evening.q']).toMatch(/between 1 and 5/);
  });

  it('refuses a fraction, which is not a step on the scale', () => {
    const schema = accept(formWith({ type: 'rating', scale: { min: 1, max: 5 } }));
    const result = answer(schema, 3.5);
    expect(result.ok).toBe(false);
  });
});

describe('grids', () => {
  const grid = {
    type: 'grid_radio' as const,
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    rows: [
      { value: 'sound', label: 'Sound' },
      { value: 'seats', label: 'Seats' },
    ],
  };

  it('accepts columns and rows', () => {
    accept(formWith(grid));
  });

  it('refuses a grid with no rows — a header with nothing under it', () => {
    const { rows: _rows, ...noRows } = grid;
    expect(refuse(formWith(noRows))).toMatch(/needs at least one row/i);
  });

  it('refuses a grid with no columns', () => {
    const { options: _options, ...noColumns } = grid;
    expect(refuse(formWith(noColumns))).toMatch(/needs at least one column/i);
  });

  it('refuses duplicate row values, which would collide in the answer map', () => {
    expect(
      refuse(
        formWith({
          ...grid,
          rows: [
            { value: 'sound', label: 'Sound' },
            { value: 'sound', label: 'Sound again' },
          ],
        }),
      ),
    ).toMatch(/duplicate row value/i);
  });

  it('refuses rows on a type that has none', () => {
    expect(refuse(formWith({ type: 'text', rows: grid.rows }))).toMatch(/take rows/i);
  });

  it('stores one value per row', () => {
    const schema = accept(formWith(grid));
    const result = answer(schema, { sound: 'yes', seats: 'no' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answers.evening).toMatchObject({
        values: { q: { sound: 'yes', seats: 'no' } },
      });
    }
  });

  it('keeps a list per row for a tick box grid, in column order', () => {
    const schema = accept(formWith({ ...grid, type: 'grid_checkbox' }));
    // Submitted out of order: the stored list follows the schema so two
    // responses stay comparable.
    const result = answer(schema, { sound: ['no', 'yes'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answers.evening).toMatchObject({ values: { q: { sound: ['yes', 'no'] } } });
    }
  });

  it('refuses a row the form never asked about', () => {
    const schema = accept(formWith(grid));
    const result = answer(schema, { lighting: 'yes' });
    expect(result.ok).toBe(false);
  });

  it('refuses a column the form never offered', () => {
    const schema = accept(formWith(grid));
    const result = answer(schema, { sound: 'maybe' });
    expect(result.ok).toBe(false);
  });

  it('a required grid means every row, not merely one of them', () => {
    const schema = accept(formWith({ ...grid, required: true }));
    const partial = answer(schema, { sound: 'yes' });
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.errors['evening.q']).toMatch(/every row/i);

    expect(answer(schema, { sound: 'yes', seats: 'no' }).ok).toBe(true);
  });

  it('counts an empty row map as blank', () => {
    expect(isBlank({})).toBe(true);
    expect(isBlank({ sound: [] })).toBe(true);
    expect(isBlank({ sound: 'yes' })).toBe(false);
  });
});

describe('time', () => {
  it('takes HH:MM and refuses prose', () => {
    const schema = accept(formWith({ type: 'time' }));
    expect(answer(schema, '19:30').ok).toBe(true);
    expect(answer(schema, 'half seven').ok).toBe(false);
  });
});

describe('retyping a question', () => {
  /** The builder's own edit path, which is what an admin actually presses. */
  function retype(from: FormField['type'], to: FormField['type'], extra: Partial<FormField> = {}) {
    const schema = accept(formWith({ type: from, ...extra }));
    const next = updateField(schema, 0, 0, { type: to });
    const block = next.blocks[0];
    if (!('fields' in block)) throw new Error('shape changed');
    return block.fields[0];
  }

  it('provisions a row and a column when a question becomes a grid', () => {
    const field = retype('text', 'grid_radio');
    // Left empty, the contract would refuse the very next save — so the admin
    // would meet the rule by pressing Save rather than by seeing a grid.
    expect(field.rows?.length).toBe(1);
    expect(field.options?.length).toBe(1);
    expect(parseFormSchema(formWith(field)).ok).toBe(true);
  });

  it('carries an existing choice list across to the grid as its columns', () => {
    const field = retype('select', 'grid_radio', {
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    expect(field.options?.map((o) => o.value)).toEqual(['a', 'b']);
  });

  it('forces a rating to start at one star', () => {
    // A 0–5 scale retyped to stars must not become a six-star rating whose
    // first star means nothing.
    const field = retype('scale', 'rating', { scale: { min: 0, max: 5 } });
    expect(field.scale).toMatchObject({ min: 1 });
  });

  it('drops config the new type does not own', () => {
    const field = retype('grid_radio', 'text', {
      options: [{ value: 'a', label: 'A' }],
      rows: [{ value: 'r', label: 'R' }],
    });
    expect(field.options).toBeUndefined();
    expect(field.rows).toBeUndefined();
    expect(field.scale).toBeUndefined();
  });
});
