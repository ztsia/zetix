import { describe, expect, it } from 'vitest';
import {
  assertFormSchema,
  blockFields,
  InvalidFormSchemaError,
  parseFormSchema,
  type FormSchema,
} from '@/lib/forms/schema';
import { clone, FEEDBACK_FORM, PLAYER_FORM, PUBLIC_FORM } from './fixtures';

/**
 * The zod contract (spec/v2.md §8.2, decisions 35 and 37).
 *
 * These tests are the module's reason for existing. `docs/modules-v2.md` names
 * three refusals by name — deleting `contact_email`, retyping `full_name`,
 * conditioning on a system field — and each has a test below that fails if the
 * boundary stops holding.
 */

/** Parse and expect a refusal, returning the message so a test can read it. */
function refuse(value: unknown): string {
  const result = parseFormSchema(value);
  expect(result.ok, `expected a refusal, got a valid schema`).toBe(false);
  return result.ok ? '' : result.message;
}

/** Parse and expect acceptance. */
function accept(value: unknown): FormSchema {
  const result = parseFormSchema(value);
  expect(result.ok ? '' : result.message).toBe('');
  if (!result.ok) throw new Error('unreachable');
  return result.schema;
}

/** The `REGISTRANT` block of a fixture, for tests that edit it. */
function registrant(form: FormSchema) {
  const block = form.blocks.find((b) => b.type === 'REGISTRANT');
  if (!block || block.type !== 'REGISTRANT') throw new Error('fixture has no REGISTRANT block');
  return block;
}

/** The first repeater block of a fixture. */
function repeater(form: FormSchema) {
  const block = form.blocks.find((b) => 'guest_fields' in b);
  if (!block || !('guest_fields' in block)) throw new Error('fixture has no repeater block');
  return block;
}

