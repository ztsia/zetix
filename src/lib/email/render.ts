import { marked } from 'marked';

/**
 * Template rendering: `{{ }}` merge fields over Markdown (spec/email.md §11.3).
 *
 * Pure and database-free, so the whole token list can be exercised without a
 * fixture. `queue.ts` fills the context from real rows; nothing here knows
 * where a value came from.
 */

export type MergeContext = Record<string, string>;

/**
 * The documented token list §11.3 asks for, and the source of the admin
 * editor's help text — one list, so the documentation cannot drift from what
 * actually resolves.
 */
export const TOKENS: { token: string; description: string }[] = [
  { token: 'concert.name', description: 'Concert name' },
  { token: 'show.name', description: 'Show name' },
  { token: 'show.starts_at', description: 'Show start, in the concert timezone' },
  { token: 'show.doors_open_at', description: 'Doors open, in the concert timezone' },
  { token: 'show.venue_name', description: 'Venue name' },
  { token: 'show.venue_address', description: 'Venue address' },
  { token: 'segment.name', description: 'Segment, e.g. "Player invited"' },
  { token: 'registration.contact_name', description: 'Who the message is addressed to' },
  { token: 'registration.contact_email', description: 'Their email address' },
  { token: 'registration.round_label', description: 'Round the booking came from' },
  { token: 'attendee_count', description: 'How many tickets are attached' },
  { token: 'attendee_names', description: 'The names on those tickets' },
  {
    token: 'ticket_links',
    description: 'A bulleted list — one /t/{token} link per ticket, labelled with the guest it belongs to',
  },
  {
    token: 'admitted_count',
    /**
     * Resolved only for `feedback_request` (spec/v2.md §13.5.2) — how many of
     * the party actually came, which is not `attendee_count` and is the number
     * that message is about.
     */
    description: 'How many of the party were admitted. Only resolves on the feedback message',
  },
  {
    token: 'feedback_links',
    /**
     * The feedback email's own link list: one `/t/{token}` per **admitted**
     * seat, so a party of four where three came gets three (decision 22).
     *
     * A separate token from `ticket_links` rather than a reuse of it, because
     * the two answer different questions — every seat, versus the seats that
     * were used — and a template that said `ticket_links` in a feedback message
     * would quietly mail the no-show a link too.
     */
    description:
      'A bulleted list — one portal link per person who was admitted. Only resolves on the feedback message',
  },
  {
    token: 'verify_url',
    /**
     * Resolved only for `public_verify` (spec/v2.md §8.1.4), which is the one
     * message that carries it — every other template would render it empty, and
     * the `missing` half of {@link RenderedTemplate} is what says so rather than
     * letting a blank land mid-sentence.
     */
    description: 'The double opt-in link. Only resolves on the "Verify your registration" message',
  },
  {
    token: 'player.name',
    /**
     * **The one message addressed to somebody who has no registration**
     * (decision 22, `modules-v2.md` §3.1). Every other template greets its
     * reader through `registration.contact_name`, which resolves to nothing on
     * a digest — a player is not a registrant and has no contact row.
     *
     * This is why the seeded `player_notes_digest` body had to change: it
     * opened with `registration.contact_name` and would have gone out as
     * "Dear ,".
     */
    description: 'The player the digest is addressed to. Only resolves on the notes digest',
  },
  {
    token: 'notes_list',
    /**
     * The digest's whole content: the notes written to this player, rendered as
     * §14.2 renders them on the admin screen — `"{body}" — from {name}`, or
     * Anonymous — so that the email and the console say the same thing.
     */
    description:
      'The notes written to this player, as a list. Only resolves on the notes digest',
  },
  {
    token: 'notes_count',
    description: 'How many notes the digest carries. Only resolves on the notes digest',
  },
];

const TOKEN_NAMES = new Set(TOKENS.map((t) => t.token));

/** `{{ token }}`, `{{token}}`, `{{  token  }}` — all the same field. */
const PLACEHOLDER = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

export type RenderedTemplate = {
  text: string;
  /**
   * Tokens the template asked for that are not in {@link TOKENS}.
   *
   * Surfaced rather than swallowed: a typo renders as an empty string, and an
   * empty string in the middle of a sentence is exactly the kind of thing that
   * reaches four hundred inboxes unnoticed. §11.5 requires a preview against a
   * real recipient for the same reason.
   */
  unknown: string[];
  /**
   * Tokens that *are* in {@link TOKENS} but resolved to an empty string for
   * this context.
   *
   * The same failure as `unknown` arriving by the other door: the template is
   * right and the **data** is missing, so `**When:** {{ show.starts_at }}`
   * renders as `When:` and nothing. A show with no `starts_at` is legal
   * (spec/domain.md §5.1 — every operational value is nullable), which is
   * exactly why nothing else catches this before the blast.
   */
  empty: string[];
};

export function renderTemplate(template: string, context: MergeContext): RenderedTemplate {
  const unknown: string[] = [];
  const empty: string[] = [];
  const text = template.replace(PLACEHOLDER, (_match, rawToken: string) => {
    const token = rawToken.toLowerCase();
    if (!TOKEN_NAMES.has(token)) {
      if (!unknown.includes(rawToken)) unknown.push(rawToken);
      return '';
    }
    const value = context[token] ?? '';
    if (value === '' && !empty.includes(token)) empty.push(token);
    return value;
  });
  return { text, unknown, empty };
}

