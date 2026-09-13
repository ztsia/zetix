/**
 * Normalising a person's name for display (`spec/tickets.md` §10.4).
 *
 * Shared by the ticket renderer and the email blast, because a guest who reads
 * "Dear LOH KAI XIN" above a ticket printed "Loh Kai Xin" has been sent two
 * different answers to the same question.
 *
 * Names arrive from a Google Form typed by whoever filled it in, so the same
 * ticket run carries `LOH KAI XIN`, `loh kai xin` and `Loh Kai Xin`. All
 * three are the same person and only one of them looks right on a ticket.
 *
 * **Normalising at render time rather than at import** is deliberate: the
 * imported row stays exactly as the guest wrote it, so an admin comparing the
 * sheet to the database sees the same string, and a future correction to these
 * rules reaches everything not yet rendered without rewriting anybody's stored
 * name.
 */

/**
 * Words that stay lowercase inside a name, unless they open it.
 *
 * `of` is here for the generated placeholder "Guest of {contact_name}"
 * (decision 32) — "Guest Of Tan Wei" is the kind of detail that makes a ticket
 * look machine-made. The rest are the particles that genuinely belong in names
 * this concert will see.
 */
const PARTICLES = new Set([
  'of', 'and', 'the',
  'bin', 'binti', 'bte', 'bt',
  'a/l', 'a/p', 'd/o', 's/o',
  'van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'dos', 'das',
  'la', 'le', 'el',
]);

/** Any letter that has a case distinction at all — Latin, Greek, Cyrillic. */
const HAS_CASE = /\p{Lu}|\p{Ll}/u;
const IS_UPPER = /\p{Lu}/u;
const IS_LOWER = /\p{Ll}/u;

/** Sub-word boundaries: `Jing-Wei`, `O'Brien`, `A.B.`, `a/l`. */
const PARTS = /([-'’./])/;

/**
 * Title-case a name without destroying one that was already typed correctly.
 *
 * The rule that does most of the work: **a token already carrying both cases is
 * left exactly alone.** `McDonald`, `O'Brien`, `DeSilva` and `bin` survive,
 * because someone who typed them that way meant them. Only tokens that are
 * entirely upper or entirely lower carry no information about their own
 * capitalisation, and those are the ones worth fixing.
 *
 * Text with no cased letters — every CJK name, for one — is returned untouched,
 * since `toUpperCase()` on a han character is a no-op that would still cost the
 * comparison.
 */
export function toNameCase(value: string): string {
  if (!HAS_CASE.test(value)) return value;

  const tokens = value.split(/(\s+)/);
  let wordIndex = 0;

  return tokens
    .map((token) => {
      if (/^\s+$/.test(token) || token === '') return token;
      const index = wordIndex++;
      if (!HAS_CASE.test(token)) return token;

      // Already mixed: the writer made a choice, and it is more likely right
      // than a rule is. `Mixed` here means both cases present, so `Jing` counts
      // as decided and `JING` does not.
      if (IS_UPPER.test(token) && IS_LOWER.test(token)) return token;

      const lower = token.toLowerCase();
      if (index > 0 && PARTICLES.has(lower)) return lower;

      return lower
        .split(PARTS)
        .map((part, i, all) => {
          if (PARTS.test(part)) return part;
          if (!part) return part;
          // `Mc` takes a capital on the syllable after it — `MCDONALD` is
          // McDonald. `Mac` does not: Macaulay, Mackenzie and MacArthur are all
          // real spellings and no rule picks between them, so it is left as the
          // writer's problem rather than guessed at.
          const capped = part[0].toUpperCase() + part.slice(1);
          if (/^mc[a-z]/.test(part) && all.length === 1) {
            return `Mc${part[2].toUpperCase()}${part.slice(3)}`;
          }
          return capped;
        })
        .join('');
    })
    .join('');
}
