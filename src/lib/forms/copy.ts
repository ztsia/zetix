/**
 * `{{base_quota}}`-style interpolation into a form's copy (spec/v2.md §8.2,
 * spec/README.md §2.2).
 *
 * **Copy is code for this purpose.** `CLAUDE.md`'s first non-negotiable says no
 * operational value is hardcoded, and a form that reads *"you have 2 seats"*
 * because someone typed a 2 into a description box is the same bug as a `2` in
 * a `.ts` file, with the same failure: the admin changes the quota on the
 * settings screen, allocation follows, and the form goes on telling four hundred
 * people the old number.
 *
 * So every number in a form's text is a token, resolved through the cascade at
 * render time. This module is the pure half — the token list and the
 * substitution. `resolve-copy.ts` is the half that reads the database.
 */

/**
 * The tokens a form's copy may use.
 *
 * One list, so the builder's help text and what actually resolves cannot drift
 * — the same reasoning as `src/lib/email/render.ts`'s `TOKENS`, which this
 * follows deliberately rather than inventing a second convention.
 */
export const COPY_TOKENS: { token: string; description: string }[] = [
  { token: 'base_quota', description: "Seats this segment's players are each entitled to" },
  { token: 'base_claim_deadline', description: 'When unclaimed base seats are released, in the concert timezone' },
  { token: 'max_tickets_per_response', description: 'Total party size, the registrant included' },
  {
    token: 'max_additional_guests',
    description: 'Guests a public registrant may add — the party cap less their own seat',
  },
  { token: 'extra_rows_max', description: 'Rows in the "request extras" repeater' },
];

const TOKEN_NAMES = new Set(COPY_TOKENS.map((t) => t.token));

/** `{{ token }}`, `{{token}}`, `{{  token  }}` — all the same field. */
const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Resolved values, keyed by token. Built by `resolve-copy.ts`. */
export type CopyValues = Readonly<Record<string, string>>;

export type InterpolatedCopy = {
  text: string;
  /**
   * Tokens the copy asked for that {@link COPY_TOKENS} does not know.
   *
   * Surfaced rather than swallowed, exactly as the email renderer does: a typo
   * renders as an empty string, and an empty string in the middle of a sentence
   * is the kind of thing that reaches four hundred readers unnoticed. `L`'s
   * preview shows these; the public renderer does not, because a stranger
   * filling in a form cannot act on it.
   */
  unknown: string[];
};

/**
 * Substitute resolved values into one piece of copy.
 *
 * **A known token with no resolved value renders as the fallback, not as a
 * number.** An operational value has no code default (spec/README.md §2.1), so
 * "nobody has set the base quota yet" has to read as something other than a
 * confident figure — the caller passes what to say instead, and
 * {@link UNSET_PLACEHOLDER} is what the public surfaces use.
 */
export function interpolateCopy(
  copy: string,
  values: CopyValues,
  fallback = UNSET_PLACEHOLDER,
): InterpolatedCopy {
  const unknown: string[] = [];
  const text = copy.replace(PLACEHOLDER, (_match, rawToken: string) => {
    const token = rawToken.toLowerCase();
    if (!TOKEN_NAMES.has(token)) {
      if (!unknown.includes(rawToken)) unknown.push(rawToken);
      return '';
    }
    return values[token] ?? fallback;
  });
  return { text, unknown };
}

/**
 * What an unresolved but valid token renders as.
 *
 * A visible placeholder rather than a blank, because "You may bring up to
 * **&nbsp;** guests" reads as a rendering bug to the reader and as nothing at
 * all to the admin previewing it. This word tells both of them the same thing.
 */
export const UNSET_PLACEHOLDER = '—';

/** Every token one piece of copy uses, in order of first appearance. */
export function tokensUsed(copy: string): string[] {
  const found: string[] = [];
  for (const match of copy.matchAll(PLACEHOLDER)) {
    const token = match[1]?.toLowerCase();
    if (token && !found.includes(token)) found.push(token);
  }
  return found;
}
