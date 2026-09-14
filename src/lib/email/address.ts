/**
 * Does this address stand a chance of being delivered?
 *
 * Three layers already exist and this is the fourth, so the boundaries matter:
 *
 * | Layer | Where | Catches |
 * |---|---|---|
 * | Syntax | `forms/answers.ts` (`z.email()`), pure | `not-an-address` |
 * | Whitespace | `import/plan.ts`, `email/dispatch.ts` | `may _zxample@yahoo.com` |
 * | **This module** | the submit path | `gmail.con`, `gmial.com` |
 * | Double opt-in | `v2.md` §8.1.4 | everything else, including a dead mailbox |
 *
 * **Nothing here proves an address works.** Only the verification click does
 * that, and it is the reason §8.1.4 exists. What this buys is the class of
 * mistake a person can still fix *while they are looking at the form* — an
 * hour later they are gone, and the address is an admin's problem.
 *
 * The evidence is a real blast (commit `b426d88`): `zxample.guest@gmail.con`
 * and `zxguest@yahoo.com.my` both bounced. They fail differently and that
 * asymmetry shapes this whole module:
 *
 * - `gmail.con` — no such TLD, so **no MX and no A record**. Nothing can ever
 *   be delivered there and DNS says so for free. {@link hasDeliverableDomain}.
 * - `yahoo.com.my` — a **real domain** with real MX. Only Yahoo knows the
 *   mailbox is dead. Undetectable here, by anything, at any price (see
 *   "What this deliberately does not do").
 *
 * And the third case neither of those covers: `gmial.com` is registered, has
 * MX, and is a typo. DNS is happy; only the shape of the word is suspicious.
 * {@link suggestDomainTypo}.
 *
 * ## What this deliberately does not do
 *
 * **It never probes for a mailbox.** An SMTP `RCPT TO` probe is the only way to
 * ask "does this mailbox exist", and it is not available to us: Vercel does not
 * allow outbound port 25, Gmail and Outlook accept-all at `RCPT` and bounce
 * afterwards — so the answer is meaningless for most of our addresses — and
 * probing earns the sending IP a place on a blocklist. A paid verification API
 * would answer, at the cost of sending every registrant's address to a third
 * party. That is an organiser's call about their audience's data, not a default
 * this module should quietly make.
 *
 * **It never rewrites an address.** {@link suggestDomainTypo} returns a
 * suggestion for a human to accept or decline. `b426d88` made exactly this
 * point when it declined to rewrite `.con` to `.com`: a rule that edits
 * addresses eventually edits a real one, and then a person silently does not
 * get their ticket.
 */

import 'server-only';
import { promises as dns } from 'node:dns';
import { domainOf, suggestDomainTypo } from './address-typo';

/**
 * Re-exported so server callers keep one import for "address checks", while the
 * browser imports `./address-typo` directly and never pulls `node:dns` in.
 */
export { suggestDomainTypo } from './address-typo';

/**
 * How long DNS gets before we stop waiting.
 *
 * A guard, not an operational value — the same class as `MAX_ANSWER_LENGTH` in
 * `forms/answers.ts` and the login throttle's `MAX_DOUBLINGS`, and settled the
 * same way (`README.md` §2.1 governs capacities, quotas and deadlines; this is
 * none of them). It is not in the settings cascade because there is no
 * organiser question it answers: nobody wants a different number, they want the
 * form to submit.
 *
 * Two seconds is above a healthy resolver's worst case and below the point a
 * person believes the button did not work. Either way {@link hasDeliverableDomain}
 * fails **open**, so the cost of it being wrong is one unverified address, not
 * one lost registration.
 */
const DNS_TIMEOUT_MS = 2_000;

export type DomainCheck =
  /** MX or A records exist. The domain can receive mail; the mailbox is unknown. */
  | { state: 'OK' }
  /**
   * DNS answered definitively that the domain does not exist. This is the only
   * state a caller may show as an error, and `gmail.con` is why it exists.
   */
  | { state: 'NO_SUCH_DOMAIN'; domain: string }
  /**
   * DNS could not answer — timeout, `SERVFAIL`, no network, an unparseable
   * address. **Not a verdict.** The caller carries on exactly as if the check
   * had passed; see {@link hasDeliverableDomain}.
   */
  | { state: 'UNKNOWN'; domain: string | null; reason: string };

