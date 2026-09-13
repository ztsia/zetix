import { describe, expect, it } from 'vitest';
import { isSafeHref, parseRichText, richTextToPlain } from '@/lib/forms/rich-text';

/**
 * The markdown subset a form's copy may use.
 *
 * This is a security boundary, not a formatting convenience: the copy is
 * admin-authored and the registration surface is public, so the parser exists so
 * that no HTML string is ever produced and no sanitiser is ever relied on.
 */

describe('inline marks', () => {
  it('parses strong, emphasis and a link', () => {
    expect(parseRichText('You have **2** seats.')).toEqual([
      {
        kind: 'paragraph',
        children: [
          { kind: 'text', text: 'You have ' },
          { kind: 'strong', children: [{ kind: 'text', text: '2' }] },
          { kind: 'text', text: ' seats.' },
        ],
      },
    ]);
  });

  it('nests a link inside strong rather than letting one eat the other', () => {
    const [block] = parseRichText('**see [the map](https://example.com/map)**');
    expect(block).toEqual({
      kind: 'paragraph',
      children: [
        {
          kind: 'strong',
          children: [
            { kind: 'text', text: 'see ' },
            {
              kind: 'link',
              href: 'https://example.com/map',
              children: [{ kind: 'text', text: 'the map' }],
            },
          ],
        },
      ],
    });
  });

  it('does not read a bold run as two emphases', () => {
    const [block] = parseRichText('**bold**');
    expect(block?.kind === 'paragraph' && block.children[0]?.kind).toBe('strong');
  });

  it('leaves an unmatched asterisk as text', () => {
    expect(richTextToPlain('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});

describe('blocks', () => {
  it('splits paragraphs on a blank line and joins wrapped lines', () => {
    const blocks = parseRichText('One line\nwrapped.\n\nA second paragraph.');
    expect(blocks).toHaveLength(2);
    expect(richTextToPlain('One line\nwrapped.\n\nA second paragraph.')).toBe(
      'One line wrapped.\n\nA second paragraph.',
    );
  });

  it('parses a bullet list', () => {
    const blocks = parseRichText('Bring:\n\n- your ticket\n- a coat');
    expect(blocks[1]).toEqual({
      kind: 'list',
      items: [[{ kind: 'text', text: 'your ticket' }], [{ kind: 'text', text: 'a coat' }]],
    });
  });

  it('yields nothing for empty or whitespace-only copy', () => {
    expect(parseRichText('')).toEqual([]);
    expect(parseRichText('   \n\n  ')).toEqual([]);
  });

  it('accepts Windows line endings', () => {
    expect(parseRichText('One.\r\n\r\nTwo.')).toHaveLength(2);
  });
});

describe('link safety', () => {
  it('accepts the three schemes a form needs, and a same-origin path', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('mailto:tickets@example.com')).toBe(true);
    expect(isSafeHref('/t/abc123')).toBe(true);
  });

  it('refuses everything else', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false);
    expect(isSafeHref('  javascript:alert(1)  ')).toBe(false);
    expect(isSafeHref('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('not a url at all')).toBe(false);
  });

  it('refuses a protocol-relative URL, which is another origin wearing a path', () => {
    expect(isSafeHref('//evil.example.com/steal')).toBe(false);
  });

  it('renders an unsafe link as its text, with no anchor', () => {
    const [block] = parseRichText('[click me](javascript:alert(1))');
    expect(block).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'click me' }],
    });
  });

  it('keeps a link whose URL contains balanced parentheses', () => {
    const [block] = parseRichText('[the piece](https://example.com/Concerto_(music))');
    expect(block).toEqual({
      kind: 'paragraph',
      children: [
        {
          kind: 'link',
          href: 'https://example.com/Concerto_(music)',
          children: [{ kind: 'text', text: 'the piece' }],
        },
      ],
    });
  });
});
