/**
 * The three fixtures module `K` is measured against: a player form, a public
 * form and a feedback form (`docs/modules-v2.md` §3, `K`).
 *
 * They are the real shapes, not minimal ones — each carries custom blocks,
 * conditional fields and `{{token}}` copy, so "one component renders all three"
 * means the component actually handled every feature rather than three
 * variations on a text box.
 *
 * Kept in `tests/` rather than in `src/`: they are the acceptance criteria, and
 * a fixture that ships is a fixture something will eventually import in
 * production and treat as a default (spec/README.md §2.1).
 */

import type { FormSchema } from '@/lib/forms/schema';

/**
 * A player form: details, base seats, extra seats, and a custom block whose
 * second question is conditional on its first (spec/v2.md §8.1.1).
 */
export const PLAYER_FORM: FormSchema = {
  kind: 'PLAYER',
  blocks: [
    {
      id: 'registrant',
      type: 'REGISTRANT',
      title: 'Your details',
      // The player is a performer, not audience (decision 3).
      creates_seat: false,
      fields: [
        { key: 'contact_name', label: 'Your name', type: 'text', system: true, required: true },
        { key: 'contact_email', label: 'Email', type: 'email', system: true, required: true },
        { key: 'contact_phone', label: 'Mobile', type: 'tel', system: true, required: false },
      ],
    },
    {
      id: 'base',
      type: 'GUESTS_BASE',
      title: 'Your seats',
      description_md: 'You have **{{base_quota}}** seats. Claim them by {{base_claim_deadline}}.',
      add_label: 'Add a seat',
      guest_fields: [
        { key: 'full_name', label: 'Guest name', type: 'text', system: true, required: true },
        { key: 'email', label: 'Their email (optional)', type: 'email', system: true, required: false },
        {
          key: 'seat_note',
          label: 'Anything we should know?',
          type: 'text',
          system: false,
          required: false,
        },
      ],
    },
    {
      id: 'extras',
      type: 'GUESTS_EXTRA',
      title: 'Extra seats',
      description_md: 'Requests are reviewed after the deadline, in the order they arrive.',
      guest_fields: [
        { key: 'full_name', label: 'Guest name', type: 'text', system: true, required: true },
        { key: 'email', label: 'Their email (optional)', type: 'email', system: true, required: false },
      ],
    },
    {
      id: 'logistics',
      type: 'CUSTOM',
      title: 'Anything else',
      fields: [
        {
          key: 'transport',
          label: 'How are your guests arriving?',
          type: 'radio',
          system: false,
          required: true,
          options: [
            { value: 'car', label: 'By car' },
            { value: 'public', label: 'Public transport' },
            { value: 'other', label: 'Something else' },
          ],
        },
        {
          key: 'parking_plate',
          label: 'Car registration',
          type: 'text',
          system: false,
          required: false,
          help_md: 'So the car park knows to expect you.',
          condition: { field: 'transport', op: 'eq', value: 'car' },
        },
        {
          key: 'accessibility',
          label: 'Accessibility needs',
          type: 'textarea',
          system: false,
          required: false,
        },
      ],
    },
  ],
};

/**
 * A public form: the registrant is seat #1, and the party repeater renders
 * `form.max_tickets_per_response − 1` rows (§8.1.2, decision 36).
 *
 * Carries the remaining field types the player fixture does not — `select`,
 * `multiselect`, `number`, `checkbox`, `date` — so between the three every one
 * of the ten is rendered at least once.
 */
export const PUBLIC_FORM: FormSchema = {
  kind: 'PUBLIC',
  blocks: [
    {
      id: 'registrant',
      type: 'REGISTRANT',
      title: 'Your details',
      description_md: 'Your own seat is included — you do not need to add yourself below.',
      // The public registrant is always one of the N (decision 36).
      creates_seat: true,
      fields: [
        { key: 'contact_name', label: 'Full name', type: 'text', system: true, required: true },
        { key: 'contact_email', label: 'Email', type: 'email', system: true, required: true },
        {
          key: 'heard_from',
          label: 'How did you hear about us?',
          type: 'select',
          system: false,
          required: false,
          options: [
            { value: 'friend', label: 'From a friend' },
            { value: 'social', label: 'Social media' },
            { value: 'poster', label: 'A poster' },
          ],
        },
        {
          key: 'social_handle',
          label: 'Which platform?',
          type: 'text',
          system: false,
          required: false,
          condition: { field: 'heard_from', op: 'eq', value: 'social' },
        },
      ],
    },
    {
      id: 'party',
      type: 'GUESTS_PARTY',
      title: 'Who else is coming?',
      description_md: 'You may bring up to **{{max_additional_guests}}** guests.',
      add_label: 'Add a guest',
      guest_fields: [
        { key: 'full_name', label: 'Guest name', type: 'text', system: true, required: true },
      ],
    },
    {
      id: 'extras',
      type: 'CUSTOM',
      title: 'Before you go',
      fields: [
        {
          key: 'interests',
          label: 'What would you like to hear more about?',
          type: 'multiselect',
          system: false,
          required: false,
          options: [
            { value: 'concerts', label: 'Future concerts' },
            { value: 'outreach', label: 'Outreach and workshops' },
            { value: 'joining', label: 'Joining the orchestra' },
          ],
        },
        {
          key: 'instrument',
          label: 'Which instrument do you play?',
          type: 'text',
          system: false,
          required: true,
          condition: { field: 'interests', op: 'contains', value: 'joining' },
        },
        { key: 'party_size_note', label: 'Children in your party', type: 'number', system: false, required: false },
        { key: 'first_visit', label: 'This is my first concert with us', type: 'checkbox', system: false, required: false },
        { key: 'preferred_date', label: 'If we add a second night, which suits you?', type: 'date', system: false, required: false },
        {
          key: 'newsletter_consent',
          label: 'I agree to receive occasional emails about future concerts',
          type: 'checkbox',
          system: false,
          required: true,
        },
      ],
    },
  ],
};

/**
 * A feedback form: no seat blocks and no registrant block at all — the attendee
 * is already known from their own `qr_token` (§13.5).
 */
export const FEEDBACK_FORM: FormSchema = {
  kind: 'FEEDBACK',
  blocks: [
    {
      id: 'evening',
      type: 'CUSTOM',
      title: 'How was your evening?',
      description_md: 'Two minutes, and it genuinely shapes the next one.',
      fields: [
        {
          key: 'overall',
          label: 'Overall, how was it?',
          type: 'radio',
          system: false,
          required: true,
          options: [
            { value: '5', label: 'Wonderful' },
            { value: '4', label: 'Good' },
            { value: '3', label: 'Fine' },
            { value: '2', label: 'Not great' },
            { value: '1', label: 'Poor' },
          ],
        },
        {
          key: 'what_went_wrong',
          label: 'What let it down?',
          type: 'textarea',
          system: false,
          required: false,
          condition: { field: 'overall', op: 'in', value: ['1', '2'] },
        },
        { key: 'highlight', label: 'A highlight?', type: 'textarea', system: false, required: false },
        {
          key: 'come_again',
          label: 'Would you come again?',
          type: 'select',
          system: false,
          required: false,
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'maybe', label: 'Maybe' },
            { value: 'no', label: 'No' },
          ],
        },
      ],
    },
  ],
};

export const ALL_FIXTURES = { PLAYER_FORM, PUBLIC_FORM, FEEDBACK_FORM } as const;

/** A deep clone, so a test that mutates a fixture cannot leak into the next one. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
