import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormRenderer } from '@/components/forms/form-renderer';
import { emptyAnswers, type AnswerErrors, type FormAnswers } from '@/lib/forms/answers';
import type { CopyValues } from '@/lib/forms/copy';
import { UNSET_PLACEHOLDER } from '@/lib/forms/copy';
import { blockFields, type FormSchema } from '@/lib/forms/schema';
import { clone, FEEDBACK_FORM, PLAYER_FORM, PUBLIC_FORM } from './fixtures';

/**
 * **One component, three form kinds** (spec/surfaces.md §15.2, `modules-v2.md`
 * §3 `K`: *"one component renders a player form, a public form and a feedback
 * form from three fixtures"*).
 *
 * Rendered with `renderToStaticMarkup` rather than in jsdom, deliberately. The
 * renderer is controlled — the caller holds the answers — so every state worth
 * asserting is reachable by passing that state in, and none of the assertions
 * below needs a click. That keeps the suite free of a DOM implementation and its
 * dependency, and the interaction path is covered where interaction actually
 * happens, in the Playwright pass.
 */

const PLAYER_LIMITS = { base: 2, extras: 4 };
const PUBLIC_LIMITS = { party: 3 };
const NO_LIMITS = {};

type RenderOptions = {
  value?: FormAnswers;
  errors?: AnswerErrors;
  copy?: CopyValues;
  disabled?: boolean;
  showCopyWarnings?: boolean;
};

function render(
  schema: FormSchema,
  limits: Record<string, number>,
  options: RenderOptions = {},
): string {
  return renderToStaticMarkup(
    <FormRenderer
      schema={schema}
      limits={limits}
      copy={options.copy ?? {}}
      value={options.value ?? emptyAnswers(schema, limits)}
      onValueChange={() => {}}
      errors={options.errors}
      disabled={options.disabled}
      showCopyWarnings={options.showCopyWarnings}
    />,
  );
}

/** Every `id` the markup carries — the field paths that actually rendered. */
function controlIds(html: string): string[] {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? '');
}

/**
 * Every visible label, with markup stripped — the controls' labels and legends,
 * and the section headings that name a block.
 */
function labels(html: string): string[] {
  return [...html.matchAll(/<(label|legend|h2)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) =>
    (m[2] ?? '').replace(/<[^>]+>/g, '').replace(/\*$/, '').trim(),
  );
}

describe('all three kinds, one renderer', () => {
  it('renders a player form: details, base seats, extra seats', () => {
    const html = render(PLAYER_FORM, PLAYER_LIMITS);
    const seen = labels(html);

    expect(seen).toContain('Your details');
    expect(seen).toContain('Your seats');
    expect(seen).toContain('Extra seats');
    expect(controlIds(html)).toContain('registrant.contact_email');
    expect(controlIds(html)).toContain('base.0.full_name');
    expect(controlIds(html)).toContain('extras.0.full_name');
  });

  it('renders a public form: details and a party repeater', () => {
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, { copy: { max_additional_guests: '3' } });

    expect(labels(html)).toContain('Who else is coming?');
    expect(controlIds(html)).toContain('registrant.contact_email');
    expect(controlIds(html)).toContain('party.0.full_name');
    // The public registrant is seat #1, so the repeater is for the others only.
    expect(html).toContain('You may bring up to <strong class="font-semibold">3</strong> guests');
  });

  it('renders a feedback form: no seats, no identity, just the questions', () => {
    const html = render(FEEDBACK_FORM, NO_LIMITS);

    expect(labels(html)).toContain('How was your evening?');
    expect(html).not.toContain('contact_email');
    expect(html).not.toContain('full_name');
    expect(html).not.toContain('added');
  });

  it('renders every one of the ten field types as a control', () => {
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS) + render(PLAYER_FORM, PLAYER_LIMITS) + render(FEEDBACK_FORM, NO_LIMITS);

    expect(html).toContain('type="email"');
    expect(html).toContain('type="tel"');
    expect(html).toContain('type="number"');
    expect(html).toContain('type="date"');
    expect(html).toContain('<textarea');
    expect(html).toContain('<select');
    expect(html).toContain('data-slot="checkbox"');
    expect(html).toContain('data-slot="radio-group"');
    // A multiselect is a checkbox per option, so it shares the checkbox slot;
    // its options are what distinguish it.
    expect(controlIds(html)).toContain('extras.interests.joining');
  });

  it('renders a system field on every surface that has one', () => {
    // Nothing in the renderer can hide one — the contract refuses a condition
    // on a system field — but an assertion here is what would catch a renderer
    // that started filtering for its own reasons.
    for (const [schema, limits] of [
      [PLAYER_FORM, PLAYER_LIMITS],
      [PUBLIC_FORM, PUBLIC_LIMITS],
    ] as const) {
      const ids = controlIds(render(schema, limits));
      expect(ids).toContain('registrant.contact_name');
      expect(ids).toContain('registrant.contact_email');
    }
  });
});

