/**
 * Why this screen shows the party cap and never edits it (decision 43).
 *
 * `K` finished its branch with one question left open and handed it here,
 * because `L` owns the screen that would edit the column: `registration_forms`
 * carries `max_tickets_per_response`, nothing reads it, and setting it to 2
 * against a segment value of 4 still renders three guest rows. Two ways out
 * were on the table — add a form level to the cascade, or let the segment own
 * the cap — and the spec had already answered.
 *
 * **`form.max_tickets_per_response` is a segment value** (`spec/domain.md` §6),
 * and `spec/README.md` §2.2 is explicit: *"Never read a raw column for a
 * cascading value; always resolve."* The cascade is segment → show → concert →
 * system, with the segment authoritative. A form level would be a fifth, below
 * the level the spec calls authoritative, in a document that states four in
 * three places.
 *
 * The case for adding one is the multi-round path: a second round is a new form
 * on the same segment (`domain.md` §5.1), so two rounds cannot differ in their
 * cap without one. It does not survive contact with what a round actually is.
 * Rounds do not overlap — round 1 is `CLOSED` before round 2 opens — and caps
 * resolve live rather than being pinned, so changing the segment's value
 * between rounds is both possible and free. A closed form renders nothing for
 * the old value to be wrong for.
 *
 * What it would cost is not free: a fifth level in `resolve_setting()`, which
 * is a migration on a frozen schema, plus the wording of §2.2, §6 and every
 * screen that explains the cascade — to express a difference the existing
 * levels already express.
 *
 * So: **the segment owns the cap, the column is vestigial, and this screen
 * resolves.** The editor shows the resolved figure read-only with its origin
 * and links to the segment that sets it. It is never an input here, because an
 * input that writes a column nothing reads is worse than no input at all — the
 * admin would have configured something, and nothing would happen.
 *
 * Dropping the column is a schema change and therefore not this branch's
 * (`modules-v2.md` §4): it is written up for a small follow-up PR in this
 * branch's handoff. Until then {@link vestigialCapWarning} makes any value
 * someone already wrote visible, rather than leaving it silently inert.
 */

import type { ResolvedSetting } from '@/db/cascade-origin';

export const PARTY_CAP_KEY = 'form.max_tickets_per_response';

/**
 * The sentence to show when a form row carries a `max_tickets_per_response`
 * that nothing will read.
 *
 * Null when the column is null, which is every form this module creates — it
 * never writes the column. This exists for rows created by hand, by a fixture,
 * or by a future session that reaches for the obvious field.
 */
export function vestigialCapWarning(
  raw: number | null,
  resolved: ResolvedSetting | undefined,
): string | null {
  if (raw === null) return null;

  const effective = resolved?.value;
  const effectiveText =
    effective === null || effective === undefined
      ? 'nothing is set at any level, so the form cannot offer seats at all'
      : `the segment resolves to ${String(effective)}`;

  return `This form row stores a party cap of ${raw}, and nothing reads it — ${effectiveText}. The cap is a segment value (spec/domain.md §6) and is set on the segment, not here.`;
}
