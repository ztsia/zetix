import { describe, expect, it } from 'vitest';
import { COPY_TOKENS, interpolateCopy, tokensUsed, UNSET_PLACEHOLDER } from '@/lib/forms/copy';
import { blankFormSchema } from '@/lib/forms/templates';
import { blockFields, parseFormSchema, type FormKind } from '@/lib/forms/schema';
import { FEEDBACK_FORM, PLAYER_FORM, PUBLIC_FORM } from './fixtures';

describe('the blank templates', () => {
  const kinds: FormKind[] = ['PLAYER', 'PUBLIC', 'FEEDBACK'];

  it.each(kinds)('a blank %s form parses', (kind) => {
    const result = parseFormSchema(blankFormSchema(kind));
    expect(result.ok ? '' : result.message).toBe('');
  });

  it('carries every non-removable system field, so the builder never has to add one', () => {
    const player = blankFormSchema('PLAYER');
    const registrant = player.blocks.find((b) => b.type === 'REGISTRANT');
    expect(registrant && blockFields(registrant).map((f) => f.key)).toEqual([
      'contact_name',
      'contact_email',
      'contact_phone',
    ]);

    const base = player.blocks.find((b) => b.type === 'GUESTS_BASE');
    expect(base && blockFields(base).map((f) => f.key)).toEqual(['full_name', 'email']);
  });

  it('a blank feedback form asks nothing and creates nothing', () => {
    const feedback = blankFormSchema('FEEDBACK');
    expect(feedback.blocks.every((b) => b.type === 'CUSTOM')).toBe(true);
    expect(feedback.blocks.flatMap(blockFields)).toEqual([]);
  });

  it('hardcodes no number in its copy — every figure is a token', () => {
    for (const kind of kinds) {
      for (const block of blankFormSchema(kind).blocks) {
        const copy = `${block.title} ${block.description_md ?? ''} ${'add_label' in block ? (block.add_label ?? '') : ''}`;
        // Any digit outside a `{{token}}` would be an operational value living
        // in code, which is the bug `CLAUDE.md`'s first rule exists to prevent.
        expect(copy.replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/\d/);
      }
    }
  });
});

describe('interpolation', () => {
  const values = { base_quota: '2', max_additional_guests: '3', base_claim_deadline: 'Sat 19 Sep 2026' };

  it('substitutes a known token', () => {
    expect(interpolateCopy('You have **{{base_quota}}** seats.', values).text).toBe(
      'You have **2** seats.',
    );
  });

  it('accepts any spacing inside the braces', () => {
    expect(interpolateCopy('{{base_quota}} {{ base_quota }} {{  base_quota  }}', values).text).toBe(
      '2 2 2',
    );
  });

  it('renders a known but unresolved token as a placeholder, never as a number', () => {
    const { text, unknown } = interpolateCopy('Up to {{extra_rows_max}} seats.', values);
    expect(text).toBe(`Up to ${UNSET_PLACEHOLDER} seats.`);
    expect(unknown).toEqual([]);
  });

  it('reports an unknown token instead of silently blanking it', () => {
    const { text, unknown } = interpolateCopy('You have {{base_quotta}} seats.', values);
    expect(text).toBe('You have  seats.');
    expect(unknown).toEqual(['base_quotta']);
  });

  it('lists an unknown token once however often it appears', () => {
    expect(interpolateCopy('{{nope}} and {{nope}}', values).unknown).toEqual(['nope']);
  });

  it('leaves copy with no tokens exactly as written', () => {
    const copy = 'Doors open half an hour before the concert. Unreserved seating.';
    expect(interpolateCopy(copy, values).text).toBe(copy);
  });

  it('tokensUsed reports first appearance order, deduplicated', () => {
    expect(tokensUsed('{{base_quota}}, {{extra_rows_max}}, {{base_quota}}')).toEqual([
      'base_quota',
      'extra_rows_max',
    ]);
  });
});

describe('the fixtures only use tokens that exist', () => {
  const known = new Set(COPY_TOKENS.map((t) => t.token));

  it.each([
    ['player', PLAYER_FORM],
    ['public', PUBLIC_FORM],
    ['feedback', FEEDBACK_FORM],
  ] as const)('%s', (_name, form) => {
    for (const block of form.blocks) {
      for (const token of tokensUsed(block.description_md ?? '')) {
        expect(known, `unknown token {{${token}}}`).toContain(token);
      }
    }
  });
});
