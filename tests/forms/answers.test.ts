import { describe, expect, it } from 'vitest';
import { emptyAnswers, validateAnswers, type FormAnswers } from '@/lib/forms/answers';
import type { FormSchema } from '@/lib/forms/schema';
import { clone, FEEDBACK_FORM, PLAYER_FORM, PUBLIC_FORM } from './fixtures';

/**
 * Submit validation against a pinned schema (spec/v2.md §8.2.3, §8.2.4, §8.3).
 *
 * The same contract the builder wrote and the renderer drew, used a third time.
 */

const PUBLIC_LIMITS = { party: 3 };
const PLAYER_LIMITS = { base: 2, extras: 4 };
const NO_LIMITS = {};

function ok(schema: FormSchema, payload: unknown, limits: Record<string, number>) {
  const result = validateAnswers(schema, payload, { limits });
  expect(result.ok ? '' : JSON.stringify(result.errors)).toBe('');
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function bad(schema: FormSchema, payload: unknown, limits: Record<string, number>) {
  const result = validateAnswers(schema, payload, { limits });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.errors;
}

/** A minimal valid public submission: one registrant, one guest, consent ticked. */
function publicPayload(): Record<string, unknown> {
  return {
    registrant: { contact_name: 'Alice Tan', contact_email: 'alice@example.com' },
    party: [{ full_name: 'Ben Tan' }],
    extras: { newsletter_consent: true },
  };
}

describe('a valid submission', () => {
  it('accepts the public form and keeps only what was asked', () => {
    const { answers, dropped } = ok(PUBLIC_FORM, publicPayload(), PUBLIC_LIMITS);

    expect(answers.registrant).toEqual({
      kind: 'flat',
      values: { contact_name: 'Alice Tan', contact_email: 'alice@example.com' },
    });
    expect(answers.party).toEqual({ kind: 'repeater', rows: [{ full_name: 'Ben Tan' }] });
    expect(answers.extras).toEqual({ kind: 'flat', values: { newsletter_consent: true } });
    expect(dropped).toEqual([]);
  });

  it('accepts the renderer’s own state shape unchanged, so nothing translates it', () => {
    const state: FormAnswers = {
      registrant: { kind: 'flat', values: { contact_name: 'Alice Tan', contact_email: 'a@b.com', heard_from: '' } },
      party: { kind: 'repeater', rows: [{ full_name: 'Ben Tan' }] },
      extras: { kind: 'flat', values: { newsletter_consent: true, interests: [] } },
    };
    ok(PUBLIC_FORM, state, PUBLIC_LIMITS);
  });

  it('accepts the player form with base and extra seats', () => {
    const { answers } = ok(
      PLAYER_FORM,
      {
        registrant: { contact_name: 'Cara Lim', contact_email: 'cara@example.com', contact_phone: '+65 9123 4567' },
        base: [{ full_name: 'Dan Lim', email: 'dan@example.com' }, { full_name: 'Eve Lim' }],
        extras: [{ full_name: 'Fay Lim' }],
        logistics: { transport: 'public' },
      },
      PLAYER_LIMITS,
    );

    expect(answers.base).toEqual({
      kind: 'repeater',
      rows: [{ full_name: 'Dan Lim', email: 'dan@example.com' }, { full_name: 'Eve Lim' }],
    });
  });

  it('accepts a feedback form, which has no seats and no identity', () => {
    ok(FEEDBACK_FORM, { evening: { overall: '5', highlight: 'The encore.' } }, NO_LIMITS);
  });

  it('accepts an empty repeater — nobody has to bring a guest', () => {
    const { answers } = ok(PUBLIC_FORM, { ...publicPayload(), party: [] }, PUBLIC_LIMITS);
    expect(answers.party).toEqual({ kind: 'repeater', rows: [] });
  });
});

describe('required answers', () => {
  it('refuses a response with no email (§8.1.3)', () => {
    const payload = publicPayload();
    payload.registrant = { contact_name: 'Alice Tan' };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['registrant.contact_email']).toBe('This is required.');
  });

  it('refuses a seat with no name (§8.1.3)', () => {
    const payload = publicPayload();
    payload.party = [{ full_name: '' }];
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['party.0.full_name']).toBe('This is required.');
  });

  it('names the row a bad seat is in', () => {
    const payload = publicPayload();
    payload.party = [{ full_name: 'Ben Tan' }, { full_name: '' }, { full_name: 'Gus Tan' }];
    const errors = bad(PUBLIC_FORM, payload, PUBLIC_LIMITS);
    expect(Object.keys(errors)).toEqual(['party.1.full_name']);
  });

  it('accepts a blank optional system field', () => {
    ok(PLAYER_FORM, {
      registrant: { contact_name: 'Cara Lim', contact_email: 'cara@example.com', contact_phone: '' },
      base: [{ full_name: 'Dan Lim', email: '' }],
      extras: [],
      logistics: { transport: 'car', parking_plate: 'SGX1234A' },
    }, PLAYER_LIMITS);
  });

  it('treats a required checkbox as "must be ticked", not "must be answered"', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: false };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['extras.newsletter_consent']).toBe(
      'Please tick this to continue.',
    );
  });
});