describe('the three fixtures', () => {
  it('all parse', () => {
    accept(PLAYER_FORM);
    accept(PUBLIC_FORM);
    accept(FEEDBACK_FORM);
  });

  it('survive a JSON round trip, which is how they reach the database', () => {
    for (const fixture of [PLAYER_FORM, PUBLIC_FORM, FEEDBACK_FORM]) {
      expect(accept(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
    }
  });

  it('between them render every one of the ten field types', () => {
    const used = new Set<string>();
    for (const fixture of [PLAYER_FORM, PUBLIC_FORM, FEEDBACK_FORM]) {
      for (const block of fixture.blocks) {
        for (const field of blockFields(block)) used.add(field.type);
      }
    }
    expect([...used].sort()).toEqual([
      'checkbox',
      'date',
      'email',
      'multiselect',
      'number',
      'radio',
      'select',
      'tel',
      'text',
      'textarea',
    ]);
  });
});

describe('system fields are immutable (decision 35)', () => {
  it('refuses a schema that deletes contact_email', () => {
    const form = clone(PUBLIC_FORM);
    const block = registrant(form);
    block.fields = block.fields.filter((f) => f.key !== 'contact_email');
    expect(refuse(form)).toContain('must keep its "contact_email" field');
  });

  it('refuses a schema that deletes contact_name', () => {
    const form = clone(PLAYER_FORM);
    const block = registrant(form);
    block.fields = block.fields.filter((f) => f.key !== 'contact_name');
    expect(refuse(form)).toContain('must keep its "contact_name" field');
  });

  it('refuses a schema that deletes full_name from a repeater', () => {
    const form = clone(PLAYER_FORM);
    const block = repeater(form);
    block.guest_fields = block.guest_fields.filter((f) => f.key !== 'full_name');
    expect(refuse(form)).toContain('must keep its "full_name" field');
  });

  it('refuses a schema that retypes full_name', () => {
    const form = clone(PLAYER_FORM);
    const block = repeater(form);
    const field = block.guest_fields.find((f) => f.key === 'full_name');
    if (!field) throw new Error('no full_name');
    field.type = 'number';
    expect(refuse(form)).toContain('"full_name" is locked to type "text"');
  });

  it('refuses a schema that retypes contact_email to text', () => {
    const form = clone(PUBLIC_FORM);
    const field = registrant(form).fields.find((f) => f.key === 'contact_email');
    if (!field) throw new Error('no contact_email');
    field.type = 'text';
    expect(refuse(form)).toContain('locked to type "email"');
  });

  it('refuses making a locked field optional', () => {
    const form = clone(PUBLIC_FORM);
    const field = registrant(form).fields.find((f) => f.key === 'contact_email');
    if (!field) throw new Error('no contact_email');
    field.required = false;
    expect(refuse(form)).toContain('locked to required=true');
  });

  it('refuses making a removable system field required', () => {
    // An admin cannot promote the optional guest email either — `required` is
    // locked in both directions (§8.2).
    const form = clone(PLAYER_FORM);
    const field = repeater(form).guest_fields.find((f) => f.key === 'email');
    if (!field) throw new Error('no guest email');
    field.required = true;
    expect(refuse(form)).toContain('locked to required=false');
  });

  it('allows editing a system field label, help text and placeholder', () => {
    const form = clone(PUBLIC_FORM);
    const field = registrant(form).fields.find((f) => f.key === 'contact_email');
    if (!field) throw new Error('no contact_email');
    field.label = 'Where should we send your tickets?';
    field.help_md = 'We only use this to send your tickets.';
    field.placeholder = 'you@example.com';
    accept(form);
  });

  it('allows dropping the two removable system fields', () => {
    const form = clone(PLAYER_FORM);
    const block = registrant(form);
    block.fields = block.fields.filter((f) => f.key !== 'contact_phone');
    const seats = repeater(form);
    seats.guest_fields = seats.guest_fields.filter((f) => f.key !== 'email');
    accept(form);
  });

  it('refuses a custom field wearing a system key', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block || block.type !== 'CUSTOM') throw new Error('bad fixture');
    block.fields.push({ key: 'contact_email', label: 'Your email', type: 'email', system: false, required: false });
    expect(refuse(form)).toContain('reserved for a system field');
  });

  it('refuses a system field that forgets its flag', () => {
    const form = clone(PUBLIC_FORM);
    const field = registrant(form).fields.find((f) => f.key === 'contact_name');
    if (!field) throw new Error('no contact_name');
    field.system = false;
    expect(refuse(form)).toContain('must be marked system');
  });

  it('refuses a custom field claiming the flag', () => {
    const form = clone(PLAYER_FORM);
    const field = repeater(form).guest_fields.find((f) => f.key === 'seat_note');
    if (!field) throw new Error('no seat_note');
    field.system = true;
    expect(refuse(form)).toContain('may not be marked system');
  });
});