/**
 * Markdown → HTML for the message body.
 *
 * **Merge values are escaped before they reach this**, in
 * {@link escapeMergeValues}: the template is admin-authored, but the values
 * substituted into it are attendee and registrant names, which arrive from a
 * spreadsheet import and are not trusted markup. Mail clients do not execute
 * script, so this is not the same risk as a web page — but a name containing
 * `<b>` should read as a name, not reformat the message.
 */
export function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeMergeValues(context: MergeContext): MergeContext {
  const escaped: MergeContext = {};
  for (const [key, value] of Object.entries(context)) {
    escaped[key] = value.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
  }
  return escaped;
}

/**
 * The plain-text alternative §11.3 requires, generated rather than stored so
 * the two halves of a message cannot drift.
 */
export function markdownToPlainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The email skeleton the rendered body is dropped into (§11.3).
 *
 * Three things drive the shape, and all three are email-client constraints
 * rather than taste:
 *
 * - **Styles are both inlined *and* declared in `<head>`.** Gmail and Apple
 *   Mail honour a `<style>` block; Outlook's Word engine largely does not, and
 *   some clients strip the block entirely. The `<style>` block carries the
 *   media query (which cannot be inlined); {@link INLINE_STYLES} carries the
 *   same rules on the elements themselves, so a client that drops the block
 *   still renders a readable message rather than an unstyled one.
 * - **Layout is a table, not a flex or grid container.** Outlook supports
 *   neither, and a ticket email that collapses is a guest who cannot find
 *   their link.
 * - **Colours are stated explicitly and the document declares `light`.** A
 *   client left to guess inverts the card in dark mode and can leave dark text
 *   on a dark ground.
 *
 * Nothing here is configurable and nothing here is a value from
 * `context.md` — it is typography, not operational data (§2.1).
 */
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const INK = '#18181b';
const MUTED = '#71717a';
const LINK = '#1d4ed8';
const RULE = '#e4e4e7';
const GROUND = '#f4f4f5';

/**
 * Applied to the tags `marked` actually emits for our templates.
 *
 * Keyed by the opening tag exactly as it appears in that output, so the
 * substitution stays a plain string replace: anything cleverer would be a
 * second HTML parser living next to the first.
 */
const INLINE_STYLES: [string, string][] = [
  ['<p>', `margin:0 0 16px;font-size:16px;line-height:1.6;color:${INK};`],
  ['<ul>', `margin:0 0 16px;padding:0 0 0 22px;`],
  ['<ol>', `margin:0 0 16px;padding:0 0 0 22px;`],
  ['<li>', `margin:0 0 8px;font-size:16px;line-height:1.6;color:${INK};`],
  ['<h1>', `margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:600;color:${INK};`],
  ['<h2>', `margin:24px 0 12px;font-size:20px;line-height:1.3;font-weight:600;color:${INK};`],
  ['<h3>', `margin:24px 0 8px;font-size:17px;line-height:1.4;font-weight:600;color:${INK};`],
  ['<blockquote>', `margin:0 0 16px;padding:8px 16px;border-left:3px solid ${RULE};color:${MUTED};`],
  ['<hr>', `margin:24px 0;border:0;border-top:1px solid ${RULE};`],
];

/** Adds a `style` attribute to the tags above, leaving everything else alone. */
function inlineBodyStyles(html: string): string {
  let out = html;
  for (const [tag, style] of INLINE_STYLES) {
    out = out.split(tag).join(`${tag.slice(0, -1)} style="${style}">`);
  }
  // `marked` always emits `<a href=` first, so this cannot collide with an
  // attribute of its own.
  return out.split('<a href=').join(`<a style="color:${LINK};text-decoration:underline;" href=`);
}

export type EmailDocumentOptions = {
  /**
   * The grey line most clients show after the subject. Left out, they fill it
   * with the first words of the markup instead.
   */
  preheader?: string;
  /**
   * The muted line under the card.
   *
   * Passed in rather than fixed here because only the caller knows what the
   * message is: `carriesTickets()` decides whether there is an attachment to
   * refer to, and a cancellation telling the reader to bring their ticket
   * would be worse than no footer at all.
   */
  footer?: string;
};

/**
 * Wraps a rendered body fragment in the full document that goes down the wire.
 *
 * Kept separate from {@link markdownToHtml} so the fragment is still available
 * on its own — the admin preview frames it, and the token tests assert against
 * it without a skeleton in the way.
 */
export function emailDocument(bodyHtml: string, options: EmailDocumentOptions = {}): string {
  const preheader = options.preheader?.trim();
  const footer = options.footer?.trim();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>
  body { margin:0; padding:0; width:100% !important; background:${GROUND}; }
  a { color:${LINK}; }
  @media (max-width:620px) {
    .zetix-card { padding:24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${GROUND};font-family:${FONT_STACK};">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${RULE};border-radius:8px;">
        <tr>
          <td class="zetix-card" style="padding:32px;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${INK};">
${inlineBodyStyles(bodyHtml)}
          </td>
        </tr>
      </table>
${
        footer
          ? `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
        <tr>
          <td style="padding:16px 32px 0;font-family:${FONT_STACK};font-size:13px;line-height:1.5;color:${MUTED};">${footer}</td>
        </tr>
      </table>`
          : ''
      }
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** {@link markdownToHtml} plus the skeleton — what {@link emailDocument} is for. */
export function markdownToEmailHtml(md: string, options: EmailDocumentOptions = {}): string {
  return emailDocument(markdownToHtml(md), options);
}
