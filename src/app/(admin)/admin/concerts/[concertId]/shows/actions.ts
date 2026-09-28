'use server';

import { revalidatePath } from 'next/cache';
import { TZDate } from '@date-fns/tz';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { concerts } from '@/db/schema/concerts';
import { shows, showSegments } from '@/db/schema/shows';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import { FEEDBACK_TEMPLATE_KEY, queueFeedbackBlast } from '@/lib/email/feedback-blast';
import type { FormState } from '../../form-state';

/**
 * Shows and segments (spec/domain.md §5.1, spec/allocation.md §7.7,
 * spec/admin.md §14.1).
 *
 * Three things shape every action in this file.
 *
 * **The show owns the hall; the segment owns the audience.** `audience_mode`
 * lives on `show_segments` and never on `shows`, because one hall on one night
 * holds a public block and a player-invited block at the same time — for this
 * concert it does (decision 5).
 *
 * **The guards are in Postgres, and they are deferred.** The entitlement guard
 * (§7.4) and the hall arithmetic are `deferrable initially deferred` constraint
 * triggers that fire at `COMMIT`, not per statement. Nothing here re-implements
 * them; these actions surface the sentence the database raises, and the capacity
 * move below is one transaction precisely because the guard judges the result
 * rather than the keystrokes.
 *
 * **No operational value is written by code.** Every capacity, quota, deadline
 * and cap on these forms is typed by an admin, and a blank field clears the
 * override rather than defaulting to anything (CLAUDE.md, spec/domain.md §6).
 */

/**
 * An empty field, as null.
 *
 * Trimmed *before* coercion, and that ordering is the point: `Number(' ')` is
 * `0`, so a capacity field holding a space would otherwise save a hall of zero
 * seats rather than clearing the override. Blank means "no override at this
 * level" — null, never zero (spec/domain.md §6).
 */
const blankToNull = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  return trimmed === '' || trimmed === undefined ? null : trimmed;
};

const optionalInt = z.preprocess(blankToNull, z.coerce.number().int().nullable());

/** A count of seats. Negative capacity is not a thing a hall can have. */
const optionalCount = z.preprocess(
  blankToNull,
  z.coerce.number().int().min(0, 'That cannot be negative.').nullable(),
);

const optionalText = z.preprocess(blankToNull, z.string().trim().max(500).nullable());

/** `datetime-local` posts `YYYY-MM-DDTHH:mm`, with no zone of its own. */
const localDateTime = z.preprocess(
  blankToNull,
  z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
      'Use the date and time picker.',
    )
    .nullable(),
);

/**
 * A wall-clock time in the concert's zone, as the instant it names.
 *
 * The admin types "19:30 on 19 Sep" meaning half past seven **at the venue**.
 * Storing that as UTC requires the concert's zone, so a show cannot take a time
 * before its concert has one — which is why the create form refuses rather than
 * guessing (spec/domain.md §6.1).
 */
function toInstant(local: string | null, timeZone: string): Date | null {
  if (!local) return null;
  const [datePart, timePart] = local.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  // `TZDate.tz` reads its arguments as wall-clock in that zone; month is
  // 0-based, as in `Date`.
  const zoned = TZDate.tz(timeZone, year, month - 1, day, hour, minute);
  return new Date(zoned.getTime());
}

const showSchema = z.object({
  name: z.string().trim().min(1, 'A show needs a name.').max(200),
  startsAt: localDateTime,
  /**
   * What "the show is over" is measured from (spec/v2.md §13.2.1, decision 41).
   *
   * **Optional, and inert when blank.** With no end time there is no post-show
   * phase and no auto-completion, and an admin marks the show `COMPLETED` by
   * hand as before. Nothing is inferred from `startsAt`: a concert with an
   * interval runs well past its nominal length, and a portal that flipped to
   * "how was your evening?" mid-performance would be worse than one that waited
   * for a human.
   */
  endsAt: localDateTime,
  doorsOpenAt: localDateTime,
  venueName: optionalText,
  venueAddress: optionalText,
  capacity: optionalCount,
  status: z.enum(['DRAFT', 'OPEN', 'CLOSED', 'COMPLETED']),
  portalUnlockMode: z.enum(['ON_ADMISSION', 'OPEN_TO_ALL', 'CLOSED', '']),
});

