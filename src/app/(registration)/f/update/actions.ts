'use server';

import { headers } from 'next/headers';
import { clientIp, consumeRateLimit, formBucket } from '@/lib/auth/rate-limit';
import { changeEmail, giveBackSeats, nameGuests, type UpdateOutcome } from '@/lib/intake/party-update';

/**
 * The party update link's three actions (spec/v3.md §25.6). The token is the
 * credential, as on the form and the ticket page; each action re-reads the
 * party under it rather than trusting the page, and is throttled as the form
 * is.
 */

async function throttled(): Promise<UpdateOutcome | null> {
  const verdict = await consumeRateLimit(formBucket(clientIp(await headers())));
  return verdict.allowed
    ? null
    : { ok: false, message: `Too many requests. Please wait ${verdict.retryAfterSeconds} seconds and try again.` };
}

export async function nameGuestsAction(
  token: string,
  names: { attendeeId: number; fullName: string }[],
): Promise<UpdateOutcome> {
  return (await throttled()) ?? nameGuests(token, names);
}

export async function giveBackSeatsAction(token: string, attendeeIds: number[]): Promise<UpdateOutcome> {
  return (await throttled()) ?? giveBackSeats(token, attendeeIds);
}

export async function changeEmailAction(
  token: string,
  email: string,
  addressConfirmed: boolean,
): Promise<UpdateOutcome> {
  return (await throttled()) ?? changeEmail(token, email, { addressConfirmed });
}
