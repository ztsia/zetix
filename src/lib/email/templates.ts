import 'server-only';
import type { messagePurpose } from '@/db/schema/enums';

export type MessagePurpose = (typeof messagePurpose.enumValues)[number];

/**
 * The eight message types of spec/email.md §11.3, and which of them carry
 * tickets.
 *
 * This is not an operational value and does not belong in the cascade — it is a
 * property of the message type, fixed by §11.3's own table, in the same way
 * that "a verification email contains a link" is. A blast cannot make
 * `registration_cancelled` carry a PDF by configuration, and nothing in
 * `context.md` supplies it.
 */

export const TEMPLATE_KEYS = [
  'player_confirmation',
  'public_verify',
  'public_ticket',
  'extras_granted',
  'extras_declined',
  'registration_cancelled',
  'reminder',
  'player_notes_digest',
  /**
   * V2. Sent after the show to everyone who was actually admitted, carrying one
   * portal link per admitted seat (spec/v2.md §13.5.2).
   *
   * **Not ticket-bearing**, which decides three things at once: it attaches no
   * PDF, it never stamps `ticket_sent_at`, and it does not wait on double opt-in
   * verification — the gate is about not sending *tickets* to an address we are
   * unsure of, and this goes to somebody who already came.
   */
  'feedback_request',
  /**
   * V3. What a form sends on submit: what was received, and that tickets
   * follow once the organisers confirm (spec/v3.md §25.3). Module `V` queues it
   * and folds the verification link into it for public forms.
   */
  'registration_receipt',
  /**
   * V3. The optional email inviting a player to share their form's link
   * (spec/v3.md §25.2). Player-addressed, like the notes digest.
   */
  'player_invite',
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/**
 * What each template's message is *for* (spec/v3.md §24.2, decision 52).
 *
 * The pending-message key is `(addressee, purpose)`, not the template, so every
 * insert into `email_outbox` must say which purpose it serves — the column has
 * no default, on purpose. `player_confirmation` and `public_ticket` are one
 * purpose worded for two audiences, and a party is only ever one of them;
 * `extras_granted` and `extras_declined` are one decision, so a second draft for
 * the same party is refused until the first is sent or cancelled (superseding
 * it instead is module `T`'s send wizard).
 *
 * Mirrors the backfill in `drizzle/0200_v3_schema_delta.sql`, which is what
 * `tests/email/purpose.test.ts` checks it against.
 */
export const TEMPLATE_PURPOSE = {
  player_confirmation: 'TICKETS',
  public_verify: 'VERIFICATION',
  public_ticket: 'TICKETS',
  extras_granted: 'EXTRAS_DECISION',
  extras_declined: 'EXTRAS_DECISION',
  registration_cancelled: 'CANCELLATION',
  reminder: 'REMINDER',
  player_notes_digest: 'NOTES_DIGEST',
  feedback_request: 'FEEDBACK',
  registration_receipt: 'RECEIPT',
  player_invite: 'PLAYER_INVITE',
} as const satisfies Record<TemplateKey, MessagePurpose>;

/**
 * The purpose to write for a template, or an error for a key that has none.
 * Refusing is the point: a guessed purpose would put the message under the
 * wrong pending key, where it either collides with an unrelated message or
 * fails to collide with its own duplicate.
 */
export function purposeFor(templateKey: string): MessagePurpose {
  const purpose = (TEMPLATE_PURPOSE as Record<string, MessagePurpose>)[templateKey];
  if (!purpose) throw new Error(`No message purpose for template "${templateKey}"`);
  return purpose;
}

/**
 * Which templates attach the party's PDFs, straight from §11.3's "To" column:
 * the player confirmation carries "summary + all guest tickets attached", the
 * public ticket carries "party's tickets attached", and extras granted is
 * "with tickets".
 *
 * **The rest carry none, and that distinction is load-bearing in two places.**
 * A cancellation or a decline must not render a ticket — it would attach a PDF
 * to the message telling someone they have no seat — and it must not stamp
 * `ticket_sent_at`, because that column means *the ticket was delivered*
 * (spec/domain.md §5.1). Stamping it from a decline would quietly exclude that
 * seat from every future blast.
 */
export const TICKET_BEARING: ReadonlySet<TemplateKey> = new Set<TemplateKey>([
  'player_confirmation',
  'public_ticket',
  'extras_granted',
]);

export function carriesTickets(key: string): boolean {
  return TICKET_BEARING.has(key as TemplateKey);
}

/**
 * The line under every ticket-bearing message, telling the reader what to
 * bring. One constant, because the dispatcher, the wizard's preview and the
 * Messages view's View must all show the same message the guest gets.
 */
export const TICKET_FOOTER =
  'Your ticket is the attached PDF. Show its QR code to the registration crew at the door — every guest needs their own.';