describe('conditional fields', () => {
  it('hides a field whose condition does not hold', () => {
    const html = render(PLAYER_FORM, PLAYER_LIMITS);
    // A radio group has one id per option rather than one for the question.
    expect(controlIds(html)).toContain('logistics.transport.car');
    expect(controlIds(html)).not.toContain('logistics.parking_plate');
  });

  it('shows it once the condition holds', () => {
    const value = emptyAnswers(PLAYER_FORM, PLAYER_LIMITS);
    value.logistics = { kind: 'flat', values: { transport: 'car' } };
    expect(controlIds(render(PLAYER_FORM, PLAYER_LIMITS, { value }))).toContain(
      'logistics.parking_plate',
    );
  });

  it('evaluates a repeater condition per row', () => {
    const form = clone(PLAYER_FORM);
    const base = form.blocks.find((b) => b.id === 'base');
    if (!base || !('guest_fields' in base)) throw new Error('bad fixture');
    base.guest_fields.push({
      key: 'note_detail',
      label: 'Tell us more',
      type: 'text',
      system: false,
      required: false,
      condition: { field: 'seat_note', op: 'answered' },
    });

    const value = emptyAnswers(form, PLAYER_LIMITS);
    value.base = {
      kind: 'repeater',
      rows: [
        { full_name: 'Dan', email: '', seat_note: 'wheelchair', note_detail: '' },
        { full_name: 'Eve', email: '', seat_note: '', note_detail: '' },
      ],
    };

    const ids = controlIds(render(form, PLAYER_LIMITS, { value }));
    // Row 0 answered the source, row 1 did not.
    expect(ids).toContain('base.0.note_detail');
    expect(ids).not.toContain('base.1.note_detail');
  });

  it('draws a field whose source is in an earlier block', () => {
    // The contract accepts a condition across the flat scope, so the renderer
    // has to resolve it across the flat scope too — resolving per block would
    // evaluate it against an empty source and never draw the question. Found by
    // the module's QA pass.
    const form = clone(PUBLIC_FORM);
    const extras = form.blocks.find((b) => b.id === 'extras');
    if (!extras || extras.type !== 'CUSTOM') throw new Error('bad fixture');
    extras.fields.push({
      key: 'poster_where',
      label: 'Where did you see it?',
      type: 'text',
      system: false,
      required: false,
      condition: { field: 'heard_from', op: 'eq', value: 'poster' },
    });

    const hidden = emptyAnswers(form, PUBLIC_LIMITS);
    expect(controlIds(render(form, PUBLIC_LIMITS, { value: hidden }))).not.toContain(
      'extras.poster_where',
    );

    const shown = emptyAnswers(form, PUBLIC_LIMITS);
    shown.registrant = { kind: 'flat', values: { heard_from: 'poster' } };
    expect(controlIds(render(form, PUBLIC_LIMITS, { value: shown }))).toContain(
      'extras.poster_where',
    );
  });

  it('hides a field whose source is itself hidden', () => {
    const value = emptyAnswers(PUBLIC_FORM, PUBLIC_LIMITS);
    // `social_handle` depends on `heard_from`, which nobody answered.
    expect(controlIds(render(PUBLIC_FORM, PUBLIC_LIMITS, { value }))).not.toContain(
      'registrant.social_handle',
    );
  });
});

describe('copy', () => {
  it('interpolates a resolved token', () => {
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, { copy: { max_additional_guests: '7' } });
    expect(html).toContain('>7</strong> guests');
  });

  it('renders a placeholder for an unresolved one, never a number', () => {
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, { copy: {} });
    expect(html).toContain(`>${UNSET_PLACEHOLDER}</strong> guests`);
  });

  it('warns the admin about an unknown token, and says nothing to the public', () => {
    const form = clone(PUBLIC_FORM);
    const party = form.blocks.find((b) => b.id === 'party');
    if (!party) throw new Error('bad fixture');
    party.description_md = 'Up to {{maximum_guests}} guests.';

    expect(render(form, PUBLIC_LIMITS, { showCopyWarnings: true })).toContain('{{maximum_guests}}');
    expect(render(form, PUBLIC_LIMITS)).not.toContain('maximum_guests');
  });

  it('renders markdown as elements, never as an HTML string', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block) throw new Error('bad fixture');
    block.description_md = 'Please **do** tell us. <script>alert(1)</script> [Contact us](https://example.com/help)';

    const html = render(form, NO_LIMITS);
    expect(html).toContain('<strong class="font-semibold">do</strong>');
    // The tag is escaped text in the output, not a tag in the document.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="https://example.com/help"');
  });

  it('drops a link whose scheme is not safe, keeping its words', () => {
    const form = clone(FEEDBACK_FORM);
    const block = form.blocks[0];
    if (!block) throw new Error('bad fixture');
    block.description_md = 'Read [the rules](javascript:alert(1)) first.';

    const html = render(form, NO_LIMITS);
    expect(html).toContain('the rules');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
  });
});

