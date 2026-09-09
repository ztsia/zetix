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
  { token: 'ticket_links', description: 'One /t/{token} link per ticket' },
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
};

export function renderTemplate(template: string, context: MergeContext): RenderedTemplate {
  const unknown: string[] = [];
  const text = template.replace(PLACEHOLDER, (_match, rawToken: string) => {
    const token = rawToken.toLowerCase();
    if (!TOKEN_NAMES.has(token)) {
      if (!unknown.includes(rawToken)) unknown.push(rawToken);
      return '';
    }
    return context[token] ?? '';
  });
  return { text, unknown };
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