describe('value types', () => {
  it('rejects a malformed email rather than storing it', () => {
    const payload = publicPayload();
    payload.registrant = { contact_name: 'Alice Tan', contact_email: 'alice at example dot com' };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['registrant.contact_email']).toBe(
      'Enter a valid email address.',
    );
  });

  it('coerces a numeric string, because that is what a browser posts', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: 'on', party_size_note: '2' };
    const { answers } = ok(PUBLIC_FORM, payload, PUBLIC_LIMITS);
    expect(answers.extras).toEqual({
      kind: 'flat',
      values: { party_size_note: 2, newsletter_consent: true },
    });
  });

  it('rejects a number field that is not a number', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, party_size_note: 'two' };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['extras.party_size_note']).toBe(
      'Enter a valid number.',
    );
  });

  it('accepts zero as an answer to a number field', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, party_size_note: '0' };
    const { answers } = ok(PUBLIC_FORM, payload, PUBLIC_LIMITS);
    expect(answers.extras).toEqual({ kind: 'flat', values: { party_size_note: 0, newsletter_consent: true } });
  });

  it('wraps a single-valued multiselect, which posts one string not a list', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, interests: 'concerts' };
    const { answers } = ok(PUBLIC_FORM, payload, PUBLIC_LIMITS);
    expect(answers.extras).toEqual({
      kind: 'flat',
      values: { interests: ['concerts'], newsletter_consent: true },
    });
  });

  it('refuses a choice the field does not offer', () => {
    const payload = publicPayload();
    payload.registrant = {
      contact_name: 'Alice Tan',
      contact_email: 'alice@example.com',
      heard_from: 'a dream',
    };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['registrant.heard_from']).toBe(
      'Choose one of the options listed.',
    );
  });

  it('refuses a multiselect entry the field does not offer', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, interests: ['concerts', 'free_beer'] };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['extras.interests']).toBe(
      'Choose from the options listed.',
    );
  });

  it('refuses a date that is not a date', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, preferred_date: '19/09/2026' };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['extras.preferred_date']).toBe('Enter a valid date.');
  });

  it('accepts an ISO date', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, preferred_date: '2026-09-19' };
    ok(PUBLIC_FORM, payload, PUBLIC_LIMITS);
  });
});