describe('repeaters', () => {
  it('states the count against the cap', () => {
    expect(render(PUBLIC_FORM, PUBLIC_LIMITS)).toContain('1 of 3 added');
  });

  it('disables the add control at the cap rather than letting it fail silently', () => {
    const value = emptyAnswers(PUBLIC_FORM, PUBLIC_LIMITS);
    value.party = { kind: 'repeater', rows: [{ full_name: 'A' }, { full_name: 'B' }, { full_name: 'C' }] };

    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, { value });
    expect(html).toContain('3 of 3 added');
    expect(html).toMatch(/Add a guest/);
    expect(html).toContain('disabled=""');
  });

  it('says plainly when a section has no seats — a player with none left', () => {
    const html = render(PLAYER_FORM, { base: 0, extras: 4 });
    expect(html).toContain('There are no seats to add in this section.');
    expect(html).not.toContain('0 of 0 added');
  });

  it('refuses to render a repeater whose cap nobody has configured', () => {
    const html = render(PUBLIC_FORM, {});
    expect(html).toContain('Not configured yet');
    // And it does not invent an unlimited repeater in the meantime.
    expect(controlIds(html)).not.toContain('party.0.full_name');
  });

  it('numbers the seats, so an error against row 2 can be found', () => {
    const value = emptyAnswers(PLAYER_FORM, PLAYER_LIMITS);
    value.base = { kind: 'repeater', rows: [{ full_name: 'A' }, { full_name: 'B' }] };
    const html = render(PLAYER_FORM, PLAYER_LIMITS, { value });
    expect(html).toContain('Seat 1');
    expect(html).toContain('Seat 2');
  });

  it('numbers a public party as guests, since the registrant is seat #1', () => {
    const value = emptyAnswers(PUBLIC_FORM, PUBLIC_LIMITS);
    value.party = { kind: 'repeater', rows: [{ full_name: 'A' }, { full_name: 'B' }] };
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, { value });
    expect(html).toContain('Guest 1');
    expect(html).toContain('Guest 2');
    expect(html).not.toContain('Seat 1');
  });

  it('labels the add control with the section’s own wording', () => {
    const schema = clone(PUBLIC_FORM);
    const party = schema.blocks.find((block) => block.type === 'GUESTS_PARTY');
    if (!party || !('guest_fields' in party)) throw new Error('fixture has no party block');
    party.add_label = 'Bring someone along';
    expect(render(schema, PUBLIC_LIMITS)).toContain('Bring someone along');
  });
});

describe('errors', () => {
  it('shows a field error against its own control', () => {
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, {
      errors: { 'registrant.contact_email': 'Enter a valid email address.' },
    });
    expect(html).toContain('Enter a valid email address.');
    expect(html).toContain('data-invalid="true"');
  });

  it('shows a row error against the right row', () => {
    const value = emptyAnswers(PUBLIC_FORM, PUBLIC_LIMITS);
    value.party = { kind: 'repeater', rows: [{ full_name: 'A' }, { full_name: '' }] };
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, {
      value,
      errors: { 'party.1.full_name': 'This is required.' },
    });
    // The message sits after Guest 2's heading, not Guest 1's.
    expect(html.indexOf('This is required.')).toBeGreaterThan(html.indexOf('Guest 2'));
  });

  it('shows a block error above the block', () => {
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, {
      errors: { party: 'At most 3 seats may be added here.' },
    });
    expect(html).toContain('At most 3 seats may be added here.');
  });
});

describe('disabled', () => {
  it('renders the whole form and accepts nothing — L’s preview', () => {
    const html = render(PUBLIC_FORM, PUBLIC_LIMITS, { disabled: true });

    // Everything is still visible: a preview that hid fields would not be one.
    expect(controlIds(html)).toContain('registrant.contact_email');
    expect(controlIds(html)).toContain('party.0.full_name');

    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input).toContain('disabled');
  });
});
