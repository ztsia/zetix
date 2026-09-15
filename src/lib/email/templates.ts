import 'server-only';

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
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

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
