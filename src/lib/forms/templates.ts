/**
 * The starting schema for each kind — the system blocks, pre-built (spec/v2.md
 * §8.2, decision 35).
 *
 * **The builder never composes these from scratch.** `L`'s editor starts a new
 * form from the template for its `kind` and can add, reorder and delete only
 * `CUSTOM` blocks and custom fields on top of it. That is what "system blocks
 * are pre-built from `kind` and cannot be added or deleted" means in practice,
 * and putting the templates next to the catalogue they are built from is what
 * stops the two drifting: a system field added to `system-fields.ts` appears in
 * every new form without anyone editing a second list.
 *
 * The copy here is a **starting label**, not configuration. Every number in a
 * form's text comes from `copy.ts`'s tokens, resolved through the cascade — a
 * capacity, quota or cap written into this file would be exactly the bug
 * `CLAUDE.md`'s first non-negotiable describes.
 */

import type { FormKind, FormSchema, FormField } from './schema';
import { GUEST_SYSTEM_FIELDS, REGISTRANT_SYSTEM_FIELDS, type SystemFieldSpec } from './system-fields';

function systemField(spec: SystemFieldSpec): FormField {
  return {
    key: spec.key,
    label: spec.defaultLabel,
    type: spec.type,
    system: true,
    required: spec.required,
  };
}

const registrantFields = () => REGISTRANT_SYSTEM_FIELDS.map(systemField);
const guestFields = () => GUEST_SYSTEM_FIELDS.map(systemField);

/**
 * A new, valid, empty form of the given kind.
 *
 * Always parses — `tests/forms/copy.test.ts` proves it for all three, which is
 * what makes this the one safe way to create a form. A builder that hand-assembled
 * blocks would eventually assemble one the contract refuses, and the admin
 * would meet that refusal on an otherwise blank screen.
 */
export function blankFormSchema(kind: FormKind): FormSchema {
  switch (kind) {
    case 'PLAYER':
      return {
        kind,
        blocks: [
          {
            id: 'registrant',
            type: 'REGISTRANT',
            title: 'Your details',
            // A player is a performer, not audience (decision 3).
            creates_seat: false,
            fields: registrantFields(),
          },
          {
            id: 'base_seats',
            type: 'GUESTS_BASE',
            title: 'Your seats',
            description_md:
              'You have **{{base_quota}}** seats for this concert. Claim them by {{base_claim_deadline}}.',
            add_label: 'Add a seat',
            guest_fields: guestFields(),
          },
          {
            id: 'extra_seats',
            type: 'GUESTS_EXTRA',
            title: 'Extra seats',
            description_md:
              'Need more than your allocation? Ask here — requests are reviewed after the deadline, in the order they arrive.',
            add_label: 'Request another seat',
            guest_fields: guestFields(),
          },
        ],
      };

    case 'PUBLIC':
      return {
        kind,
        blocks: [
          {
            id: 'registrant',
            type: 'REGISTRANT',
            title: 'Your details',
            description_md: 'Your own seat is included — there is no need to add yourself below.',
            // The public registrant is always seat #1 (decision 36).
            creates_seat: true,
            fields: registrantFields(),
          },
          {
            id: 'party',
            type: 'GUESTS_PARTY',
            title: 'Who else is coming?',
            description_md: 'You may bring up to **{{max_additional_guests}}** guests.',
            add_label: 'Add a guest',
            guest_fields: guestFields(),
          },
        ],
      };

    case 'FEEDBACK':
      /**
       * No registrant block and no seat blocks (§13.5). The attendee is resolved
       * from their own `qr_token` before the form is drawn, so the only thing to
       * start with is somewhere to put the questions.
       */
      return {
        kind,
        blocks: [
          {
            id: 'feedback',
            type: 'CUSTOM',
            title: 'How was your evening?',
            fields: [],
          },
        ],
      };
  }
}
