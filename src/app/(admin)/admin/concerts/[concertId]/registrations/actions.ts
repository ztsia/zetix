'use server';

import { revalidatePath } from 'next/cache';
import { TZDate } from '@date-fns/tz';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import { resolveSetting } from '@/db/settings';
import {
  confirmsOverCapacity,
  OVERSELL_PHRASE,
} from '@/lib/registrations/confirmation';
import {
  addAttendees,
  AdmittedAttendeeError,
  cancelRegistration,
  createRegistration,
  deleteRegistration,
  moveRegistration,
  removeAttendee,
  renameAttendee,
  restoreRegistration,
  updateRegistrationDetails,
  type NewSeat,
} from '@/lib/registrations/mutations';
import type { FormState } from '../../form-state';
import {
  attendeeInConcert,
  registrationInConcert,
  segmentInConcert,
} from './queries';

/**
 * Manual registration CRUD (spec/allocation.md §7.6, spec/admin.md §14.1).
 *
 * The behaviour lives in `src/lib/registrations/mutations.ts`; these actions
 * are the boundary around it — validate, check the id belongs to this concert,
 * record the override, revalidate.
 *
 * **The database's sentence is what reaches the screen.** The capacity guards
 * raise messages written for an admin to act on — "Segment "Public" already has
 * 3 confirmed seats…" — and every one of these actions passes that through
 * untouched rather than replacing it with a generic failure (`form-state.ts`).
 *
 * **Overriding a ceiling is recorded.** §7.6 allows exceeding the hall "with a
 * typed confirmation recorded in `audit_log`", so the actions that accept an
 * override write the row themselves; the engine only takes the flag.
 */

const blankToNull = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  return trimmed === '' || trimmed === undefined ? null : trimmed;
};

const optionalText = z.preprocess(blankToNull, z.string().trim().max(200).nullable());

const optionalId = z.preprocess(
  blankToNull,
  z.coerce.number().int().positive().nullable(),
);

/** `datetime-local` posts `YYYY-MM-DDTHH:mm`, with no zone of its own. */
const localDateTime = z.preprocess(
  blankToNull,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Use the date and time picker.')
    .nullable(),
);

/**
 * The admin types a wall-clock time meaning *at the venue*, so storing it needs
 * the concert's zone (spec/domain.md §6.1). Read from the database rather than
 * trusted from the browser.
 */
function toInstant(local: string | null, timeZone: string): Date | null {
  if (!local) return null;
  const [datePart, timePart] = local.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  return new Date(TZDate.tz(timeZone, year, month - 1, day, hour, minute).getTime());
}

async function concertTimeZone(concertId: number): Promise<string> {
  const rows = await getDb().execute<{ timezone: string | null }>(sql`
    select timezone from concerts where id = ${concertId}
  `);
  const zone = rows[0]?.timezone;
  if (!zone) {
    // Never invented. A concert with no zone cannot place a wall-clock time on
    // the timeline at all, and guessing UTC would silently shift it.
    throw new Error(
      'This concert has no timezone set, so a request time cannot be recorded. Set it on the concert first.',
    );
  }
  return zone;
}

const ok = (message?: string): FormState => ({ error: null, message: message ?? null });
const fail = (error: string): FormState => ({ error, message: null });

function refresh(concertId: number): void {
  revalidatePath(`/admin/concerts/${concertId}/registrations`);
  revalidatePath(`/admin/concerts/${concertId}/extras-review`);
  revalidatePath(`/admin/concerts/${concertId}/overview`);
}

/**
 * The party, as the create form expresses it.
 *
 * A seat count plus an optional list of names, one per line, rather than a
 * repeating field set: a party of four whose names are known is four lines
 * pasted from an email, and a party of four whose names are not is just the
 * number. Any seat without a name tickets as "Guest of {contact_name}", which
 * is not an error (decision 32).
 */
