/**
 * Form links the site's own pages already use under `/f/` — a static route
 * wins over `/f/{slug}`, so a form given one of these could never be reached.
 * `verify` is the double opt-in link (`v2.md` §8.1.4); `update` is the party
 * update link (spec/v3.md §25.6).
 */
export const RESERVED_FORM_SLUGS: ReadonlySet<string> = new Set(['verify', 'update']);

export const RESERVED_SLUG_MESSAGE = 'That link is used by the site itself. Choose another.';
