import 'server-only';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { segmentPool, type SegmentPool } from '@/db/allocation';
import { resolveWithOrigin, type ResolvedSetting } from '@/db/cascade-origin';
import { concerts } from '@/db/schema/concerts';
import { shows, showSegments } from '@/db/schema/shows';

/**
 * Everything the shows screen renders (spec/admin.md §14.1, spec/domain.md §5.1).
 *
 * Two things are deliberately kept apart here, and the screen shows both:
 *
 * - **The raw column** — what this level overrides. Null means "not set here",
 *   never zero. It is what a form field is bound to.
 * - **The resolved value and its origin** — what the allocation engine will
 *   actually read, and which of the four levels supplied it
 *   (spec/README.md §2.2).
 *
 * Conflating them is the mistake this file exists to prevent: a capacity input
 * pre-filled with an inherited number invites an admin to "confirm" it and
 * silently pin a value at the wrong level.
 */

/** Cascading keys that live on a segment (spec/domain.md §6). */
export const SEGMENT_KEYS = [
  'segment.capacity',
  'allocation.base_quota',
  'allocation.base_claim_deadline',
  'allocation.extras_policy',
  'allocation.allow_partial_grant',
  'form.max_tickets_per_response',
] as const;

/** Cascading keys that live on a show. The hall, and the door. */
export const SHOW_KEYS = ['capacity', 'portal.unlock_mode'] as const;

export type SegmentView = {
  id: number;
  showId: number;
  name: string;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  displayOrder: number;
  /** The columns themselves. Null is an absent override, not a zero. */
  raw: {
    capacity: number | null;
    baseQuota: number | null;
    baseClaimDeadline: Date | null;
    extrasPolicy: 'REVIEW' | 'AUTO_FCFS' | null;
    allowPartialGrant: boolean | null;
    maxTicketsPerResponse: number | null;
  };
  resolved: Record<string, ResolvedSetting>;
  /**
   * Live counts from the engine — never recomputed here (spec/allocation.md §7.2).
   *
   * **Null until the segment has a capacity at some level.** `segment_pool()`
   * raises rather than guessing, because every figure it returns is derived from
   * `sellable` and an invented one would be a wrong number wearing the engine's
   * authority. That is right, and it means a freshly added segment has no pool —
   * which is the normal starting state on this screen, not an error. Callers
   * render "no capacity set" and offer the form.
   */
  pool: SegmentPool | null;
};

export type ShowView = {
  id: number;
  concertId: number;
  name: string;
  startsAt: Date | null;
  doorsOpenAt: Date | null;
  venueName: string | null;
  venueAddress: string | null;
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'COMPLETED';
  raw: { capacity: number | null; portalUnlockMode: string | null };
  resolved: Record<string, ResolvedSetting>;
  segments: SegmentView[];
  /** Σ resolved segment capacity. */
  allocated: number;
  /**
   * Seats in no segment (decision 21, spec/domain.md §5.1).
   *
   * There is no `held_seats` column and no soft threshold: if the hall is 400
   * and the segments total 390, ten seats are held. Null when the hall itself is
   * unset, because "held" is meaningless without a total — and rendering 0 there
   * would read as "none held" rather than "nobody has said how big the room is".
   */
  held: number | null;
};

export type ConcertHeader = {
  id: number;
  name: string;
  /** Every show time renders in this zone, never the viewer's (§6.1). */
  timezone: string | null;
};

export async function getConcertHeader(concertId: number): Promise<ConcertHeader | null> {
  const [row] = await getDb()
    .select({ id: concerts.id, name: concerts.name, timezone: concerts.timezone })
    .from(concerts)
    .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)));
  return row ?? null;
}

/**
 * The concert's shows, each with its segments, resolved settings and pools.
 *
 * The per-scope resolutions are separate round trips — one per show and one per
 * segment. A concert holds a handful of shows and at most two segments each
 * (`unique (show_id, audience_mode)`), so this is a few queries for a
 * configuration screen, not a loop over an unbounded table. If a concert ever
 * grows enough shows for that to matter, batch by scope rather than by key.
 */