describe('conditional fields (§8.2.2)', () => {
  it('does not require a hidden field, however required it is', () => {
    // `instrument` is required, and conditional on "joining" being among the
    // interests. Nobody picked it, so the question was never asked.
    ok(PUBLIC_FORM, publicPayload(), PUBLIC_LIMITS);
  });

  it('requires it once its condition holds', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, interests: ['joining'] };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['extras.instrument']).toBe('This is required.');
  });

  it('drops an answer to a question that is not showing', () => {
    // Answered "by car", filled the plate, then changed to public transport.
    const { answers } = ok(
      PLAYER_FORM,
      {
        registrant: { contact_name: 'Cara Lim', contact_email: 'cara@example.com' },
        base: [{ full_name: 'Dan Lim' }],
        extras: [],
        logistics: { transport: 'public', parking_plate: 'SGX1234A' },
      },
      PLAYER_LIMITS,
    );

    expect(answers.logistics).toEqual({ kind: 'flat', values: { transport: 'public' } });
  });

  it('keeps it when the condition holds', () => {
    const { answers } = ok(
      PLAYER_FORM,
      {
        registrant: { contact_name: 'Cara Lim', contact_email: 'cara@example.com' },
        base: [{ full_name: 'Dan Lim' }],
        extras: [],
        logistics: { transport: 'car', parking_plate: 'SGX1234A' },
      },
      PLAYER_LIMITS,
    );

    expect(answers.logistics).toEqual({
      kind: 'flat',
      values: { transport: 'car', parking_plate: 'SGX1234A' },
    });
  });

  it('evaluates a condition per row, not per form', () => {
    const form = clone(FEEDBACK_FORM);
    const result = validateAnswers(
      form,
      { evening: { overall: '1' } },
      { limits: NO_LIMITS },
    );
    // `what_went_wrong` shows for a 1 but is optional, so a low score with no
    // explanation is still a valid response.
    expect(result.ok).toBe(true);
  });

  it('evaluates a condition whose source is in an earlier block', () => {
    // The flat scope spans every REGISTRANT and CUSTOM block in document order,
    // and `schema.ts` accepts a condition across it — so the renderer and this
    // must both resolve it that way, or the contract accepts a question nothing
    // ever asks. Found by the module's QA pass.
    const form = clone(PUBLIC_FORM);
    const extras = form.blocks.find((b) => b.id === 'extras');
    if (!extras || extras.type !== 'CUSTOM') throw new Error('bad fixture');
    extras.fields.push({
      key: 'poster_where',
      label: 'Where did you see it?',
      type: 'text',
      system: false,
      required: true,
      // `heard_from` lives in the REGISTRANT block, two blocks earlier.
      condition: { field: 'heard_from', op: 'eq', value: 'poster' },
    });

    // Source not matched: the question is not asked, so its absence is fine…
    const away = publicPayload();
    away.registrant = { contact_name: 'A', contact_email: 'a@b.com', heard_from: 'friend' };
    ok(form, away, PUBLIC_LIMITS);

    // …and matched, a required cross-block question is required.
    const shown = publicPayload();
    shown.registrant = { contact_name: 'A', contact_email: 'a@b.com', heard_from: 'poster' };
    expect(bad(form, shown, PUBLIC_LIMITS)['extras.poster_where']).toBe('This is required.');

    // …and its answer is kept, not dropped as though it were hidden.
    const answered = publicPayload();
    answered.registrant = { contact_name: 'A', contact_email: 'a@b.com', heard_from: 'poster' };
    answered.extras = { newsletter_consent: true, poster_where: 'Outside the library' };
    const { answers } = ok(form, answered, PUBLIC_LIMITS);
    expect(answers.extras).toEqual({
      kind: 'flat',
      values: { newsletter_consent: true, poster_where: 'Outside the library' },
    });
  });

  it('a cross-block "ne" hides rather than staying permanently visible', () => {
    const form = clone(PUBLIC_FORM);
    const extras = form.blocks.find((b) => b.id === 'extras');
    if (!extras || extras.type !== 'CUSTOM') throw new Error('bad fixture');
    extras.fields.push({
      key: 'why_not_social',
      label: 'Anything else?',
      type: 'text',
      system: false,
      required: false,
      condition: { field: 'heard_from', op: 'ne', value: 'social' },
    });

    const payload = publicPayload();
    payload.registrant = { contact_name: 'A', contact_email: 'a@b.com', heard_from: 'social' };
    payload.extras = { newsletter_consent: true, why_not_social: 'leaked through' };
    const { answers } = ok(form, payload, PUBLIC_LIMITS);
    expect(answers.extras).toEqual({ kind: 'flat', values: { newsletter_consent: true } });
  });

  it('a hidden source hides everything downstream of it', () => {
    const form: FormSchema = {
      kind: 'FEEDBACK',
      blocks: [
        {
          id: 'chain',
          type: 'CUSTOM',
          title: 'Chain',
          fields: [
            {
              key: 'a',
              label: 'A',
              type: 'select',
              system: false,
              required: false,
              options: [{ value: 'yes', label: 'Yes' }],
            },
            {
              key: 'b',
              label: 'B',
              type: 'select',
              system: false,
              required: false,
              options: [{ value: 'yes', label: 'Yes' }],
              condition: { field: 'a', op: 'eq', value: 'yes' },
            },
            {
              key: 'c',
              label: 'C',
              type: 'text',
              system: false,
              required: true,
              condition: { field: 'b', op: 'eq', value: 'yes' },
            },
          ],
        },
      ],
    };

    // `b` is answered but hidden, because `a` is not. `c` must therefore be
    // hidden too, rather than reading `b`'s stale answer and demanding a value
    // for a question nobody can see.
    const { answers } = ok(form, { chain: { b: 'yes' } }, NO_LIMITS);
    expect(answers.chain).toEqual({ kind: 'flat', values: {} });
  });
});

