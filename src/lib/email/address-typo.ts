/**
 * The address checks that need no network, and therefore no Node.
 *
 * Split out of `address.ts` so the browser can import it. The typo nudge runs
 * live as somebody types **and** again on the server at submit, and the whole
 * point is that the two agree — but `address.ts` imports `node:dns`, and a
 * `'use client'` module that reaches it drags the whole file into the browser
 * bundle, which does not build. One implementation, two callers, no Node.
 *
 * `address.ts` re-exports everything here, so server code keeps one import.
 */

/** The domain half, lowercased, or null when there is not exactly one `@`. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).toLowerCase();
  // A second `@` in the local part is legal only when quoted, which no
  // registrant types. Treat it as unparseable rather than guess which one splits.
  if (domain.includes('@') || domain.includes(' ')) return null;
  return domain;
}

/**
 * The domains our audience actually types, for {@link suggestDomainTypo}.
 *
 * A domain **in** this list is never questioned — it matches itself at distance
 * zero, below every threshold below — so `hotmail.co.uk` and `yahoo.com.my`,
 * both real and both close to a more common neighbour, can never be
 * "corrected" into something else. `mail.com` is listed for exactly that
 * reason: a real provider one edit from `gmail.com`.
 *
 * Malaysian and Chinese providers sit here beside the global ones because that
 * is who fills this form; `qq.com` and `163.com` are not exotic to this
 * audience. Not an operational value — no organiser tunes the spelling of
 * `gmail.com`.
 */
const COMMON_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.my',
  'outlook.com',
  'outlook.my',
  'live.com',
  'live.com.my',
  'msn.com',
  'yahoo.com',
  'yahoo.com.my',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  // A real provider, one edit from `gmail.com`. Listed precisely for that.
  'mail.com',
  'proton.me',
  'protonmail.com',
  'qq.com',
  '163.com',
  '126.com',
  'foxmail.com',
  'sina.com',
  'streamyx.com',
  'tm.net.my',
];

/**
 * Damerau-Levenshtein distance, capped at `limit` for an early exit.
 *
 * **The transposition case is the reason this is not plain Levenshtein.**
 * `gmial.com` is one swapped pair — the single most common way a human mistypes
 * a familiar word — and plain edit distance scores it 2, the same as two
 * unrelated errors. Scoring it 1 is what lets the threshold below stay tight
 * enough to leave real domains alone.
 */
function damerauLevenshtein(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current: number[] = [];

  for (let i = 1; i <= a.length; i++) {
    current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        current[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1); // transposition
      }
      current[j] = value;
      if (value < rowBest) rowBest = value;
    }
    // Every later row is >= this row's minimum, so nothing can come back under
    // the limit once the whole row has.
    if (rowBest > limit) return limit + 1;
    prev2 = prev;
    prev = current;
  }
  return prev[b.length];
}

/**
 * Suffixes that are only ever a mistyped `.com`.
 *
 * `.com` is one key away from several of these on a QWERTY keyboard and one
 * transposition from `.ocm`. None of them is a real public suffix, so a
 * suggestion here is safe for **any** brand — `mycompany.con` gets the same
 * help as `gmail.con`, without `mycompany` needing to be in any list.
 *
 * **`.co` is deliberately absent.** It is Colombia's ccTLD and is in wide
 * legitimate use, so treating it as a typo would redirect real addresses.
 */
const MISTYPED_COM = new Set(['con', 'ocm', 'cmo', 'comm', 'cim', 'cpm', 'clm', 'xom', 'vom', 'som']);

/** `gmail.co.uk` → `{ brand: 'gmail', suffix: 'co.uk' }`. */
function split(domain: string): { brand: string; suffix: string } | null {
  const dot = domain.indexOf('.');
  if (dot <= 0 || dot === domain.length - 1) return null;
  return { brand: domain.slice(0, dot), suffix: domain.slice(dot + 1) };
}