describe('conditions are custom-to-custom (decision 37)', () => {
  it('refuses a condition that reads a system field', () => {
    const form = clone(PUBLIC_FORM);
    const block = registrant(form);
    block.fields.push({
      key: 'billing_note',
      label: 'Anything else?',
      type: 'text',
      system: false,
      required: false,
      condition: { field: 'contact_email', op: 'answered' },
    });
    expect(refuse(form)).toContain('may never read the system field "contact_email"');
  });

  it('refuses a condition that targets a system field', () => {
    const form = clone(PUBLIC_FORM);
    const block = registrant(form);
    const field = block.fields.find((f) => f.key === 'contact_email');
    if (!field) throw new Error('no contact_email');
    field.condition = { field: 'heard_from', op: 'eq', value: 'social' };
    expect(refuse(form)).toContain('can never be hidden by a condition');
  });

  it('refuses a condition that targets a seat name', () => {
    const form = clone(PLAYER_FORM);
    const block = repeater(form);
    const field = block.guest_fields.find((f) => f.key === 'full_name');
    if (!field) throw new Error('no full_name');
    field.condition = { field: 'seat_note', op: 'answered' };
    expect(refuse(form)).toContain('can never be hidden by a condition');
  });

  it('refuses a condition reading a field defined later', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block || block.type !== 'CUSTOM') throw new Error('bad fixture');
    const highlight = block.fields.find((f) => f.key === 'highlight');
    if (!highlight) throw new Error('no highlight');
    highlight.condition = { field: 'come_again', op: 'eq', value: 'no' };
    expect(refuse(form)).toContain('defined earlier');
  });

  it('refuses a condition reading a field that does not exist', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block || block.type !== 'CUSTOM') throw new Error('bad fixture');
    const highlight = block.fields.find((f) => f.key === 'highlight');
    if (!highlight) throw new Error('no highlight');
    highlight.condition = { field: 'nonexistent', op: 'answered' };
    expect(refuse(form)).toContain('"nonexistent" is not one');
  });

  it('refuses a repeater field reading a flat field from an earlier block', () => {
    // Unambiguous to a human, ambiguous to nobody — and still refused, because
    // "show row 3's question because of something typed at the top of the page"
    // is not what the builder's UI offers.
    const form = clone(PLAYER_FORM);
    const seats = repeater(form);
    const note = seats.guest_fields.find((f) => f.key === 'seat_note');
    if (!note) throw new Error('no seat_note');
    note.condition = { field: 'contact_name', op: 'answered' };
    expect(refuse(form)).toContain('defined earlier');
  });

  it('refuses a flat field reading a repeater field — there is no single answer to read', () => {
    const form = clone(PLAYER_FORM);
    const logistics = form.blocks.find((b) => b.id === 'logistics');
    if (!logistics || logistics.type !== 'CUSTOM') throw new Error('bad fixture');
    const accessibility = logistics.fields.find((f) => f.key === 'accessibility');
    if (!accessibility) throw new Error('no accessibility');
    accessibility.condition = { field: 'seat_note', op: 'answered' };
    expect(refuse(form)).toContain('defined earlier');
  });

  it('allows a condition across two flat blocks, where one answer means one thing', () => {
    const form = clone(PUBLIC_FORM);
    const extras = form.blocks.find((b) => b.id === 'extras');
    if (!extras || extras.type !== 'CUSTOM') throw new Error('bad fixture');
    extras.fields.push({
      key: 'poster_where',
      label: 'Where did you see it?',
      type: 'text',
      system: false,
      required: false,
      // `heard_from` lives in the REGISTRANT block, two blocks earlier.
      condition: { field: 'heard_from', op: 'eq', value: 'poster' },
    });
    accept(form);
  });

  it('refuses a condition naming an option value the source does not offer', () => {
    const form = clone(PUBLIC_FORM);
    const field = registrant(form).fields.find((f) => f.key === 'social_handle');
    if (!field) throw new Error('no social_handle');
    field.condition = { field: 'heard_from', op: 'eq', value: 'radio_advert' };
    expect(refuse(form)).toContain('is not an option of "heard_from"');
  });

  it('refuses "contains" against anything but a multiselect', () => {
    const form = clone(PUBLIC_FORM);
    const field = registrant(form).fields.find((f) => f.key === 'social_handle');
    if (!field) throw new Error('no social_handle');
    field.condition = { field: 'heard_from', op: 'contains', value: 'social' };
    expect(refuse(form)).toContain('"contains" reads a multiselect');
  });

  it('refuses "eq" against a multiselect', () => {
    const form = clone(PUBLIC_FORM);
    const extras = form.blocks.find((b) => b.id === 'extras');
    if (!extras || extras.type !== 'CUSTOM') throw new Error('bad fixture');
    const instrument = extras.fields.find((f) => f.key === 'instrument');
    if (!instrument) throw new Error('no instrument');
    instrument.condition = { field: 'interests', op: 'eq', value: 'joining' };
    expect(refuse(form)).toContain('read it with "contains"');
  });

  it('refuses a presence operator carrying a value, and a value operator without one', () => {
    const withValue = clone(FEEDBACK_FORM);
    const a = withValue.blocks[0];
    if (!a || a.type !== 'CUSTOM') throw new Error('bad fixture');
    const target = a.fields.find((f) => f.key === 'what_went_wrong');
    if (!target) throw new Error('no what_went_wrong');
    target.condition = { field: 'overall', op: 'answered', value: '1' };
    expect(refuse(withValue)).toContain('takes no value');

    const without = clone(FEEDBACK_FORM);
    const b = without.blocks[0];
    if (!b || b.type !== 'CUSTOM') throw new Error('bad fixture');
    const target2 = b.fields.find((f) => f.key === 'what_went_wrong');
    if (!target2) throw new Error('no what_went_wrong');
    target2.condition = { field: 'overall', op: 'eq' };
    expect(refuse(without)).toContain('needs a value');
  });
});