describe('repeater caps', () => {
  it('refuses more rows than the cap allows, rather than truncating', () => {
    const payload = publicPayload();
    payload.party = [{ full_name: 'A' }, { full_name: 'B' }, { full_name: 'C' }, { full_name: 'D' }];
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS).party).toBe('At most 3 seats may be added here.');
  });

  it('accepts exactly the cap', () => {
    const payload = publicPayload();
    payload.party = [{ full_name: 'A' }, { full_name: 'B' }, { full_name: 'C' }];
    ok(PUBLIC_FORM, payload, PUBLIC_LIMITS);
  });

  it('says so plainly when a section has no seats left', () => {
    const payload = publicPayload();
    payload.party = [{ full_name: 'A' }];
    expect(bad(PUBLIC_FORM, payload, { party: 0 }).party).toBe(
      'No seats are available in this section.',
    );
  });

  it('refuses rather than guessing when no cap resolved', () => {
    // `limits.ts` stops the surface before this, but a caller that skipped it
    // must not fall through to an invented number.
    expect(bad(PUBLIC_FORM, publicPayload(), {}).party).toBe('This form is not configured yet.');
  });

  it('refuses a repeater that is not a list', () => {
    const payload = publicPayload();
    payload.party = { full_name: 'Ben Tan' };
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS).party).toBe('Expected a list of seats.');
  });
});

describe('answer length', () => {
  it('refuses an answer far longer than any real one', () => {
    const payload = publicPayload();
    payload.registrant = {
      contact_name: 'A'.repeat(100_000),
      contact_email: 'alice@example.com',
    };
    // The authoring side of the contract caps every string it accepts; without
    // a matching ceiling here the answers are unbounded, and this name would be
    // stored, exported and rendered onto a ticket.
    expect(bad(PUBLIC_FORM, payload, PUBLIC_LIMITS)['registrant.contact_name']).toMatch(
      /keep this under/,
    );
  });

  it('accepts a long but plausible answer', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, interests: [] };
    payload.registrant = {
      contact_name: 'Alice Tan',
      contact_email: 'alice@example.com',
    };
    payload.party = [{ full_name: 'B'.repeat(200) }];
    ok(PUBLIC_FORM, payload, PUBLIC_LIMITS);
  });
});

describe('answers the schema does not have', () => {
  it('drops and reports an unknown field, rather than failing the submission', () => {
    const payload = publicPayload();
    payload.extras = { newsletter_consent: true, favourite_composer: 'Sibelius' };
    const { answers, dropped } = ok(PUBLIC_FORM, payload, PUBLIC_LIMITS);
    expect(answers.extras).toEqual({ kind: 'flat', values: { newsletter_consent: true } });
    expect(dropped).toContain('extras.favourite_composer');
  });

  it('drops and reports an unknown block', () => {
    const payload = publicPayload();
    payload.a_block_that_was_deleted = { anything: 1 };
    expect(ok(PUBLIC_FORM, payload, PUBLIC_LIMITS).dropped).toContain('a_block_that_was_deleted');
  });

  it('refuses a payload that is not an object at all', () => {
    expect(bad(PUBLIC_FORM, 'nope', PUBLIC_LIMITS)._form).toBeTruthy();
  });
});

describe('emptyAnswers', () => {
  it('starts a repeater with one row when there is room for one', () => {
    const answers = emptyAnswers(PUBLIC_FORM, PUBLIC_LIMITS);
    expect(answers.party).toEqual({ kind: 'repeater', rows: [{ full_name: '' }] });
  });

  it('starts it empty when there is no room', () => {
    expect(emptyAnswers(PUBLIC_FORM, { party: 0 }).party).toEqual({ kind: 'repeater', rows: [] });
  });

  it('gives every field a value of its own type, so no control starts uncontrolled', () => {
    const answers = emptyAnswers(PUBLIC_FORM, PUBLIC_LIMITS);
    expect(answers.extras).toEqual({
      kind: 'flat',
      values: {
        interests: [],
        instrument: '',
        party_size_note: '',
        first_visit: false,
        preferred_date: '',
        newsletter_consent: false,
      },
    });
  });
});
