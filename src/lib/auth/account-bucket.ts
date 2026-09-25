// In its own module, with no `server-only`, so `scripts/bootstrap-admin.ts`
// can clear an account's lockout with the same key the login charges.
// `rate-limit.ts` re-exports it.

/**
 * `account:<email>` — the second bucket every console sign-in counts against
 * (spec/v3.md §28: "per account as well as per IP").
 *
 * The IP bucket alone lets an attacker who rotates addresses guess one
 * account's password indefinitely; this one caps the guesses at an account
 * whoever is guessing. The cost is stated plainly: anyone who knows an admin's
 * address can lock that account out by failing on purpose. The lockout expires
 * on the same curve, and another admin — or `scripts/bootstrap-admin.ts` — can
 * still get in, which is the better failure than an account that can be
 * guessed at forever.
 *
 * Case-folded, because Supabase Auth treats addresses case-insensitively and
 * `Admin@x` must not be a fresh bucket for `admin@x`.
 */
export function accountBucket(email: string): string {
  return `account:${email.trim().toLowerCase()}`;
}