describe('block composition matches the kind', () => {
  it('refuses a player form with a public party repeater', () => {
    const form = clone(PLAYER_FORM);
    const base = repeater(form);
    base.type = 'GUESTS_PARTY';
    expect(refuse(form)).toMatch(/may not have a GUESTS_PARTY block|needs exactly one GUESTS_BASE/);
  });

  it('refuses a public form with base seats', () => {
    const form = clone(PUBLIC_FORM);
    const party = repeater(form);
    party.type = 'GUESTS_BASE';
    expect(refuse(form)).toMatch(/may not have a GUESTS_BASE block|needs exactly one GUESTS_PARTY/);
  });

  it('refuses a feedback form with any seat block', () => {
    const form = clone(FEEDBACK_FORM);
    form.blocks.push({
      id: 'party',
      type: 'GUESTS_PARTY',
      title: 'Guests',
      guest_fields: [{ key: 'full_name', label: 'Name', type: 'text', system: true, required: true }],
    });
    expect(refuse(form)).toContain('may not have a GUESTS_PARTY block');
  });

  it('refuses a feedback form that asks who the attendee is — we already know', () => {
    const form = clone(FEEDBACK_FORM);
    form.blocks.unshift({
      id: 'registrant',
      type: 'REGISTRANT',
      title: 'Your details',
      creates_seat: false,
      fields: [
        { key: 'contact_name', label: 'Name', type: 'text', system: true, required: true },
        { key: 'contact_email', label: 'Email', type: 'email', system: true, required: true },
      ],
    });
    expect(refuse(form)).toContain('may not have a REGISTRANT block');
  });

  it('refuses a player form with no base seats', () => {
    const form = clone(PLAYER_FORM);
    form.blocks = form.blocks.filter((b) => b.type !== 'GUESTS_BASE');
    expect(refuse(form)).toContain('needs exactly one GUESTS_BASE block');
  });

  it('allows a player form with no extras block', () => {
    const form = clone(PLAYER_FORM);
    form.blocks = form.blocks.filter((b) => b.type !== 'GUESTS_EXTRA');
    accept(form);
  });

  it('refuses two registrant blocks', () => {
    const form = clone(PUBLIC_FORM);
    form.blocks.push({ ...clone(registrant(form)), id: 'registrant_two' });
    expect(refuse(form)).toContain('needs exactly one REGISTRANT block');
  });

  it('refuses duplicate block ids', () => {
    const form = clone(FEEDBACK_FORM);
    form.blocks.push({ id: 'evening', type: 'CUSTOM', title: 'Again', fields: [] });
    expect(refuse(form)).toContain('Duplicate block id "evening"');
  });
});

describe('creates_seat is decided by the kind, not by the builder', () => {
  it('refuses a public registrant that creates no seat (decision 36)', () => {
    const form = clone(PUBLIC_FORM);
    registrant(form).creates_seat = false;
    expect(refuse(form)).toContain('creates_seat must be true');
  });

  it('refuses a player registrant that creates one (decision 3)', () => {
    const form = clone(PLAYER_FORM);
    registrant(form).creates_seat = true;
    expect(refuse(form)).toContain('creates_seat must be false');
  });
});

