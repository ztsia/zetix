import { describe, expect, it } from 'vitest';
import { emailDocument, markdownToEmailHtml, markdownToPlainText } from '@/lib/email/render';

/**
 * The email skeleton (spec/email.md §11.3).
 *
 * The assertions that matter here are the client-compatibility ones. A styled
 * message that only holds together in the browser is not an improvement on an
 * unstyled one, so each rule below pins a property some real client depends
 * on rather than a detail of the markup.
 */
const BODY = markdownToPlainText('Dear Ada,\n\nYour tickets are attached.');

describe('the document a client receives', () => {
  it('is a complete document, not a fragment', () => {
    const html = markdownToEmailHtml('Hello.');

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('</html>');
  });

  it('keeps the rendered body inside it', () => {
    expect(markdownToEmailHtml('Your **four** tickets are attached.')).toContain(
      '<strong>four</strong>',
    );
  });

  /**
   * Outlook's Word engine supports neither, and a ticket email that collapses
   * is a guest who cannot find their link.
   */
  it('lays out with tables rather than flex or grid', () => {
    const html = markdownToEmailHtml(BODY);

    expect(html).toContain('role="presentation"');
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
  });

  /**
   * A client that strips the `<style>` block must still render a readable
   * message, so the same rules ride on the elements themselves.
   */
  it('inlines styles rather than relying only on the style block', () => {
    const html = markdownToEmailHtml('A paragraph.\n\n- one\n- two');

    expect(html).toMatch(/<p style="[^"]*font-size:16px/);
    expect(html).toMatch(/<li style="[^"]*font-size:16px/);
  });

  it('styles links inline without disturbing their href', () => {
    const html = markdownToEmailHtml('[View ticket](https://example.test/t/abc)');

    expect(html).toMatch(/<a style="[^"]*" href="https:\/\/example\.test\/t\/abc"/);
  });

  /** Left to guess, a client inverts the card and can leave dark on dark. */
  it('declares a light colour scheme and states its own colours', () => {
    const html = markdownToEmailHtml(BODY);

    expect(html).toContain('name="color-scheme"');
    expect(html).toContain('background:#f4f4f5');
  });
});

describe('preheader', () => {
  it('is hidden when present', () => {
    const html = emailDocument('<p>Body</p>', { preheader: 'Your tickets are attached' });

    expect(html).toContain('Your tickets are attached');
    expect(html).toMatch(/display:none[^"]*mso-hide:all/);
  });

  it('is left out entirely when not given', () => {
    expect(emailDocument('<p>Body</p>')).not.toContain('mso-hide:all');
  });
});

describe('footer', () => {
  /**
   * The footer is passed in rather than fixed in the skeleton: a cancellation
   * telling the reader to bring the attached ticket would be worse than no
   * footer at all, and `carriesTickets()` is what decides.
   */
  it('appears only when the caller supplies one', () => {
    expect(emailDocument('<p>Body</p>', { footer: 'Bring the attached PDF.' })).toContain(
      'Bring the attached PDF.',
    );
    expect(emailDocument('<p>Body</p>')).not.toContain('Bring the attached PDF.');
  });
});

describe('the ticket list inside the skeleton', () => {
  it('keeps one styled list item per link', () => {
    const html = markdownToEmailHtml(
      '- Ada Lim — [View ticket](https://x.test/t/a)\n- Bo Tan — [View ticket](https://x.test/t/b)',
    );

    expect(html.match(/<li style=/g)).toHaveLength(2);
    expect(html).toContain('Ada Lim');
    expect(html).toContain('Bo Tan');
  });
});
