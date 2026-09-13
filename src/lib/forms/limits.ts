import 'server-only';
import { resolveSetting } from '@/db/settings';
import { isRepeaterType, type FormSchema, type RepeaterBlockType } from './schema';

/**
 * How many rows each repeater may hold (spec/v2.md §8.3).
 *
 * **Each repeater has exactly one governing key and they do not overlap:**
 *
 * | Repeater | Governing key |
 * |---|---|
 * | `GUESTS_BASE` | `allocation.base_quota`, **minus seats already claimed** |
 * | `GUESTS_EXTRA` | `form.extra_rows_max` |
 * | `GUESTS_PARTY` | `form.max_tickets_per_response` **− 1** |
 *
 * Every one resolves through the cascade, never off a column
 * (spec/README.md §2.2).
 *
 * **A cap that resolves to nothing is not zero and not a default — it stops the
 * surface.** `segment_pool()` refuses to return figures until this concert is
 * configured, and allocation, import and the blast all stop rather than guess
 * (`CLAUDE.md`). A form is the same boundary: rendering "add up to 0 guests" to
 * a stranger because nobody has entered the party cap yet is a worse failure
 * than saying the form is not open.
 */

export type RepeaterLimits = Readonly<Record<string, number>>;

export type LimitsResult =
  | { ok: true; limits: RepeaterLimits }
  | {
      ok: false;
      /** The setting keys nobody has entered, for the admin-facing message. */
      missing: string[];
    };

export type LimitsContext = {
  segmentId?: number | null;
  showId?: number | null;
  concertId?: number | null;
  /**
   * Base seats this registrant already holds, for `GUESTS_BASE`.
   *
   * **"Remaining", not "quota"** (§8.1.1). A player returning for round 2, or
   * editing a round 1 response, must see the seats they have left — rendering
   * `base_quota` rows unconditionally would offer seats that are already theirs
   * and double-count them against `unclaimed_base`.
   *
   * Counted by the caller rather than here: this module may not touch
   * allocation (`docs/modules-v2.md` §3, `K`), and the count belongs to the same
   * read that resolved the player. `M` supplies it; `L`'s preview passes zero,
   * which is the right answer for a form nobody has filled in.
   */
  baseAlreadyClaimed?: number;
};

const GOVERNING_KEY: Record<RepeaterBlockType, string> = {
  GUESTS_BASE: 'allocation.base_quota',
  GUESTS_EXTRA: 'form.extra_rows_max',
  GUESTS_PARTY: 'form.max_tickets_per_response',
};

export async function resolveRepeaterLimits(
  schema: FormSchema,
  ctx: LimitsContext,
): Promise<LimitsResult> {
  const settingCtx = {
    segmentId: ctx.segmentId ?? null,
    showId: ctx.showId ?? null,
    concertId: ctx.concertId ?? null,
  };

  const repeaters = schema.blocks.filter((block) => isRepeaterType(block.type));
  const limits: Record<string, number> = {};
  const missing: string[] = [];

  await Promise.all(
    repeaters.map(async (block) => {
      const type = block.type as RepeaterBlockType;
      const key = GOVERNING_KEY[type];
      const raw = await resolveSetting<number>(key, settingCtx);

      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        if (!missing.includes(key)) missing.push(key);
        return;
      }

      limits[block.id] = rowsFor(type, Math.trunc(raw), ctx.baseAlreadyClaimed ?? 0);
    }),
  );

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, limits };
}

/**
 * The one place the three arithmetics live.
 *
 * `GUESTS_PARTY` subtracts the registrant, because the cap is total party size
 * and the public registrant is seat #1 (decision 36). `GUESTS_BASE` subtracts
 * what the player already holds. Both clamp at zero rather than going negative:
 * a player who somehow holds more than their quota — an admin grant, a lowered
 * quota — sees a block they cannot add to, not a crash.
 */
function rowsFor(type: RepeaterBlockType, resolved: number, alreadyClaimed: number): number {
  switch (type) {
    case 'GUESTS_BASE':
      return Math.max(0, resolved - alreadyClaimed);
    case 'GUESTS_PARTY':
      return Math.max(0, resolved - 1);
    case 'GUESTS_EXTRA':
      return Math.max(0, resolved);
  }
}