export async function getShowsForConcert(concertId: number): Promise<ShowView[]> {
  const db = getDb();

  const showRows = await db
    .select({
      id: shows.id,
      concertId: shows.concertId,
      name: shows.name,
      startsAt: shows.startsAt,
      doorsOpenAt: shows.doorsOpenAt,
      venueName: shows.venueName,
      venueAddress: shows.venueAddress,
      capacity: shows.capacity,
      portalUnlockMode: shows.portalUnlockMode,
      status: shows.status,
    })
    .from(shows)
    .where(and(eq(shows.concertId, concertId), isNull(shows.deletedAt)))
    // Undated shows last: a show with no time is one still being set up, and it
    // belongs at the bottom rather than sorting to the top as a null.
    .orderBy(asc(shows.startsAt), asc(shows.name));

  const segmentRows = await db
    .select({
      id: showSegments.id,
      showId: showSegments.showId,
      name: showSegments.name,
      audienceMode: showSegments.audienceMode,
      displayOrder: showSegments.displayOrder,
      capacity: showSegments.capacity,
      baseQuota: showSegments.baseQuota,
      baseClaimDeadline: showSegments.baseClaimDeadline,
      extrasPolicy: showSegments.extrasPolicy,
      allowPartialGrant: showSegments.allowPartialGrant,
      maxTicketsPerResponse: showSegments.maxTicketsPerResponse,
    })
    .from(showSegments)
    .innerJoin(shows, eq(shows.id, showSegments.showId))
    .where(
      and(
        eq(shows.concertId, concertId),
        isNull(shows.deletedAt),
        isNull(showSegments.deletedAt),
      ),
    )
    .orderBy(asc(showSegments.displayOrder), asc(showSegments.id));

  const views: ShowView[] = [];

  for (const show of showRows) {
    const mine = segmentRows.filter((segment) => segment.showId === show.id);

    const segments: SegmentView[] = await Promise.all(
      mine.map(async (segment) => {
        const resolved = await resolveWithOrigin([...SEGMENT_KEYS], {
          segmentId: segment.id,
          showId: show.id,
          concertId,
        });

        // Ask for a pool only once a capacity exists somewhere in the cascade.
        // Calling it regardless and catching the failure would also swallow the
        // errors worth seeing, and this screen's job is to be usable while the
        // configuration is still incomplete.
        const sellable = asNumber(resolved['segment.capacity']?.value);

        return {
          id: segment.id,
          showId: segment.showId,
          name: segment.name,
          audienceMode: segment.audienceMode,
          displayOrder: segment.displayOrder,
          raw: {
            capacity: segment.capacity,
            baseQuota: segment.baseQuota,
            baseClaimDeadline: segment.baseClaimDeadline,
            extrasPolicy: segment.extrasPolicy,
            allowPartialGrant: segment.allowPartialGrant,
            maxTicketsPerResponse: segment.maxTicketsPerResponse,
          },
          resolved,
          pool: sellable === null ? null : await segmentPool(segment.id),
        };
      }),
    );

    const resolved = await resolveWithOrigin([...SHOW_KEYS], { showId: show.id, concertId });
    const hall = asNumber(resolved['capacity']?.value);
    // A segment with no capacity yet allocates nothing, so its seats still read
    // as held. That is the honest arithmetic: nobody has claimed them.
    const allocated = segments.reduce(
      (total, segment) => total + (segment.pool?.sellable ?? 0),
      0,
    );

    views.push({
      id: show.id,
      concertId: show.concertId,
      name: show.name,
      startsAt: show.startsAt,
      doorsOpenAt: show.doorsOpenAt,
      venueName: show.venueName,
      venueAddress: show.venueAddress,
      status: show.status,
      raw: { capacity: show.capacity, portalUnlockMode: show.portalUnlockMode },
      resolved,
      segments,
      allocated,
      held: hall === null ? null : hall - allocated,
    });
  }

  return views;
}

/** jsonb arrives parsed, so a number may come back as a string on some drivers. */
function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
