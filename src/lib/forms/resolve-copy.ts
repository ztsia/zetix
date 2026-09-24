import 'server-only';
import { resolveSetting } from '@/db/settings';
import { formatDate } from '@/lib/portal/format';
import { COPY_TOKENS, type CopyValues } from './copy';

/**
 * Resolving a form's copy tokens through the four-level cascade
 * (spec/README.md §2.2).
 *
 * **Never a raw column.** `show_segments.base_quota` being null does not mean
 * the segment offers nothing; it means the segment does not override and the
 * answer is further up. Reading the column would print a blank on a form whose
 * quota is set perfectly well at concert level.
 *
 * One token is derived rather than resolved, and it is the interesting one.
 */

export type CopyContext = {
  segmentId?: number | null;
  showId?: number | null;
  concertId?: number | null;
  /**
   * `concert.timezone`, for `{{base_claim_deadline}}`.
   *
   * Passed in rather than resolved here because the caller has already loaded
   * the concert to find the form. A null zone drops the date rather than
   * printing one that might be hours wrong — the same rule the portal follows
   * (`src/lib/portal/format.ts`), and for the same reason: a confidently wrong
   * deadline is worse than an absent one.
   */
  timeZone?: string | null;
};

/**
 * The setting each token reads. `max_additional_guests` is absent on purpose —
 * see below.
 */
const DIRECT_TOKENS = {
  base_quota: 'allocation.base_quota',
  base_claim_deadline: 'allocation.base_claim_deadline',
  max_tickets_per_response: 'form.max_tickets_per_response',
  extra_rows_max: 'form.extra_rows_max',
} as const satisfies Record<string, string>;

/**
 * Every token's value for one form, ready to substitute.
 *
 * A token whose setting resolves to nothing is **left out of the map** rather
 * than given a number. `interpolateCopy` then renders its placeholder, which is
 * what §2.1 asks for: a missing operational value is a state to report, never a
 * silent fallback.
 */
export async function resolveFormCopy(ctx: CopyContext): Promise<CopyValues> {
  const settingCtx = {
    segmentId: ctx.segmentId ?? null,
    showId: ctx.showId ?? null,
    concertId: ctx.concertId ?? null,
  };

  const entries = await Promise.all(
    Object.entries(DIRECT_TOKENS).map(
      async ([token, key]) => [token, await resolveSetting(key, settingCtx)] as const,
    ),
  );
  const raw = Object.fromEntries(entries);

  const values: Record<string, string> = {};

  for (const [token, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (token === 'base_claim_deadline') {
      const formatted = formatDeadline(value, ctx.timeZone ?? null);
      if (formatted) values[token] = formatted;
      continue;
    }
    values[token] = String(value);
  }

  /**
   * **`{{max_additional_guests}}` is `form.max_tickets_per_response` minus one,
   * and it exists precisely so nobody stores the other number.**
   *
   * The cap is *total party size*, registrant included — `domain.md` §6 has
   * always defined it that way and decision 36 kept it that way. The public
   * repeater renders `cap − 1` rows because the registrant is seat #1, so the
   * form's own copy has to say `cap − 1` too or it contradicts the rows below
   * it.
   *
   * Deriving it here is what stops a second, "friendlier" setting appearing.
   * The rejected alternative was configuring the number of *additional* guests
   * directly, which reads better in the admin UI and is wrong everywhere else:
   * party size would become `cap + 1` on the capacity screens, in the import
   * validator and in the door's party view, and one of those readings would
   * eventually be the wrong one at 9pm on a concert night.
   */
  const cap = raw.max_tickets_per_response;
  if (typeof cap === 'number' && Number.isFinite(cap)) {
    values.max_additional_guests = String(Math.max(0, Math.trunc(cap) - 1));
  }

  return values;
}

/**
 * The deadline as a reader sees it — `Sat 19 Sep 2026`, in the concert's zone.
 *
 * Date only, not date and time. A claim deadline is read as "the day I have to
 * do this by", and printing `23:59` next to it invites a 23:50 submission
 * against a clock the reader's phone disagrees with by a minute.
 */
function formatDeadline(value: unknown, timeZone: string | null): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return formatDate(at, timeZone);
}

/** The tokens a form may use, for `L`'s builder help text. */
export { COPY_TOKENS };
