import { describe, expect, it } from 'vitest';
import {
  TOKENS,
  escapeMergeValues,
  markdownToHtml,
  markdownToPlainText,
  renderTemplate,
} from '@/lib/email/render';

const context = {
  'concert.name': 'Autumn Concert',
  'registration.contact_name': 'Wellington Mainwaring',
  attendee_count: '4',
};

describe('merge fields', () => {
  it('resolves a token whatever the spacing inside the braces', () => {
    const { text } = renderTemplate('{{concert.name}} / {{ concert.name }} / {{  concert.name  }}', context);
    expect(text).toBe('Autumn Concert / Autumn Concert / Autumn Concert');
  });

  /**
   * A typo renders as an empty string — an empty string mid-sentence is exactly
   * what reaches four hundred inboxes unnoticed — so it is reported instead of
   * swallowed. §11.5's preview against a real recipient exists for this.
   */
  it('reports an unknown token rather than leaving it in the message', () => {
    const { text, unknown } = renderTemplate('Dear {{ registrant.name }},', context);
    expect(text).toBe('Dear ,');
    expect(unknown).toEqual(['registrant.name']);
  });

  it('leaves nothing unresolved when every token is known', () => {
    const { text, unknown } = renderTemplate(
      'Your {{ attendee_count }} tickets for {{ concert.name }}',
      context,
    );
    expect(text).toBe('Your 4 tickets for Autumn Concert');
    expect(unknown).toEqual([]);
  });

  it('documents every token it can resolve', () => {
    // The editor's help text reads from this list, so an undocumented token is
    // one an admin cannot discover.
    for (const { token } of TOKENS) {
      const { unknown } = renderTemplate(`{{ ${token} }}`, {});
      expect(unknown, `${token} is in TOKENS but does not resolve`).toEqual([]);
    }
  });
});

describe('merge values are not markup', () => {
  /**
   * The template is admin-authored; the values are registrant and attendee
   * names, which arrive from a spreadsheet import. A name is a name, not
   * formatting.
   */
  it('escapes a name that looks like HTML', () => {
    const escaped = escapeMergeValues({ 'registration.contact_name': '<b>Bobby</b> & Co' });
    expect(escaped['registration.contact_name']).toBe('&lt;b&gt;Bobby&lt;/b&gt; &amp; Co');
  });
});

describe('the two halves of the body', () => {
  it('renders Markdown to HTML', () => {
    const html = markdownToHtml('# Tickets\n\nYour **four** tickets are attached.');
    expect(html).toContain('<h1>Tickets</h1>');
    expect(html).toContain('<strong>four</strong>');
  });

  /** §11.3: the plain-text alternative is generated, so it cannot drift. */
  it('generates a readable plain-text alternative', () => {
    const text = markdownToPlainText(
      '# Tickets\n\nYour **four** tickets are attached.\n\n- [Ticket page](https://zetix.vercel.app/t/abc)',
    );
    expect(text).toContain('Tickets');
    expect(text).not.toContain('#');
    expect(text).not.toContain('**');
    expect(text).toContain('Ticket page (https://zetix.vercel.app/t/abc)');
  });
});