function readShowForm(formData: FormData) {
  return showSchema.safeParse({
    name: formData.get('name') ?? '',
    startsAt: formData.get('startsAt') ?? '',
    endsAt: formData.get('endsAt') ?? '',
    doorsOpenAt: formData.get('doorsOpenAt') ?? '',
    venueName: formData.get('venueName') ?? '',
    venueAddress: formData.get('venueAddress') ?? '',
    capacity: formData.get('capacity') ?? '',
    status: formData.get('status') ?? 'DRAFT',
    portalUnlockMode: formData.get('portalUnlockMode') ?? '',
  });
}

/** The concert's zone, which every time on these forms is interpreted in. */
async function concertZone(concertId: number): Promise<string | null> {
  const [row] = await getDb()
    .select({ timezone: concerts.timezone })
    .from(concerts)
    .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)));
  return row?.timezone ?? null;
}

const NO_ZONE =
  'This concert has no timezone, so a show time cannot be stored. ' +
  'Set the timezone on the concert first — times are kept in UTC and shown at the venue’s clock.';

export async function createShowAction(
  concertId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = readShowForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const zone = await concertZone(concertId);
  if (!zone && (parsed.data.startsAt || parsed.data.endsAt || parsed.data.doorsOpenAt)) {
    return { error: NO_ZONE };
  }

  try {
    const [created] = await getDb()
      .insert(shows)
      .values({
        concertId,
        name: parsed.data.name,
        startsAt: toInstant(parsed.data.startsAt, zone ?? 'UTC'),
        endsAt: toInstant(parsed.data.endsAt, zone ?? 'UTC'),
        doorsOpenAt: toInstant(parsed.data.doorsOpenAt, zone ?? 'UTC'),
        venueName: parsed.data.venueName,
        venueAddress: parsed.data.venueAddress,
        capacity: parsed.data.capacity,
        status: parsed.data.status,
        portalUnlockMode: parsed.data.portalUnlockMode || null,
      })
      .returning({ id: shows.id, name: shows.name });

    await writeAuditLog({
      action: 'show.created',
      entityType: 'show',
      entityId: created.id,
      after: { name: created.name, capacity: parsed.data.capacity },
    });

    revalidatePath(`/admin/concerts/${concertId}/shows`);
    return { error: null, message: `Created ${created.name}.` };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

export async function updateShowAction(
  concertId: number,
  showId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = readShowForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const zone = await concertZone(concertId);
  if (!zone && (parsed.data.startsAt || parsed.data.endsAt || parsed.data.doorsOpenAt)) {
    return { error: NO_ZONE };
  }

  try {
    const db = getDb();
    const [before] = await db
      .select({ name: shows.name, capacity: shows.capacity, status: shows.status })
      .from(shows)
      .where(and(eq(shows.id, showId), eq(shows.concertId, concertId), isNull(shows.deletedAt)));
    if (!before) return { error: 'That show no longer exists.' };

    await db
      .update(shows)
      .set({
        name: parsed.data.name,
        startsAt: toInstant(parsed.data.startsAt, zone ?? 'UTC'),
        endsAt: toInstant(parsed.data.endsAt, zone ?? 'UTC'),
        doorsOpenAt: toInstant(parsed.data.doorsOpenAt, zone ?? 'UTC'),
        venueName: parsed.data.venueName,
        venueAddress: parsed.data.venueAddress,
        capacity: parsed.data.capacity,
        status: parsed.data.status,
        portalUnlockMode: parsed.data.portalUnlockMode || null,
        updatedAt: new Date(),
      })
      .where(eq(shows.id, showId));

    await writeAuditLog({
      action: 'show.updated',
      entityType: 'show',
      entityId: showId,
      before: { name: before.name, capacity: before.capacity, status: before.status },
      after: {
        name: parsed.data.name,
        capacity: parsed.data.capacity,
        status: parsed.data.status,
      },
    });

    /**
     * **Completing a show by hand queues its feedback email**, exactly as the
     * daily sweep does (spec/v2.md §13.5.2). The status dialog is decision 42's
     * manual twin for auto-completion, and a twin that skipped the queueing
     * would mean an admin who completed a show on the night got no email at all
     * until the cron came round and found the show already `COMPLETED` — which
     * it skips, because it only ever moves `OPEN` → `COMPLETED`.
     *
     * Only on the transition. Re-saving an already-`COMPLETED` show is an edit
     * to its name or venue, not a second blast.
     *
     * **A queueing failure does not fail the save.** The status change is what
     * the admin asked for and it has committed; the message says what happened
     * to the email, and **Generate feedback emails** re-runs it once the
     * configuration it needs is there.
     */
    let note = '';
    if (parsed.data.status === 'COMPLETED' && before.status !== 'COMPLETED') {
      try {
        const { queued } = await queueFeedbackBlast({ showId });
        note =
          queued > 0
            ? ` ${queued} feedback email${queued === 1 ? '' : 's'} queued.`
            : ' No feedback email queued — nobody was admitted, or they already have one.';
      } catch (error) {
        note = ` The show is complete, but its feedback email could not be queued: ${
          error instanceof Error ? error.message : 'unknown error'
        }`;
      }
    }

    revalidatePath(`/admin/concerts/${concertId}/shows`);
    return { error: null, message: `Saved ${parsed.data.name}.${note}` };
  } catch (error) {
    // Lowering the hall below what its segments hold, or below confirmed seats,
    // is refused by `shows_capacity_guard` with a sentence naming the numbers.
    return { error: dbErrorMessage(error) };
  }
}

const segmentSchema = z.object({
  name: z.string().trim().min(1, 'A segment needs a name.').max(200),
  audienceMode: z.enum(['PLAYER_INVITED', 'PUBLIC']),
  capacity: optionalCount,
  baseQuota: optionalCount,
  baseClaimDeadline: localDateTime,
  extrasPolicy: z.enum(['REVIEW', 'AUTO_FCFS', '']),
  allowPartialGrant: z.enum(['true', 'false', '']),
  autoApproveClean: z.enum(['true', 'false', '']),
  maxTicketsPerResponse: optionalCount,
  displayOrder: optionalInt,
});

function readSegmentForm(formData: FormData) {
  return segmentSchema.safeParse({
    name: formData.get('name') ?? '',
    audienceMode: formData.get('audienceMode') ?? 'PUBLIC',
    capacity: formData.get('capacity') ?? '',
    baseQuota: formData.get('baseQuota') ?? '',
    baseClaimDeadline: formData.get('baseClaimDeadline') ?? '',
    extrasPolicy: formData.get('extrasPolicy') ?? '',
    allowPartialGrant: formData.get('allowPartialGrant') ?? '',
    autoApproveClean: formData.get('autoApproveClean') ?? '',
    maxTicketsPerResponse: formData.get('maxTicketsPerResponse') ?? '',
    displayOrder: formData.get('displayOrder') ?? '',
  });
}

/** A tri-state checkbox: on, off, or "inherit from the level above". */
function triState(value: 'true' | 'false' | ''): boolean | null {
  return value === '' ? null : value === 'true';
}

/**
 * Base quota belongs to a player-invited segment and nowhere else.
 *
 * The guard already ignores it on a public segment, so storing one there is not
 * a correctness bug — it is a lie on the screen, a number that reads as a
 * promise and entitles nobody.
 */
const QUOTA_ON_PUBLIC =
  'A base quota only means something in a player-invited segment — a public segment ' +
  'has no players to promise seats to. Clear it, or change the audience.';

export async function createSegmentAction(
  concertId: number,
  showId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = readSegmentForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  if (parsed.data.audienceMode === 'PUBLIC' && parsed.data.baseQuota !== null) {
    return { error: QUOTA_ON_PUBLIC };
  }

  const zone = await concertZone(concertId);
  if (!zone && parsed.data.baseClaimDeadline) return { error: NO_ZONE };

  try {
    const [owner] = await getDb()
      .select({ id: shows.id })
      .from(shows)
      .where(
        and(eq(shows.id, showId), eq(shows.concertId, concertId), isNull(shows.deletedAt)),
      );
    if (!owner) return { error: 'That show is not part of this concert.' };

    const [created] = await getDb()
      .insert(showSegments)
      .values({
        showId,
        name: parsed.data.name,
        audienceMode: parsed.data.audienceMode,
        capacity: parsed.data.capacity,
        baseQuota: parsed.data.baseQuota,
        baseClaimDeadline: toInstant(parsed.data.baseClaimDeadline, zone ?? 'UTC'),
        extrasPolicy: parsed.data.extrasPolicy || null,
        allowPartialGrant: triState(parsed.data.allowPartialGrant),
        autoApproveClean: triState(parsed.data.autoApproveClean),
        maxTicketsPerResponse: parsed.data.maxTicketsPerResponse,
        displayOrder: parsed.data.displayOrder ?? 0,
      })
      .returning({ id: showSegments.id, name: showSegments.name });

    await writeAuditLog({
      action: 'segment.created',
      entityType: 'show_segment',
      entityId: created.id,
      after: {
        showId,
        name: created.name,
        audienceMode: parsed.data.audienceMode,
        capacity: parsed.data.capacity,
        baseQuota: parsed.data.baseQuota,
      },
    });

    revalidatePath(`/admin/concerts/${concertId}/shows`);
    return { error: null, message: `Added ${created.name}.` };
  } catch (error) {
    return { error: friendlySegmentError(error, parsed.data.audienceMode) };
  }
}

export async function updateSegmentAction(
  concertId: number,
  segmentId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = readSegmentForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const zone = await concertZone(concertId);
  if (!zone && parsed.data.baseClaimDeadline) return { error: NO_ZONE };

  try {
    const db = getDb();
    // Joined to `shows` and scoped to the concert in the URL. There is one
    // shared ADMIN with access to every concert (decision 19), so this is not
    // an authorization boundary — it stops a stale tab or a hand-edited id
    // editing a segment that belongs to a different concert entirely, which
    // would be attributed to this one in the audit log.
    const [before] = await db
      .select({
        name: showSegments.name,
        capacity: showSegments.capacity,
        baseQuota: showSegments.baseQuota,
        audienceMode: showSegments.audienceMode,
      })
      .from(showSegments)
      .innerJoin(shows, eq(shows.id, showSegments.showId))
      .where(
        and(
          eq(showSegments.id, segmentId),
          eq(shows.concertId, concertId),
          isNull(showSegments.deletedAt),
          isNull(shows.deletedAt),
        ),
      );
    if (!before) return { error: 'That segment is not part of this concert.' };

    /**
     * **The audience comes from the database, never from the form.**
     *
     * A segment's `audience_mode` is fixed once it exists — every seat in it was
     * allocated under those rules — so an update has no business accepting one.
     * Reading the stored value closes the hole against *any* POST rather than
     * against the form alone, which is what an immutable field needs.
     *
     * This was a live Blocker, and the shape of it is worth remembering. The
     * form disables the audience select on edit, precisely to express that the
     * value cannot change. A disabled control is not submitted, so
     * `formData.get('audienceMode')` came back null, `readSegmentForm` fell
     * through to its `?? 'PUBLIC'` default, and every edit posted PUBLIC. On a
     * segment with a quota that made capacity, deadline and policy unsaveable;
     * on one without, it silently rewrote a PLAYER_INVITED segment to PUBLIC —
     * and `assert_base_entitlement_fits()` returns early for a non-player
     * segment, so that switched the §7.4 guard off from the ordinary edit form.
     * Decision 17 says the guard has no opt-out toggle; that was one.
     */
    const audienceMode = before.audienceMode;
    if (audienceMode === 'PUBLIC' && parsed.data.baseQuota !== null) {
      return { error: QUOTA_ON_PUBLIC };
    }

    await db
      .update(showSegments)
      .set({
        name: parsed.data.name,
        capacity: parsed.data.capacity,
        baseQuota: parsed.data.baseQuota,
        baseClaimDeadline: toInstant(parsed.data.baseClaimDeadline, zone ?? 'UTC'),
        extrasPolicy: parsed.data.extrasPolicy || null,
        allowPartialGrant: triState(parsed.data.allowPartialGrant),
        autoApproveClean: triState(parsed.data.autoApproveClean),
        maxTicketsPerResponse: parsed.data.maxTicketsPerResponse,
        displayOrder: parsed.data.displayOrder ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(showSegments.id, segmentId));

    await writeAuditLog({
      action: 'segment.updated',
      entityType: 'show_segment',
      entityId: segmentId,
      before,
      after: {
        name: parsed.data.name,
        audienceMode,
        capacity: parsed.data.capacity,
        baseQuota: parsed.data.baseQuota,
      },
    });

    revalidatePath(`/admin/concerts/${concertId}/shows`);
    return { error: null, message: `Saved ${parsed.data.name}.` };
  } catch (error) {
    // Not `friendlySegmentError`: that exists to explain a duplicate audience,
    // which an update can no longer cause now that it never changes one.
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Move capacity between two segments of one show (spec/allocation.md §7.7).
 *
 * **This is one transaction, and that is the whole point.** The worked example
 * moves a player segment to 80 and a public segment to 320. Run as two saves,
 * the first is rejected on its own: after `player 100 → 80` the hall arithmetic
 * and the entitlement guard both judge a state the admin never intended to
 * leave behind. The constraint triggers are `deferrable initially deferred`
 * exactly so a complete move commits and a half-finished one does not — which
 * only helps if the two updates genuinely share a transaction.
 *
 * Segments never borrow automatically (§7.7). This is the explicit admin edit
 * that replaces it, and it is logged.
 */
export async function moveCapacityAction(
  concertId: number,
  showId: number,
  moves: readonly { segmentId: number; capacity: number | null }[],
  reason: string | null,
): Promise<FormState> {
  // Captured, not discarded: the audit row below is written inside the
  // transaction, and `writeAuditLog` resolves the actor with
  // `getSessionUser()` — which issues **its own query** — unless it is given
  // one. `src/db/client.ts` is `max: 1`, so that nested query waits for the
  // single connection the transaction is already holding, and the request
  // deadlocks against itself. Passing `actorId` is what stops it.
  const admin = await requireRole('ADMIN');

  const parsed = z
    .object({
      showId: z.number().int().positive(),
      moves: z
        .array(
          z.object({
            segmentId: z.number().int().positive(),
            capacity: z.number().int().min(0).nullable(),
          }),
        )
        .min(1, 'Nothing to move.'),
      reason: z.string().trim().max(500).nullable(),
    })
    .safeParse({ showId, moves, reason });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Malformed request.' };
  }

  // One segment cannot appear twice: the last write would silently win and the
  // audit row would record a move that did not happen the way it reads.
  const ids = new Set(parsed.data.moves.map((m) => m.segmentId));
  if (ids.size !== parsed.data.moves.length) {
    return { error: 'The same segment appears twice in this move.' };
  }

  try {
    const db = getDb();

    const [owner] = await db
      .select({ id: shows.id })
      .from(shows)
      .where(
        and(eq(shows.id, showId), eq(shows.concertId, concertId), isNull(shows.deletedAt)),
      );
    if (!owner) return { error: 'That show is not part of this concert.' };

    const before = await db
      .select({
        id: showSegments.id,
        name: showSegments.name,
        capacity: showSegments.capacity,
      })
      .from(showSegments)
      .where(and(eq(showSegments.showId, showId), isNull(showSegments.deletedAt)));

    const known = new Set(before.map((segment) => segment.id));
    for (const move of parsed.data.moves) {
      if (!known.has(move.segmentId)) {
        return { error: 'That segment does not belong to this show.' };
      }
    }

    await db.transaction(async (tx) => {
      for (const move of parsed.data.moves) {
        await tx
          .update(showSegments)
          .set({ capacity: move.capacity, updatedAt: new Date() })
          .where(eq(showSegments.id, move.segmentId));
      }

      // Written inside the transaction, so a move the guards reject at COMMIT
      // takes its own audit row down with it. A log that survives the rollback
      // of the thing it describes records a change that never happened.
      await writeAuditLog(
        {
          action: 'segment.capacity_moved',
          entityType: 'show',
          entityId: showId,
          before: before.map((s) => ({ id: s.id, name: s.name, capacity: s.capacity })),
          after: parsed.data.moves,
          reason: parsed.data.reason,
          // Explicit, so the writer does not go looking for the session on a
          // connection this transaction is holding. See the note above.
          actorId: admin.id,
        },
        tx,
      );
    });

    revalidatePath(`/admin/concerts/${concertId}/shows`);
    return { error: null, message: 'Capacity moved.' };
  } catch (error) {
    // The refusal names which segment, and by how much. It is the admin's next
    // instruction, so it is shown rather than replaced.
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Soft-delete a segment.
 *
 * `show_segments_delete_guard` refuses while confirmed seats remain, with a
 * sentence saying how many — deleting it would leave those people holding
 * tickets to nothing.
 */
export async function deleteSegmentAction(
  concertId: number,
  segmentId: number,
): Promise<FormState> {
  await requireRole('ADMIN');

  try {
    const db = getDb();
    const [before] = await db
      .select({ name: showSegments.name, showId: showSegments.showId })
      .from(showSegments)
      .innerJoin(shows, eq(shows.id, showSegments.showId))
      .where(
        and(
          eq(showSegments.id, segmentId),
          eq(shows.concertId, concertId),
          isNull(showSegments.deletedAt),
          isNull(shows.deletedAt),
        ),
      );
    if (!before) return { error: 'That segment is not part of this concert.' };

    await db
      .update(showSegments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(showSegments.id, segmentId));

    await writeAuditLog({
      action: 'segment.deleted',
      entityType: 'show_segment',
      entityId: segmentId,
      before: { name: before.name, showId: before.showId },
    });

    revalidatePath(`/admin/concerts/${concertId}/shows`);
    return { error: null, message: `Removed ${before.name}.` };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

/** Same contract as the segment delete, one level up. */
export async function deleteShowAction(
  concertId: number,
  showId: number,
): Promise<FormState> {
  await requireRole('ADMIN');

  try {
    const db = getDb();
    const [before] = await db
      .select({ name: shows.name })
      .from(shows)
      .where(and(eq(shows.id, showId), eq(shows.concertId, concertId), isNull(shows.deletedAt)));
    if (!before) return { error: 'That show no longer exists.' };

    await db
      .update(shows)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(shows.id, showId));

    await writeAuditLog({
      action: 'show.deleted',
      entityType: 'show',
      entityId: showId,
      before: { name: before.name },
    });

    revalidatePath(`/admin/concerts/${concertId}/shows`);
    return { error: null, message: `Removed ${before.name}.` };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

/**
 * `show_segments_show_audience_key` is a unique index, so its violation arrives
 * as a constraint name rather than a sentence. Every other error here is already
 * written for a person and is passed through untouched.
 */
function friendlySegmentError(error: unknown, mode: 'PLAYER_INVITED' | 'PUBLIC'): string {
  const message = dbErrorMessage(error);
  if (message.includes('show_segments_show_audience_key')) {
    return `This show already has a ${
      mode === 'PUBLIC' ? 'public' : 'player-invited'
    } segment. A show holds at most one of each — edit that one, or move capacity between them.`;
  }
  return message;
}

/**
 * **Generate feedback emails** — decision 42's manual twin for the queueing step
 * (spec/v2.md §13.5.3).
 *
 * Queues without waiting for the cron, and without needing the show to change
 * status: the two reasons to press it are a show already completed whose email
 * failed to queue, and an usher's phone that only drained its scan queue the
 * next morning. The second is why the audience is computed now rather than
 * frozen at completion time (§13.5.1) — this button is what picks those people
 * up.
 *
 * Safe to press repeatedly. `outbox_no_duplicate_pending` stops a second
 * pending row, and `queueFeedbackBlast` skips any registration that already has
 * a `SENT` one, so a re-run reaches only the people a previous run missed.
 */
export async function generateFeedbackEmailsAction(
  concertId: number,
  showId: number,
): Promise<FormState> {
  await requireRole('ADMIN');

  try {
    const { queued, requeued, alreadySent } = await queueFeedbackBlast({ showId });

    revalidatePath(`/admin/concerts/${concertId}/shows`);

    const parts: string[] = [];
    if (queued > 0) {
      parts.push(`${queued} feedback email${queued === 1 ? '' : 's'} queued`);
    }
    /**
     * **Reported separately from `queued`, because it is the run that fixed the
     * late drain.** A party whose message was already waiting gets it rewritten
     * to name the seat that has only just been scanned in (§13.5.1); folding
     * that into the queued count would say "0 queued" on exactly the press that
     * did the thing this button exists for.
     */
    if (requeued > 0) {
      parts.push(
        `${requeued} already waiting updated to include ${requeued === 1 ? 'a guest' : 'guests'} admitted since`,
      );
    }

    if (parts.length > 0) {
      return {
        error: null,
        message: `${parts.join(', ')}. They send at the feedback send hour, or press Send now.`,
      };
    }

    /**
     * Three different nothings, and they are not interchangeable — saying
     * "nobody has been admitted" to an admin whose emails are sitting in the
     * outbox sends them looking for a door problem that does not exist.
     */
    if (alreadySent > 0) {
      return {
        error: null,
        message: `Nothing new to queue — ${alreadySent} ${alreadySent === 1 ? 'party has' : 'parties have'} already been emailed.`,
      };
    }

    const waiting = await pendingFeedbackCount(showId);
    if (waiting > 0) {
      return {
        error: null,
        message: `Nothing new to queue — ${waiting} feedback email${waiting === 1 ? ' is' : 's are'} already waiting to send.`,
      };
    }

    return {
      error: null,
      message: 'Nothing to queue — nobody has been admitted to this show yet.',
    };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

/**
 * **Send now** — decision 42's manual twin for the timed send
 * (spec/v2.md §13.5.3).
 *
 * **It makes the rows due; it does not send them.** `scheduled_for` moves to
 * now, and the dispatcher claims them on its next pass exactly as it claims
 * anything else — the console's queue banner offers Resume the moment they are
 * due (spec/email.md §11.2.1), and the daily cron is the safety net behind that.
 * Bypassing the dispatcher would mean a second sending path with its own ideas
 * about the daily cap, the reclaim window and `max_attempts`.
 *
 * It exists because a feedback row is scheduled for `portal.feedback_send_hour`
 * and is therefore deliberately *not* resumable until then — which is right for
 * the normal case and wrong for the admin who wants them gone now. The blast
 * screen's own Send cannot reach them either: that screen is per segment and
 * per template, and feedback is addressed per **show**, across both its
 * audiences.
 *
 * Only `QUEUED` rows move. A `DRAFT` is a batch nobody confirmed, a `SENDING`
 * row is in flight, and a `SENT` one is gone.
 */
export async function sendFeedbackNowAction(
  concertId: number,
  showId: number,
): Promise<FormState> {
  await requireRole('ADMIN');

  try {
    const rows = await getDb().execute<{ id: string }>(sql`
      update email_outbox o
         set scheduled_for = now(), updated_at = now()
        from registrations r
       where r.id = o.registration_id
         and r.show_id = ${showId}
         and o.template_key = ${FEEDBACK_TEMPLATE_KEY}
         and o.status = 'QUEUED'
         and o.scheduled_for > now()
      returning o.id
    `);

    await writeAuditLog({
      action: 'feedback.send_now',
      entityType: 'show',
      entityId: showId,
      after: { released: rows.length },
    });

    revalidatePath(`/admin/concerts/${concertId}/shows`);

    return {
      error: null,
      message:
        rows.length === 0
          ? 'Nothing waiting — the feedback emails are already due or already sent.'
          : `${rows.length} feedback email${rows.length === 1 ? '' : 's'} released. They go out on the next dispatch — use Resume in the banner above, or wait for the daily run.`,
    };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

/** How many feedback messages for this show are queued and have not gone yet. */
async function pendingFeedbackCount(showId: number): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n
      from email_outbox o
      join registrations r on r.id = o.registration_id
     where r.show_id = ${showId}
       and o.template_key = ${FEEDBACK_TEMPLATE_KEY}
       and o.status in ('DRAFT', 'QUEUED', 'SENDING')
  `);
  return rows[0]?.n ?? 0;
}
