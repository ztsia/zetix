'use server';

import { headers } from 'next/headers';
import { clientIp, consumeRateLimit, formBucket } from '@/lib/auth/rate-limit';
import { applyResponseEdit, requestExtraSeats } from '@/lib/registrations/edit';

/**
 * The edit screen's two actions (spec/v2.md §8.3.1).
 *
 * They are deliberately two, not one with a mode flag: saving an edit and
 * asking for more seats are opposite operations under the rule that governs
 * this screen. One may only correct or reduce; the other creates a **new
 * request at the back of the FCFS queue**. Collapsing them into a single
 * "save" would put the no-add rule inside a branch, which is where it would
 * eventually be lost.
 */

export type EditActionResult =
  | { ok: true; message: string; editToken?: string }
  | { ok: false; message: string };

async function throttle(): Promise<EditActionResult | null> {
  const verdict = await consumeRateLimit(formBucket(clientIp(await headers())));
  if (verdict.allowed) return null;
  return {
    ok: false,
    message: `Too many requests. Please wait ${verdict.retryAfterSeconds} seconds and try again.`,
  };
}

export async function saveEditAction(
  editToken: string,
  input: {
    contactName: string;
    contactPhone: string | null;
    custom: Record<string, unknown> | null;
    seats: { attendeeId: number; fullName: string; email: string | null }[];
    raw: unknown;
  },
): Promise<EditActionResult> {
  const throttled = await throttle();
  if (throttled) return throttled;

  const contactName = input.contactName.trim();
  if (contactName === '') return { ok: false, message: 'Please give your name.' };

  /**
   * Every seat carries a name (§8.1.3), on an edit as much as on a submit.
   * `PLACEHOLDER` exists for imported rows where the names genuinely do not
   * exist; a form we control has no such excuse, and blanking a name here would
   * introduce one through the back door.
   */
  for (const seat of input.seats) {
    if (seat.fullName.trim() === '') {
      return { ok: false, message: 'Every seat needs a name. Remove the seat instead.' };
    }
  }

  const result = await applyResponseEdit(editToken, {
    contactName,
    contactPhone: input.contactPhone?.trim() || null,
    custom: input.custom,
    seats: input.seats.map((seat) => ({
      attendeeId: seat.attendeeId,
      fullName: seat.fullName.trim(),
      email: seat.email?.trim() || null,
    })),
    raw: input.raw,
  });

  if ('error' in result) return { ok: false, message: result.error };

  const parts = ['Your changes have been saved.'];
  if (result.removed > 0) {
    parts.push(
      `${result.removed} seat${result.removed === 1 ? '' : 's'} released back to the pool.`,
    );
  }
  return { ok: true, message: parts.join(' '), editToken: result.editToken };
}

export async function requestExtraSeatsAction(
  editToken: string,
  names: string[],
): Promise<EditActionResult> {
  const throttled = await throttle();
  if (throttled) return throttled;

  const result = await requestExtraSeats(editToken, names);
  if ('error' in result) return { ok: false, message: result.error };

  /**
   * Reported honestly, including when nothing was granted. The request joins the
   * back of the queue with a new `requested_at` and the segment's policy decides
   * what happens — under `REVIEW` that means nothing is granted now, which is
   * the normal case and must not read as a failure.
   */
  if (result.granted > 0) {
    return {
      ok: true,
      message: `${result.granted} extra seat${result.granted === 1 ? '' : 's'} confirmed.`,
    };
  }
  if (result.pending > 0) {
    return {
      ok: true,
      message: `Requested ${result.pending} extra seat${result.pending === 1 ? '' : 's'}. They are in the queue and will be reviewed after the deadline — we will email you either way.`,
    };
  }
  return {
    ok: true,
    message: `Requested ${result.requested} extra seat${result.requested === 1 ? '' : 's'}. There is no room at the moment, so they are waitlisted — we will be in touch if a seat frees up.`,
  };
}
