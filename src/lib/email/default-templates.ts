import type { TemplateKey } from './templates';

/**
 * Seeded default wording for every message type (§11.3, and V3's receipt and
 * player invite), so the system can
 * send before anyone opens the editor — the same argument decision 10 makes for
 * ticket templates.
 *
 * **These are copy, not configuration.** No capacity, quota, deadline or cap
 * appears in them; every number a message states arrives through a merge field
 * resolved from real rows, which is why `{{ attendee_count }}` exists rather
 * than a sentence naming a party size.
 *
 * **Seeding is never an upsert.** Re-running it must not rewrite wording an
 * admin has edited — module `E` records the same rule for ticket templates, and
 * the failure there is worse only in degree.
 *
 * **This file carries no `server-only`, and that is why it is a separate file.**
 * The copy is inert data with no database in it, and `scripts/seed-email-templates.ts`
 * has to import it from plain Node — where `server-only` throws. The write that
 * uses it lives in `defaults.ts`, which is server-only as it should be.
 */
export const DEFAULT_TEMPLATES: Record<TemplateKey, { name: string; subject: string; bodyMd: string }> = {
  player_confirmation: {
    name: 'Player confirmation',
    subject: 'Your tickets for {{ concert.name }}',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Thank you for booking. Your {{ attendee_count }} ticket(s) for **{{ show.name }}** are attached to this email, one PDF per guest.',
      '',
      '- **When:** {{ show.starts_at }} (doors {{ show.doors_open_at }})',
      '- **Where:** {{ show.venue_name }}, {{ show.venue_address }}',
      '- **Guests:** {{ attendee_names }}',
      '',
      'Show the QR code on each ticket to the registration crew at the door. Every guest needs their own.',
      '',
      'You can also view them here:',
      '',
      '{{ ticket_links }}',
      '',
      'See you there.',
    ].join('\n'),
  },
  public_verify: {
    name: 'Verify your registration',
    subject: 'Confirm your registration for {{ concert.name }}',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Please confirm your email address to complete your registration for **{{ show.name }}**.',
      '',
      '[Confirm my email address]({{ verify_url }})',
      '',
      'Your tickets will follow once your registration is confirmed. Your seats are already held —',
      'confirming only tells us we can reach you.',
    ].join('\n'),
  },
  public_ticket: {
    name: 'Public ticket',
    subject: 'Your tickets for {{ concert.name }}',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Your {{ attendee_count }} ticket(s) for **{{ show.name }}** are attached, one PDF per person.',
      '',
      '- **When:** {{ show.starts_at }} (doors {{ show.doors_open_at }})',
      '- **Where:** {{ show.venue_name }}, {{ show.venue_address }}',
      '',
      'Admission is free and seating is unreserved, so please arrive in good time.',
      '',
      'You can also view your tickets here:',
      '',
      '{{ ticket_links }}',
    ].join('\n'),
  },
  extras_granted: {
    name: 'Extra tickets granted',
    subject: 'Your extra tickets for {{ concert.name }}',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Good news — we were able to grant your request for extra seats at **{{ show.name }}**.',
      '',
      'All {{ attendee_count }} of your ticket(s) are attached, including the ones you already had.',
      '',
      '{{ ticket_links }}',
    ].join('\n'),
  },
  extras_declined: {
    name: 'Extra tickets not available',
    subject: 'About your extra ticket request for {{ concert.name }}',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Thank you for your request for extra seats at **{{ show.name }}**. We are sorry that we could not meet it this time — the hall reached capacity.',
      '',
      'Any tickets you already hold are unaffected and remain valid.',
    ].join('\n'),
  },
  registration_cancelled: {
    name: 'Registration cancelled',
    subject: 'Your registration for {{ concert.name }} has been cancelled',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Your registration for **{{ show.name }}** has been cancelled, and any tickets previously issued for it are no longer valid.',
      '',
      'If this was not what you expected, please reply to this email.',
    ].join('\n'),
  },
  reminder: {
    name: 'Pre-show reminder',
    subject: '{{ show.name }} is coming up',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      '**{{ show.name }}** is almost here.',
      '',
      '- **When:** {{ show.starts_at }} (doors {{ show.doors_open_at }})',
      '- **Where:** {{ show.venue_name }}, {{ show.venue_address }}',
      '',
      'Have the QR code ready to show the registration crew at the door, one per guest. Seating is unreserved.',
    ].join('\n'),
  },
  /**
   * **The one message addressed to a player rather than a registration**
   * (decision 22). It greets through `{{ player.name }}`, because a player has
   * no registration and `registration.contact_name` resolves to nothing here —
   * the pre-V2 seed opened with it and would have sent "Dear ,".
   *
   * It names no show for the same kind of reason: a digest gathers every note
   * written to this player across the concert, which may be more than one
   * night, so `{{ show.name }}` has no single answer.
   */
  player_notes_digest: {
    name: 'Notes from the audience',
    subject: 'Notes for you from {{ concert.name }}',
    bodyMd: [
      'Dear {{ player.name }},',
      '',
      'Members of the audience left these notes for you after **{{ concert.name }}**.',
      '',
      '{{ notes_list }}',
      '',
      'Thank you for playing.',
    ].join('\n'),
  },
  feedback_request: {
    name: 'How was your evening?',
    subject: 'How was {{ show.name }}?',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Thank you for coming to **{{ show.name }}**. We would love to know how you found it —',
      'it takes a minute, and the orchestra reads every one.',
      '',
      '{{ feedback_links }}',
      '',
      'With thanks,',
      'The {{ concert.name }} team',
    ].join('\n'),
  },
  /**
   * V3 (spec/v3.md §25.3). States what was received and that tickets follow;
   * module `V` queues it on submit and folds the verification link in for a
   * public form.
   */
  registration_receipt: {
    name: 'Registration received',
    subject: 'We have your registration for {{ concert.name }}',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Thank you — we have your registration for **{{ show.name }}**: {{ attendee_count }} seat(s), for {{ attendee_names }}.',
      '',
      '{{ verify_section }}',
      '',
      'Your tickets will follow by email once the organisers have confirmed your registration.',
      'Please check your spam folder if you do not see them, and add this address to your contacts.',
      '',
      'To name your guests, correct your email address or give back seats you no longer need, use [your own link]({{ update_url }}).',
    ].join('\n'),
  },
  /** V3 (spec/v3.md §25.2). Player-addressed, so it greets through `{{ player.name }}`. */
  player_invite: {
    name: 'Invite your guests',
    subject: 'Invite your guests to {{ concert.name }}',
    bodyMd: [
      'Dear {{ player.name }},',
      '',
      'Registration for **{{ concert.name }}** is open. This link opens the form with your name already chosen:',
      '',
      '[Register your guests]({{ invite_url }})',
      '',
      'Share it with your family and friends.',
    ].join('\n'),
  },
};