describe('keys and options', () => {
  it('refuses a duplicate key inside one repeater', () => {
    const form = clone(PLAYER_FORM);
    const block = repeater(form);
    block.guest_fields.push({ key: 'seat_note', label: 'Again', type: 'text', system: false, required: false });
    expect(refuse(form)).toContain('Duplicate field key "seat_note"');
  });

  it('refuses a duplicate key across two flat blocks', () => {
    const form = clone(PUBLIC_FORM);
    const extras = form.blocks.find((b) => b.id === 'extras');
    if (!extras || extras.type !== 'CUSTOM') throw new Error('bad fixture');
    extras.fields.push({ key: 'heard_from', label: 'Again', type: 'text', system: false, required: false });
    expect(refuse(form)).toContain('Duplicate field key "heard_from"');
  });

  it('allows the same custom key in two different repeaters — they are separate scopes', () => {
    const form = clone(PLAYER_FORM);
    const extras = form.blocks.find((b) => b.type === 'GUESTS_EXTRA');
    if (!extras || !('guest_fields' in extras)) throw new Error('bad fixture');
    extras.guest_fields.push({ key: 'seat_note', label: 'Anything we should know?', type: 'text', system: false, required: false });
    accept(form);
  });

  it('refuses a choice field with no options', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block || block.type !== 'CUSTOM') throw new Error('bad fixture');
    const overall = block.fields.find((f) => f.key === 'overall');
    if (!overall) throw new Error('no overall');
    delete overall.options;
    expect(refuse(form)).toContain('needs at least one option');
  });

  it('refuses options on a field that renders none', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block || block.type !== 'CUSTOM') throw new Error('bad fixture');
    const highlight = block.fields.find((f) => f.key === 'highlight');
    if (!highlight) throw new Error('no highlight');
    highlight.options = [{ value: 'a', label: 'A' }];
    expect(refuse(form)).toContain('does not');
  });

  it('refuses duplicate option values', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block || block.type !== 'CUSTOM') throw new Error('bad fixture');
    const overall = block.fields.find((f) => f.key === 'overall');
    if (!overall?.options) throw new Error('no overall');
    overall.options.push({ value: '5', label: 'Wonderful again' });
    expect(refuse(form)).toContain('Duplicate option value "5"');
  });

  it('refuses a key that is not a usable jsonb key', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block || block.type !== 'CUSTOM') throw new Error('bad fixture');
    block.fields.push({ key: 'Was It Good?', label: 'Was it good?', type: 'text', system: false, required: false } as never);
    expect(refuse(form)).toContain('lowercase letters');
  });
});

describe('the boundary reports something usable', () => {
  it('names the JSON path of every problem, not just the first', () => {
    const form = clone(PUBLIC_FORM);
    const block = registrant(form);
    const email = block.fields.find((f) => f.key === 'contact_email');
    const name = block.fields.find((f) => f.key === 'contact_name');
    if (!email || !name) throw new Error('bad fixture');
    email.type = 'text';
    name.required = false;

    const message = refuse(form);
    expect(message).toContain('blocks.0.fields.0.required');
    expect(message).toContain('blocks.0.fields.1.type');
    expect(message.split('\n').length).toBeGreaterThan(1);
  });

  it('refuses something that is not a form at all', () => {
    expect(refuse(null)).toBeTruthy();
    expect(refuse('a form')).toBeTruthy();
    expect(refuse({})).toBeTruthy();
    expect(refuse({ kind: 'PLAYER', blocks: [] })).toBeTruthy();
    expect(refuse({ kind: 'SOMETHING_ELSE', blocks: [] })).toBeTruthy();
  });

  it('throws an InvalidFormSchemaError carrying the issues', () => {
    const form = clone(PUBLIC_FORM);
    registrant(form).creates_seat = false;
    try {
      assertFormSchema(form);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidFormSchemaError);
      expect((error as InvalidFormSchemaError).issues.length).toBeGreaterThan(0);
    }
  });
});
