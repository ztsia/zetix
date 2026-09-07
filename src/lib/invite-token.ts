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
 * the opposite — rotating one is a supported admin action. Sharing the name
 * would invite a future reader to assume the same rules apply to both.
 */

/** 16 bytes is 128 bits, which base62 encodes in 22 characters. */
const INVITE_TOKEN_BYTES = 16;

export function generateInviteToken(): string {
  return bytesToBase62(randomBytes(INVITE_TOKEN_BYTES));
}

/**
 * Where a player goes to claim their seats.
 *
 * Built from `APP_URL` by the caller rather than read here, because the origin
 * is environment configuration and this module is used from tests and scripts
 * that have none.
 */
export function inviteUrl(token: string, appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/invite/${token}`;
}