/** DNS error codes that mean "this name definitively does not exist". */
const DEFINITIVE_ABSENCE = new Set(['ENOTFOUND', 'NXDOMAIN']);

/** DNS error codes that mean "the name exists, it just has no record of this type". */
const NO_RECORD_OF_TYPE = new Set(['ENODATA']);

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code);
  return error instanceof Error ? error.name : 'UNKNOWN';
}

/** Rejects with a tagged error if `work` outlives {@link DNS_TIMEOUT_MS}. */
function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`DNS did not answer within ${DNS_TIMEOUT_MS}ms`);
      Object.assign(error, { code: 'ETIMEOUT' });
      reject(error);
    }, DNS_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Can this domain receive mail at all?
 *
 * **This fails open, and that is the whole design.** Every outcome that is not
 * a definitive `NXDOMAIN` — a timeout, a `SERVFAIL`, a resolver that is down,
 * an address this cannot parse — comes back `UNKNOWN`, and an `UNKNOWN` caller
 * submits the registration. Seats are scarce and a registration is worth more
 * than a DNS lookup is: refusing a real registrant because a resolver blinked
 * would be a far worse bug than accepting one typo, especially since the typo
 * is caught an hour later by the verification link never being clicked, and the
 * lost registration is caught by nobody.
 *
 * **No MX is not the same as no mail.** RFC 5321 §5.1 falls back to the A
 * record, and small domains really do rely on it, so an `ENODATA` from
 * `resolveMx` is followed by an address lookup before anything is declared
 * dead. Skipping that second query would reject a working domain, which is the
 * one outcome this must not produce.
 */
export async function hasDeliverableDomain(email: string): Promise<DomainCheck> {
  const domain = domainOf(email);
  if (domain === null) return { state: 'UNKNOWN', domain: null, reason: 'unparseable address' };

  try {
    const mx = await withTimeout(dns.resolveMx(domain));
    // A domain can answer with an empty set rather than ENODATA. Same meaning.
    if (mx.length > 0) return { state: 'OK' };
  } catch (error) {
    const code = errorCode(error);
    if (DEFINITIVE_ABSENCE.has(code)) return { state: 'NO_SUCH_DOMAIN', domain };
    if (!NO_RECORD_OF_TYPE.has(code)) return { state: 'UNKNOWN', domain, reason: code };
    // ENODATA — the name exists but has no MX. Fall through to the A lookup.
  }

  try {
    await withTimeout(dns.lookup(domain));
    return { state: 'OK' };
  } catch (error) {
    const code = errorCode(error);
    if (DEFINITIVE_ABSENCE.has(code) || NO_RECORD_OF_TYPE.has(code)) {
      return { state: 'NO_SUCH_DOMAIN', domain };
    }
    return { state: 'UNKNOWN', domain, reason: code };
  }
}

/**
 * What the submit path asks: is there anything worth telling this person about
 * their address before we take the registration?
 *
 * Both checks run together because they catch disjoint mistakes — `gmail.con`
 * has no DNS, `gmial.com` has perfectly good DNS — and somebody who typed one
 * is equally likely to have typed the other.
 *
 * **Neither result may block a submit on its own.** `blocking` names the one
 * case DNS is certain of; acting on it is the caller's decision, and the submit
 * action takes it as a warning the second attempt passes rather than a wall.
 * `suggestion` is always advisory. Seats are scarce, and §8.1.4 already has the
 * mechanism that catches everything this misses.
 */
export async function adviseOnAddress(email: string): Promise<{
  blocking: string | null;
  suggestion: string | null;
}> {
  const [check, suggestion] = await Promise.all([
    hasDeliverableDomain(email),
    Promise.resolve(suggestDomainTypo(email)),
  ]);

  return {
    blocking:
      check.state === 'NO_SUCH_DOMAIN'
        ? `We could not find the mail server for “${check.domain}”. Please check the spelling — ` +
          'nothing can be delivered to that address as written.'
        : null,
    suggestion,
  };
}
