/**
 * The locked system fields, per block type (spec/v2.md §8.2, decision 35).
 *
 * **This table is the whole mapping model.** There is no screen anywhere in V2
 * that asks *"which field means the email address?"* — a block's destination is
 * chosen when the block is created, and these rows are what make that
 * unfalsifiable. `schema.ts` refuses any form JSON that alters or omits one, so
 * the guarantee is enforced at the boundary rather than hoped for at render
 * time.
 *
 * It is decision 33's reasoning moved one stage earlier: a wide→long mapper was
 * cut from module `C` because getting it wrong under-issues one ticket per party
 * and nobody finds out until someone is at a door with nothing. A free-form
 * builder plus a mapping step rebuilds that machine inside the editor.
 *
 * The admin may edit a system field's **label, help text and placeholder**. Not
 * its `key`, not its `type`, not `required`.
 */

import type { FieldType } from './field-types';

export type SystemFieldSpec = {
  /** Immutable. The column, not a name an admin chose. */
  key: string;
  /** Immutable. */
  type: FieldType;
  /** Immutable — an admin can neither relax nor tighten it. */
  required: boolean;
  /**
   * Whether the admin may delete the row entirely.
   *
   * `contact_phone` and the guest `email` are the only two: a form may
   * legitimately not ask for either (§8.2). Everything else is structural — a
   * response with no email cannot be ticketed, and a seat with no name cannot be
   * found at the door (§8.1.3).
   */
  removable: boolean;
  /** The label a freshly built block starts with. The admin may change it. */
  defaultLabel: string;
};

/**
 * `REGISTRANT` — the flat "your details" block.
 *
 * On a public form this block also produces attendee #1, which is what
 * `creates_seat` carries (§8.1.2, decision 36). The fields are the same either
 * way; only the destination differs, and that is the block's flag rather than a
 * per-field mapping.
 */
export const REGISTRANT_SYSTEM_FIELDS: readonly SystemFieldSpec[] = [
  { key: 'contact_name', type: 'text', required: true, removable: false, defaultLabel: 'Full name' },
  { key: 'contact_email', type: 'email', required: true, removable: false, defaultLabel: 'Email' },
  { key: 'contact_phone', type: 'tel', required: false, removable: true, defaultLabel: 'Phone' },
] as const;

/**
 * Every repeater — `GUESTS_BASE`, `GUESTS_EXTRA`, `GUESTS_PARTY` — carries the
 * same two per-seat system fields.
 *
 * `full_name` is required and not removable: native forms require a name per
 * seat, deliberately narrower than the database allows. `name_source =
 * PLACEHOLDER` exists for **imported** rows, where the names genuinely do not
 * exist (§8.1.3, §8.2.1). A form we control has no such excuse.
 *
 * The guest `email` is optional and removable. A guest without one never
 * receives their own ticket; their PDF rides on the registrant's email for
 * forwarding, which is decision 1 and is the reason the player, not the guest,
 * fills the form.
 */
export const GUEST_SYSTEM_FIELDS: readonly SystemFieldSpec[] = [
  { key: 'full_name', type: 'text', required: true, removable: false, defaultLabel: 'Guest name' },
  { key: 'email', type: 'email', required: false, removable: true, defaultLabel: 'Email (optional)' },
] as const;

/**
 * Every key any system field may ever use.
 *
 * A **custom** field is refused this set of keys even in a block where no system
 * field of that name appears (`schema.ts`). Custom answers land in
 * `registrations.custom` and `attendees.custom` (§8.2.3), so a custom field
 * keyed `contact_email` would sit in the queryable copy under a name that reads
 * exactly like the column it is not — and an export or an admin filter would
 * eventually treat it as one.
 */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set([
  ...REGISTRANT_SYSTEM_FIELDS.map((f) => f.key),
  ...GUEST_SYSTEM_FIELDS.map((f) => f.key),
]);

/** The system catalogue governing a block, or `[]` for `CUSTOM`, which has none. */
export function systemFieldsFor(blockType: string): readonly SystemFieldSpec[] {
  if (blockType === 'REGISTRANT') return REGISTRANT_SYSTEM_FIELDS;
  if (blockType === 'GUESTS_BASE' || blockType === 'GUESTS_EXTRA' || blockType === 'GUESTS_PARTY') {
    return GUEST_SYSTEM_FIELDS;
  }
  return [];
}