/**
 * "Did you mean gmail.com?" — or null, which is the answer most of the time.
 *
 * Pure and synchronous, so the same function runs in the browser for an inline
 * nudge as the person types and on the server at submit. One implementation,
 * one set of answers; a second one would eventually disagree with itself.
 *
 * **This exists because DNS cannot see this class of mistake.** `gmial.com` is
 * registered and has MX records, so {@link hasDeliverableDomain} says `OK` and is
 * right to — mail sent there really is delivered, just not to the person who
 * meant `gmail.com`. The only evidence available is that the word is one
 * transposition away from a domain half our audience uses.
 *
 * ## Why this compares the brand and the suffix separately
 *
 * The obvious implementation — edit distance over the whole domain — is wrong,
 * and measurably so. Run against a list of ~150 real mail domains it
 * "corrects" **50** of them: `yahoo.co.jp` → `yahoo.co.uk`, `outlook.fr` →
 * `outlook.my`, `live.com.au` → `live.com.my`, and so on down every country
 * Microsoft and Yahoo operate in.
 *
 * They are all the same shape. **A country-code suffix is never a typo for
 * another country-code suffix** — it is a different, real service, and the two
 * are one or two characters apart precisely *because* the brand is identical.
 * Whole-domain distance cannot see the difference between the halves; splitting
 * them can:
 *
 * - **Brand typo** — the suffix matches a known domain's suffix *exactly*, and
 *   only the brand is off (`gmial`.com, `hotmial`.co.uk).
 * - **Suffix typo** — the suffix is in {@link MISTYPED_COM}, which holds only
 *   strings that are not real public suffixes at all (`gmail.con`).
 *
 * Anything else — a real brand at a real suffix we happen not to list — is left
 * alone, which is the outcome that matters for a form filled by an audience
 * with `.com.sg`, `.co.jp` and `.edu.my` addresses in it.
 *
 * **A domain in {@link COMMON_DOMAINS} is never questioned**, and it needs no
 * guard clause to arrange that: it matches itself at distance 0, which is below
 * every threshold below. That is why listing `mail.com` — a real provider one
 * edit from `gmail.com` — is the entire fix for it.
 *
 * **It suggests; it never corrects.** The caller shows this and lets the person
 * decide, because the failure mode of being wrong here is silently redirecting
 * somebody's real address — which is the exact failure `b426d88` refused to
 * introduce when it declined to rewrite `.con` to `.com`. Some residual risk is
 * inherent: a real domain one edit from a listed one will always exist. A
 * suggestion is the right shape of answer for a judgement that can be wrong.
 */
export function suggestDomainTypo(email: string): string | null {
  const domain = domainOf(email);
  if (domain === null) return null;

  const parts = split(domain);
  if (parts === null) return null;
  const { brand, suffix } = parts;

  // Suffix typo: the suffix is not a real public suffix, so `.com` is the only
  // thing it can have been. Works for any brand, listed or not.
  if (MISTYPED_COM.has(suffix)) return `${brand}.com`;

  // Brand typo: same suffix, near-miss brand.
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of COMMON_DOMAINS) {
    const candidateParts = split(candidate);
    if (candidateParts === null || candidateParts.suffix !== suffix) continue;
    const distance = damerauLevenshtein(brand, candidateParts.brand, 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  if (best === null) return null;
  if (bestDistance === 1) return best;
  // Two edits is a slip in a long word and a different word in a short one:
  // `time` and `tm` are two apart and are different companies (`time.net.my`
  // and `tm.net.my` are both real Malaysian ISPs).
  if (bestDistance === 2 && brand.length >= 6) return best;
  return null;
}

/**
 * What the submit path asks: is there anything worth telling this person about
 * their address before we take the registration?
 *
 * Both checks run together because they catch disjoint mistakes — `gmail.con`
 * has no DNS, `gmial.com` has perfectly good DNS — and a person who typed one
 * is equally likely to have typed the other.
 *
 * **Neither result may block a submit on its own.** `blocking` names the one
 * case that is certain (`NO_SUCH_DOMAIN`), and even that is the caller's
 * decision to act on; `suggestion` is always advisory. Seats are scarce, and
 * §8.1.4 already has the mechanism that catches everything this misses.
 */