function seatsFrom(count: number, names: string | null, type: NewSeat['allocationType']) {
  const lines = (names ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return Array.from({ length: count }, (_, index) => ({
    fullName: lines[index] ?? null,
    allocationType: type,
  }));
}

/**
 * The party cap, resolved rather than invented (spec/domain.md §6).
 *
 * `form.max_tickets_per_response` cascades segment → show → concert → system, and
 * **null means no cap is configured**, not zero — the same reading module `C`
 * applies to the same key on the import path. Enforcing it here as well is what
 * keeps the two routes into `registrations` agreeing about how large a party may
 * be; a cap the admin set that only the importer honours is not a cap.
 *
 * It bounds a *party*, so it is checked against the seats this registration will
 * hold in total — the existing ones plus the ones being added — rather than
 * against each click.
 */
async function assertWithinPartyCap(
  segmentId: number,
  seats: number,
  existingSeats = 0,
): Promise<string | null> {
  const cap = await resolveSetting<number>('form.max_tickets_per_response', { segmentId });
  if (cap == null) return null;

  const total = seats + existingSeats;
  if (total <= cap) return null;

  return existingSeats > 0
    ? `This party would hold ${total} seats, above the ${cap}-seat cap for this segment. It already holds ${existingSeats}.`
    : `${total} seats is above the ${cap}-seat cap for this segment.`;
}

/** How many seats a party already holds, and where. */
async function partySize(
  registrationId: number,
): Promise<{ segmentId: number; seats: number }> {
  const rows = await getDb().execute<{ segment_id: string; seats: number }>(sql`
    select r.segment_id,
           (select count(*)::int from attendees a
             where a.registration_id = r.id
               and a.deleted_at is null
               and a.status <> 'CANCELLED') as seats
      from registrations r
     where r.id = ${registrationId}
  `);
  if (rows.length === 0) throw new Error('That registration no longer exists.');
  return { segmentId: Number(rows[0].segment_id), seats: rows[0].seats };
}

const allocationType = z.enum(['BASE', 'EXTRA', 'HELD', 'COMP']);

const registrationSchema = z.object({
  segmentId: z.coerce.number().int().positive('Choose a segment.'),
  contactName: z.string().trim().min(1, 'A registration needs a contact name.').max(200),
  contactEmail: z.preprocess(
    blankToNull,
    z.string().trim().email('That is not an email address.').max(320).nullable(),
  ),
  contactPhone: optionalText,
  playerId: optionalId,
  roundLabel: optionalText,
  requestedAt: localDateTime,
  /**
   * No ceiling here. The party cap is `form.max_tickets_per_response`, resolved
   * through the cascade against the segment being registered into — a literal
   * in this file would be an operational value in code, and worse, would enforce
   * an invented number while the configured one went unread (`CLAUDE.md`,
   * spec/README.md §2.1). {@link assertWithinPartyCap} is where it is applied.
   */
  seats: z.coerce.number().int().min(1, 'A registration needs at least one seat.'),
  guestNames: z.preprocess(blankToNull, z.string().max(4000).nullable()),
  allocationType,
  /**
   * §7.6 allows exceeding the hall "with a typed confirmation recorded in
   * `audit_log`" — so the override is what the admin *typed*, never a checkbox.
   * A tick is one stray click away from overfilling the room, and the review
   * screen already asks for the phrase; the two must not disagree about how
   * deliberate deliberate is.
   */
  overrideConfirmation: z.string().trim().max(100),
});

export async function createRegistrationAction(
  concertId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const admin = await requireRole('ADMIN');

  const parsed = registrationSchema.safeParse({
    segmentId: formData.get('segmentId') ?? '',
    contactName: formData.get('contactName') ?? '',
    contactEmail: formData.get('contactEmail') ?? '',
    contactPhone: formData.get('contactPhone') ?? '',
    playerId: formData.get('playerId') ?? '',
    roundLabel: formData.get('roundLabel') ?? '',
    requestedAt: formData.get('requestedAt') ?? '',
    seats: formData.get('seats') ?? '',
    guestNames: formData.get('guestNames') ?? '',
    allocationType: formData.get('allocationType') ?? 'EXTRA',
    overrideConfirmation: formData.get('overrideConfirmation') ?? '',
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const input = parsed.data;
  const override = confirmsOverCapacity(input.overrideConfirmation);

  if (!(await segmentInConcert(concertId, input.segmentId))) {
    return fail('That segment does not belong to this concert.');
  }

  const overCap = await assertWithinPartyCap(input.segmentId, input.seats);
  if (overCap) return fail(overCap);

  try {
    const timeZone = await concertTimeZone(concertId);
    const result = await createRegistration({
      segmentId: input.segmentId,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      playerId: input.playerId,
      roundLabel: input.roundLabel,
      requestedAt: toInstant(input.requestedAt, timeZone),
      seats: seatsFrom(input.seats, input.guestNames, input.allocationType),
      override,
      createdBy: admin.id,
    });

    if (override) {
      await writeAuditLog({
        action: 'registration.created_over_capacity',
        entityType: 'registration',
        entityId: result.registrationId,
        after: { seats: input.seats, granted: result.granted },
        reason: `Manual registration for ${input.contactName}, seated past the ceiling. Confirmation typed: "${input.overrideConfirmation}".`,
        actorId: admin.id,
      });
    }

    refresh(concertId);

    const granted = result.granted.base + result.granted.extra + result.granted.other;
    return ok(
      [
        granted > 0 ? `${granted} seat${granted === 1 ? '' : 's'} confirmed` : null,
        result.pending > 0 ? `${result.pending} held for review` : null,
        result.waitlisted > 0 ? `${result.waitlisted} waitlisted` : null,
      ]
        .filter(Boolean)
        .join(', '),
    );
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}

const detailsSchema = registrationSchema.pick({
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  playerId: true,
  roundLabel: true,
  requestedAt: true,
});

export async function updateRegistrationAction(
  concertId: number,
  registrationId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = detailsSchema.safeParse({
    contactName: formData.get('contactName') ?? '',
    contactEmail: formData.get('contactEmail') ?? '',
    contactPhone: formData.get('contactPhone') ?? '',
    playerId: formData.get('playerId') ?? '',
    roundLabel: formData.get('roundLabel') ?? '',
    requestedAt: formData.get('requestedAt') ?? '',
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  if (!(await registrationInConcert(concertId, registrationId))) {
    return fail('That registration does not belong to this concert.');
  }

  try {
    const timeZone = await concertTimeZone(concertId);
    await updateRegistrationDetails(registrationId, {
      ...parsed.data,
      requestedAt: toInstant(parsed.data.requestedAt, timeZone),
    });
    refresh(concertId);
    return ok('Saved.');
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}

const addSeatsSchema = z.object({
  seats: z.coerce.number().int().min(1, 'Add at least one seat.'),
  guestNames: z.preprocess(blankToNull, z.string().max(4000).nullable()),
  allocationType,
  overrideConfirmation: z.string().trim().max(100),
});

export async function addAttendeesAction(
  concertId: number,
  registrationId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const admin = await requireRole('ADMIN');

  const parsed = addSeatsSchema.safeParse({
    seats: formData.get('seats') ?? '',
    guestNames: formData.get('guestNames') ?? '',
    allocationType: formData.get('allocationType') ?? 'EXTRA',
    overrideConfirmation: formData.get('overrideConfirmation') ?? '',
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const override = confirmsOverCapacity(parsed.data.overrideConfirmation);

  if (!(await registrationInConcert(concertId, registrationId))) {
    return fail('That registration does not belong to this concert.');
  }

  const party = await partySize(registrationId);
  const overCap = await assertWithinPartyCap(
    party.segmentId,
    parsed.data.seats,
    party.seats,
  );
  if (overCap) return fail(overCap);

  try {
    const result = await addAttendees(
      registrationId,
      seatsFrom(parsed.data.seats, parsed.data.guestNames, parsed.data.allocationType),
      { override },
    );

    if (override) {
      await writeAuditLog({
        action: 'registration.seats_added_over_capacity',
        entityType: 'registration',
        entityId: registrationId,
        after: result,
        reason: `Seats added past the ceiling. Confirmation typed: "${parsed.data.overrideConfirmation}".`,
        actorId: admin.id,
      });
    }

    refresh(concertId);
    return ok(
      result.confirmed > 0
        ? `${result.confirmed} seat${result.confirmed === 1 ? '' : 's'} confirmed.`
        : 'Added — no seat was free, so they are waiting.',
    );
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}

export async function renameAttendeeAction(
  concertId: number,
  attendeeId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = z
    .object({ fullName: z.preprocess(blankToNull, z.string().trim().max(200).nullable()) })
    .safeParse({ fullName: formData.get('fullName') ?? '' });
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  if (!(await attendeeInConcert(concertId, attendeeId))) {
    return fail('That seat does not belong to this concert.');
  }

  try {
    await renameAttendee(attendeeId, parsed.data.fullName);
    refresh(concertId);
    return ok('Renamed.');
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}

export async function removeAttendeeAction(
  concertId: number,
  attendeeId: number,
): Promise<FormState> {
  const admin = await requireRole('ADMIN');

  if (!(await attendeeInConcert(concertId, attendeeId))) {
    return fail('That seat does not belong to this concert.');
  }

  try {
    await removeAttendee(attendeeId);
    await writeAuditLog({
      action: 'attendee.removed',
      entityType: 'attendee',
      entityId: attendeeId,
      actorId: admin.id,
    });
    refresh(concertId);
    return ok('Seat removed.');
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}

const moveSchema = z.object({
  segmentId: z.coerce.number().int().positive('Choose a destination.'),
  overrideConfirmation: z.string().trim().max(100),
});

export async function moveRegistrationAction(
  concertId: number,
  registrationId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const admin = await requireRole('ADMIN');

  const parsed = moveSchema.safeParse({
    segmentId: formData.get('segmentId') ?? '',
    overrideConfirmation: formData.get('overrideConfirmation') ?? '',
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const override = confirmsOverCapacity(parsed.data.overrideConfirmation);

  if (!(await registrationInConcert(concertId, registrationId))) {
    return fail('That registration does not belong to this concert.');
  }
  if (!(await segmentInConcert(concertId, parsed.data.segmentId))) {
    return fail('That segment does not belong to this concert.');
  }

  try {
    const result = await moveRegistration(registrationId, parsed.data.segmentId, {
      override,
    });

    await writeAuditLog({
      action: override ? 'registration.moved_over_capacity' : 'registration.moved',
      entityType: 'registration',
      entityId: registrationId,
      after: { segmentId: parsed.data.segmentId, seats: result.movedSeats },
      reason: override
        ? `Moved into a segment with no room. Confirmation typed: "${parsed.data.overrideConfirmation}".`
        : null,
      actorId: admin.id,
    });

    refresh(concertId);
    return ok(
      result.showChanged
        ? `Moved with ${result.movedSeats} seat${result.movedSeats === 1 ? '' : 's'}. Delivered tickets for another show are flagged for reissue.`
        : `Moved with ${result.movedSeats} seat${result.movedSeats === 1 ? '' : 's'}.`,
    );
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}

export async function cancelRegistrationAction(
  concertId: number,
  registrationId: number,
): Promise<FormState> {
  const admin = await requireRole('ADMIN');

  if (!(await registrationInConcert(concertId, registrationId))) {
    return fail('That registration does not belong to this concert.');
  }

  try {
    const result = await cancelRegistration(registrationId);
    await writeAuditLog({
      action: 'registration.cancelled',
      entityType: 'registration',
      entityId: registrationId,
      after: result,
      actorId: admin.id,
    });
    refresh(concertId);

    // §7.9's line, verbatim in shape: "N seats freed, M waiting".
    return ok(
      `${result.seatsFreed} seat${result.seatsFreed === 1 ? '' : 's'} freed, ` +
        `${result.seatsWaiting} waiting.` +
        (result.outboxCancelled > 0
          ? ` ${result.outboxCancelled} queued email${result.outboxCancelled === 1 ? '' : 's'} withdrawn.`
          : ''),
    );
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}

/**
 * Delete a registration outright (§7.6).
 *
 * Distinct from {@link cancelRegistrationAction} on purpose: cancelling says a
 * real booking is not coming and keeps the record, deleting says the row
 * should never have existed. The audit entry carries the party it removed, so
 * a soft-deleted registration can still be identified afterwards from the log
 * alone — nothing in the admin UI lists deleted rows.
 */
export async function deleteRegistrationAction(
  concertId: number,
  registrationId: number,
): Promise<FormState> {
  const admin = await requireRole('ADMIN');

  if (!(await registrationInConcert(concertId, registrationId))) {
    return fail('That registration does not belong to this concert.');
  }

  try {
    const result = await deleteRegistration(registrationId);
    await writeAuditLog({
      action: 'registration.deleted',
      entityType: 'registration',
      entityId: registrationId,
      after: result,
      actorId: admin.id,
    });
    refresh(concertId);

    return ok(
      `Registration deleted. ${result.seatsFreed} seat${result.seatsFreed === 1 ? '' : 's'} freed.` +
        (result.outboxCancelled > 0
          ? ` ${result.outboxCancelled} queued email${result.outboxCancelled === 1 ? '' : 's'} withdrawn.`
          : ''),
    );
  } catch (error) {
    // The guard's own sentence names how many are already inside, and the
    // dialog renders it verbatim as every other guard's message is.
    if (error instanceof AdmittedAttendeeError) return fail(error.message);
    return fail(dbErrorMessage(error));
  }
}

export async function restoreRegistrationAction(
  concertId: number,
  registrationId: number,
  options: { override?: boolean } = {},
): Promise<FormState> {
  const admin = await requireRole('ADMIN');

  if (!(await registrationInConcert(concertId, registrationId))) {
    return fail('That registration does not belong to this concert.');
  }

  try {
    const result = await restoreRegistration(registrationId, options);
    await writeAuditLog({
      action: options.override ? 'registration.restored_over_capacity' : 'registration.restored',
      entityType: 'registration',
      entityId: registrationId,
      after: result,
      reason: options.override ? 'Restored past the ceiling deliberately.' : null,
      actorId: admin.id,
    });
    refresh(concertId);

    if (result.refused) {
      // Not a failure: the booking is back, the seats are not. The database's
      // sentence explains which ceiling was in the way.
      return ok(
        `Restored, but the room has gone — ${result.waitlisted} seat${result.waitlisted === 1 ? ' is' : 's are'} waiting. ${result.refused}`,
      );
    }
    return ok(
      [
        result.confirmed > 0 ? `${result.confirmed} seat${result.confirmed === 1 ? '' : 's'} confirmed` : null,
        result.pending > 0 ? `${result.pending} back under review` : null,
        result.waitlisted > 0 ? `${result.waitlisted} waiting` : null,
      ]
        .filter(Boolean)
        .join(', ') || 'Restored.',
    );
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}
