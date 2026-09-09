import { randomBytes } from 'node:crypto';

/**
 * The operator's access code (spec/admin.md §14.3, spec/checkin.md §12.1).
 *
 * An operator signs in with a display name and this code; behind the form it is
 * the password on a synthetic `<slug>@operators.invalid` Supabase Auth user
 * (decision 20a). It is shown **once**, on screen, for the admin to pass on.
 *
 * Two constraints pull against each other and both are real:
 *
 * - **It must be typeable.** An usher retypes it from a screenshot or a WhatsApp
 *   message, on a phone keyboard, once during setup. Ambiguous glyphs are the
 *   failure: there is no decode step that forgives `O` for `0`, because the code
 *   is a password compared byte for byte.
 * - **It must resist guessing.** Operator sign-in is deliberately *not* rate
 *   limited — a lockout at the door during arrivals is the worse failure, and
 *   that trade is recorded in `F2`'s handoff. So entropy is the only thing
 *   protecting one show's full attendee roster, and it has to be enough on its
 *   own.
 *
 * Twelve characters over a 30-glyph alphabet is ~59 bits, which is far past what
 * an online guessing attack against a hosted Auth endpoint can reach, while
 * staying short enough to read down a phone line in three groups of four.
 */

/**
 * Digits and capitals with every confusable pair removed: no `0`/`O`, no
 * `1`/`I`/`L`. `U` is dropped as well, which costs nothing and keeps the
 * generator from spelling anything an usher would rather not read aloud.
 */
export const ACCESS_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters of actual entropy. The hyphens below are formatting, not secret. */
export const ACCESS_CODE_LENGTH = 12;

const GROUP_SIZE = 4;

/**
 * A fresh access code, grouped as `ABCD-EFGH-JKMN`.
 *
 * **The hyphens are part of the code**, not decoration stripped before use. What
 * is displayed is exactly what the operator types, because the alternative — a
 * pretty version on screen and a different real one in the database — is an
 * usher who cannot sign in and an admin who is certain they read it correctly.
 *
 * **Rejection sampling, not `% alphabet.length`.** 256 is not a multiple of 30,
 * so a modulo draw would make the first six glyphs about 20% likelier than the
 * rest and quietly cost a few bits. Bytes that land in the short tail are
 * discarded and redrawn instead, which is unbiased and, at a 94% acceptance
 * rate, costs nothing worth measuring.
 */
export function generateAccessCode(): string {
  const size = ACCESS_CODE_ALPHABET.length;
  /** The largest multiple of `size` that fits in a byte; above it, redraw. */
  const limit = Math.floor(256 / size) * size;

  const chars: string[] = [];
  while (chars.length < ACCESS_CODE_LENGTH) {
    // Drawn in batches so a code costs one or two syscalls rather than twelve.
    for (const byte of randomBytes(ACCESS_CODE_LENGTH)) {
      if (byte >= limit) continue;
      chars.push(ACCESS_CODE_ALPHABET[byte % size]!);
      if (chars.length === ACCESS_CODE_LENGTH) break;
    }
  }

  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP_SIZE) {
    groups.push(chars.slice(i, i + GROUP_SIZE).join(''));
  }
  return groups.join('-');
}
