import { randomBytes } from 'node:crypto';
import { bytesToBase62 } from '@/lib/tickets/identifiers';

/**
 * A player's invite token (spec/domain.md §5.1).
 *
 * Players never have accounts. The token *is* the credential — it is how a
 * player reaches their own registration link — so it carries the same 128 bits
 * as a `qr_token` and is generated the same way.
 *
 * It reuses `bytesToBase62` rather than a second encoder, because that one is
 * already tested against the properties that matter, but it is deliberately not
 * `generateQrToken()`: that function means "a ticket's token", `qr_token` is
 * immutable for the life of an attendee (decision 28), and an invite token is
 * the opposite — rotation is a supported admin action (spec/v2.md §8.1,
 * "Tokens are rotatable from admin"). Sharing the name would invite a future
 * reader to assume the same rules apply to both.
 *
 * **There is no URL builder here on purpose.** §8.1 specifies the player URL as
 * `/f/{form_slug}?k={token}` — a V2 native-form route, which needs a form slug
 * V1 does not have, because registration for this concert is on Google Forms.
 * An earlier draft invented `/invite/{token}` and offered a copy button over it,
 * which would have handed an admin a dead link to email to eighty players. When
 * V2 builds `/f/{slug}`, the builder belongs beside that route.
 */

/** 16 bytes is 128 bits, which base62 encodes in at most 22 characters. */
const INVITE_TOKEN_BYTES = 16;

/**
 * 22 characters, always.
 *
 * **The `padStart` is not cosmetic.** `bytesToBase62` encodes the bytes as one
 * big-endian integer, so a value that happens to fall below 62^21 encodes to 21
 * characters or fewer — several percent of tokens. `generateQrToken` pads for
 * this reason and the padding was dropped when this borrowed its encoder, which
 * made every fixed-length assumption downstream intermittently false and any
 * test asserting the length flaky rather than wrong.
 */
export const INVITE_TOKEN_LENGTH = 22;

export function generateInviteToken(): string {
  return bytesToBase62(randomBytes(INVITE_TOKEN_BYTES)).padStart(INVITE_TOKEN_LENGTH, '0');
}
