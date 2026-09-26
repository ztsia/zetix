/**
 * Purposes and their default wording (spec/v3.md §24.2).
 *
 * A message has a purpose; the template is only how the purpose is worded. A
 * segment may store its own default per purpose (`segment_message_defaults`);
 * with no row, the table below decides by the segment's audience.
 *
 * This is a property of the message types, fixed by §24.2's own table — not an
 * operational value, so it is not in the settings cascade. No `server-only`:
 * the wizard's client half reads the labels.
 */

export const PURPOSES = [
  'RECEIPT',
  'VERIFICATION',
  'TICKETS',
  'EXTRAS_DECISION',
  'CANCELLATION',
  'REMINDER',
  'FEEDBACK',
  'NOTES_DIGEST',
  'PLAYER_INVITE',
  'REPLY',
] as const;

export type Purpose = (typeof PURPOSES)[number];
export type AudienceMode = 'PLAYER_INVITED' | 'PUBLIC';

export const PURPOSE_LABEL: Record<Purpose, string> = {
  RECEIPT: 'Receipt',
  VERIFICATION: 'Verification',
  TICKETS: 'Tickets',
  EXTRAS_DECISION: 'Extras decision',
  CANCELLATION: 'Cancellation',
  REMINDER: 'Reminder',
  FEEDBACK: 'Feedback',
  NOTES_DIGEST: 'Notes digest',
  PLAYER_INVITE: 'Player invite',
  REPLY: 'Reply',
};

/**
 * §24.2's "Default template (by audience)" column. `EXTRAS_DECISION` has two
 * templates for one decision, chosen by the decision rather than the audience,
 * so it has no single default; `REPLY` has none because a person writes it.
 */
const AUDIENCE_DEFAULT: Partial<Record<Purpose, Record<AudienceMode, string>>> = {
  RECEIPT: { PLAYER_INVITED: 'registration_receipt', PUBLIC: 'registration_receipt' },
  VERIFICATION: { PLAYER_INVITED: 'public_verify', PUBLIC: 'public_verify' },
  TICKETS: { PLAYER_INVITED: 'player_confirmation', PUBLIC: 'public_ticket' },
  CANCELLATION: { PLAYER_INVITED: 'registration_cancelled', PUBLIC: 'registration_cancelled' },
  REMINDER: { PLAYER_INVITED: 'reminder', PUBLIC: 'reminder' },
  FEEDBACK: { PLAYER_INVITED: 'feedback_request', PUBLIC: 'feedback_request' },
  NOTES_DIGEST: { PLAYER_INVITED: 'player_notes_digest', PUBLIC: 'player_notes_digest' },
  PLAYER_INVITE: { PLAYER_INVITED: 'player_invite', PUBLIC: 'player_invite' },
};

/** The template a segment words `purpose` with: its stored choice, else §24.2's table. */
export function defaultTemplateFor(
  purpose: Purpose,
  audience: AudienceMode,
  stored: string | null,
): string | null {
  return stored ?? AUDIENCE_DEFAULT[purpose]?.[audience] ?? null;
}
