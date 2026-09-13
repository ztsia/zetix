import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ticketLinks } from '@/lib/email/queue';
import { QR_TOKEN_LENGTH } from '@/lib/tickets/identifiers';
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

/**
 * Fixtures are the **real** token shape, `[0-9A-Za-z]{22}` (§10.1 rule 2).
 *
 * They used to read `tok-a`, which no minted token can ever look like, so the
 * suite could not tell a token from anything else that happened to be truthy —
 * and that is precisely the distinction the `"NULL"` case below turns on.
 */
const tok = (seed: string) => seed.padEnd(QR_TOKEN_LENGTH, '0');
const TOK_A = tok('a');
const TOK_B = tok('b');
const TOK_C = tok('c');

beforeEach(() => {
  process.env.APP_URL = APP_URL;
});

afterEach(() => {
  delete process.env.APP_URL;
});

describe('one line per ticket', () => {
  it('renders each link as its own HTML list item, not one run-together line', () => {
    const md = ticketLinks(['Ada Lim', 'Bo Tan', 'Cheng Wei'], [TOK_A, TOK_B, TOK_C]);
    const html = markdownToHtml(md);

    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain(`${APP_URL}/t/${TOK_A}`);
    expect(html).toContain(`${APP_URL}/t/${TOK_C}`);
  });

  /**
   * The regression itself, pinned directly: two links must never end up in one
   * block-level element. Joining with `'\n'` again turns this red while the
   * `<li>` count above would still pass at three only by accident.
   */
  it('never puts two links inside the same block', () => {
    const html = markdownToHtml(ticketLinks(['Ada Lim', 'Bo Tan'], [TOK_A, TOK_B]));
    const blocks = html.split(/<\/li>|<\/p>/).filter((b) => b.includes('/t/'));

    for (const block of blocks) {
      expect(block.match(/\/t\//g)).toHaveLength(1);
    }
    expect(blocks).toHaveLength(2);
  });

  it('keeps one link per line in the plain-text alternative too', () => {
    const text = markdownToPlainText(ticketLinks(['Ada Lim', 'Bo Tan'], [TOK_A, TOK_B]));
    const lines = text.split('\n').filter((l) => l.includes('/t/'));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Ada Lim');
    expect(lines[0]).toContain(`${APP_URL}/t/${TOK_A}`);
  });
});

describe('each link says whose ticket it is', () => {
  it('labels every link with its own seat', () => {
    const html = markdownToHtml(ticketLinks(['Ada Lim', 'Guest of Ada Lim'], [TOK_A, TOK_B]));

    expect(html).toMatch(new RegExp(`Ada Lim[^<]*<a href="[^"]*${TOK_A}"`));
    expect(html).toMatch(new RegExp(`Guest of Ada Lim[^<]*<a href="[^"]*${TOK_B}"`));
  });

  /**
   * Both arrays are `array_agg(... order by a.id)`, so index `i` is the same
   * seat in both — and filtering one of them alone would slide every later
   * label onto the wrong person. A ticket labelled with someone else's name is
   * worse than an unlabelled one, so the pairing is asserted rather than
   * assumed.
   */
  it('keeps a name with its own token when an earlier name is blank', () => {
    const md = ticketLinks(['', 'Bo Tan'], [TOK_A, TOK_B]);
    const lines = md.split('\n');

    expect(lines[1]).toContain('Bo Tan');
    expect(lines[1]).toContain(TOK_B);
    expect(lines[1]).not.toContain(TOK_A);
  });

  it('falls back to an ordinal rather than an empty label', () => {
    const md = ticketLinks(['', ''], [TOK_A, TOK_B]);

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
    const html = markdownToHtml(ticketLinks(['Ada [nee Wong] Lim'], [TOK_A]));

    expect(html).toContain(`href="${APP_URL}/t/${TOK_A}"`);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('Ada [nee Wong] Lim');
  });

  it('escapes a name containing HTML once the merge context is escaped', () => {
    const escaped = escapeMergeValues({ ticket_links: ticketLinks(['<b>Ada</b>'], [TOK_A]) });
    const html = markdownToHtml(escaped.ticket_links);

    expect(html).not.toContain('<b>Ada</b>');
    expect(html).toContain(`href="${APP_URL}/t/${TOK_A}"`);
  });
});

describe('degenerate input', () => {
  it('renders nothing for a party with no tokens', () => {
    expect(ticketLinks([], [])).toBe('');
    expect(ticketLinks(null, null)).toBe('');
  });

  /**
   * The one that reached an inbox. `postgres.js` parses a NULL element of a
   * *text* array as the four-character string `"NULL"`, so an unissued seat
   * arrived here as a truthy token and mailed out as `/t/NULL` — a link that
   * looks live, resolves to nothing, and sits under the guest's own name. The
   * query filters those out now; this pins the second door.
   */
  it('skips the literal "NULL" postgres.js hands back for an unissued seat', () => {
    const md = ticketLinks(['Ada Lim', 'Bo Tan'], ['NULL', TOK_B]);

    expect(md).not.toContain('/t/NULL');
    expect(md).toContain(`/t/${TOK_B}`);
    expect(md.split('\n')).toHaveLength(1);
  });

  it('skips anything that is not the minted token shape', () => {
    // Belt and braces for the same class: a truncated or mangled token is a
    // dead link with a guest's name on it, which is worse than no link.
    expect(ticketLinks(['Ada Lim'], ['short'])).toBe('');
    expect(ticketLinks(['Ada Lim'], [`${TOK_A}extra`])).toBe('');
  });

  it('skips a seat whose token is missing rather than linking to /t/', () => {
    const md = ticketLinks(['Ada Lim', 'Bo Tan'], ['', TOK_B]);

    expect(md.split('\n')).toHaveLength(1);
    expect(md).toContain(TOK_B);
    expect(md).not.toMatch(/\/t\/\s*\)/);
  });
});
