import type { TemplateKey } from './templates';

/**
 * Seeded default wording for the eight §11.3 message types, so the system can
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
  player_notes_digest: {
    name: 'Notes from the audience',
    subject: 'Notes for you from {{ concert.name }}',
    bodyMd: [
      'Dear {{ registration.contact_name }},',
      '',
      'Members of the audience left these notes for you after **{{ show.name }}**.',
    ].join('\n'),
  },
};
