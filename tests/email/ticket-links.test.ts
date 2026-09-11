import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ticketLinks } from '@/lib/email/queue';
import { markdownToHtml, markdownToPlainText, escapeMergeValues } from '@/lib/email/render';

/**
 * The `{{ ticket_links }}` token (spec/email.md §11.3).
 *
 * These exist because the token had no test at all, and shipped joining its
 * links with a single `\n` — which Markdown treats as a *soft* break, so a
 * party of four received four URLs run together on one line. Every assertion
 * below is about the rendered halves of the message rather than the raw
 * string: the bug was invisible at the string level and only appeared once
 * `markdownToHtml()` had run.
 */
const APP_URL = 'https://zetix.example';

beforeEach(() => {
  process.env.APP_URL = APP_URL;
});

afterEach(() => {
  delete process.env.APP_URL;
});

describe('one line per ticket', () => {
  it('renders each link as its own HTML list item, not one run-together line', () => {
    const md = ticketLinks(['Ada Lim', 'Bo Tan', 'Cheng Wei'], ['tok-a', 'tok-b', 'tok-c']);
    const html = markdownToHtml(md);

    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain(`${APP_URL}/t/tok-a`);
    expect(html).toContain(`${APP_URL}/t/tok-c`);
  });

  /**
   * The regression itself, pinned directly: two links must never end up in one
   * block-level element. Joining with `'\n'` again turns this red while the
   * `<li>` count above would still pass at three only by accident.
   */
  it('never puts two links inside the same block', () => {
    const html = markdownToHtml(ticketLinks(['Ada Lim', 'Bo Tan'], ['tok-a', 'tok-b']));
    const blocks = html.split(/<\/li>|<\/p>/).filter((b) => b.includes('/t/'));

    for (const block of blocks) {
      expect(block.match(/\/t\//g)).toHaveLength(1);
    }
    expect(blocks).toHaveLength(2);
  });

  it('keeps one link per line in the plain-text alternative too', () => {
    const text = markdownToPlainText(ticketLinks(['Ada Lim', 'Bo Tan'], ['tok-a', 'tok-b']));
    const lines = text.split('\n').filter((l) => l.includes('/t/'));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Ada Lim');
    expect(lines[0]).toContain(`${APP_URL}/t/tok-a`);
  });
});

describe('each link says whose ticket it is', () => {
  it('labels every link with its own seat', () => {
    const html = markdownToHtml(ticketLinks(['Ada Lim', 'Guest of Ada Lim'], ['tok-a', 'tok-b']));

    expect(html).toMatch(/Ada Lim[^<]*<a href="[^"]*tok-a"/);
    expect(html).toMatch(/Guest of Ada Lim[^<]*<a href="[^"]*tok-b"/);
  });

  /**
   * Both arrays are `array_agg(... order by a.id)`, so index `i` is the same
   * seat in both — and filtering one of them alone would slide every later
   * label onto the wrong person. A ticket labelled with someone else's name is
   * worse than an unlabelled one, so the pairing is asserted rather than
   * assumed.
   */
  it('keeps a name with its own token when an earlier name is blank', () => {
    const md = ticketLinks(['', 'Bo Tan'], ['tok-a', 'tok-b']);
    const lines = md.split('\n');

    expect(lines[1]).toContain('Bo Tan');
    expect(lines[1]).toContain('tok-b');
    expect(lines[1]).not.toContain('tok-a');
  });

  it('falls back to an ordinal rather than an empty label', () => {
    const md = ticketLinks(['', ''], ['tok-a', 'tok-b']);

    expect(md).toContain('Guest 1');
    expect(md).toContain('Guest 2');
  });
});

describe('names are data, not markup', () => {
  /**
   * Names arrive from a spreadsheet import. A `]` inside the link label would
   * close the Markdown link early and leave a raw URL in the message, so the
   * name is rendered outside the brackets.
   */
  it('survives a name containing link punctuation', () => {
    const html = markdownToHtml(ticketLinks(['Ada [nee Wong] Lim'], ['tok-a']));

    expect(html).toContain(`href="${APP_URL}/t/tok-a"`);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('Ada [nee Wong] Lim');
  });

  it('escapes a name containing HTML once the merge context is escaped', () => {
    const escaped = escapeMergeValues({ ticket_links: ticketLinks(['<b>Ada</b>'], ['tok-a']) });
    const html = markdownToHtml(escaped.ticket_links);

    expect(html).not.toContain('<b>Ada</b>');
    expect(html).toContain(`href="${APP_URL}/t/tok-a"`);
  });
});

describe('degenerate input', () => {
  it('renders nothing for a party with no tokens', () => {
    expect(ticketLinks([], [])).toBe('');
    expect(ticketLinks(null, null)).toBe('');
  });

  it('skips a seat whose token is missing rather than linking to /t/', () => {
    const md = ticketLinks(['Ada Lim', 'Bo Tan'], ['', 'tok-b']);

    expect(md.split('\n')).toHaveLength(1);
    expect(md).toContain('tok-b');
    expect(md).not.toMatch(/\/t\/\s*\)/);
  });
});
