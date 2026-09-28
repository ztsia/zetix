import 'server-only';
import { randomBytes } from 'node:crypto';

/**
 * The party update link (spec/v3.md §25.6): a per-party tokenised link where
 * the party names unnamed guests, corrects its email, or gives back seats.
 *
 * **One token per party, stored on the party** (`registrations.update_token`),
 * for every party however it arrived. The form's `edit_token` is not reused:
 * it lives on a response and rotates with every edit (`v2.md` §8.3.1), so a
 * link in a receipt sent yesterday would stop working the moment the party
 * changed anything, and a merged or imported party has no single response to
 * carry it.
 *
 * The link travels only by email to the party's contact address — never on the
 * confirmation screen, which a second submission from the same address (§25.5)
 * also reaches, and which must not hand that person control of the party.
 */

/** Unguessable, like every other token here: possession is the credential. */
export function mintUpdateToken(): string {
  return randomBytes(24).toString('base64url');
}

/** `APP_URL`, never `VERCEL_URL` (`CLAUDE.md`). */
export function updateUrl(token: string): string {
  return `${process.env.APP_URL ?? ''}/f/update?t=${encodeURIComponent(token)}`;
}

/** What a token may look like, checked before it reaches the database. */
export const UPDATE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
