import 'server-only';
import { sql } from 'drizzle-orm';
import { lockShowForClaim, promoteSeats } from '@/db/allocation';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import type { Tx } from '@/lib/commands/define';
import { checkAddress } from '@/lib/email/address';
import {
  recomputeStatus,
  renameAttendee,
  updateRegistrationDetails,
} from '@/lib/registrations/mutations';
import { mintVerificationToken, queueVerificationEmail } from '@/lib/registrations/verification';
import { UPDATE_TOKEN } from './update-link';

/**
 * The party update link (spec/v3.md §25.6): what a party can change about
 * itself, holding only the link from its receipt.
 *
 * - **Name unnamed guests** — a rename, through the same `renameAttendee()`
 *   the console uses, so a ticket already delivered is flagged for reissue.
 * - **Correct its email** — re-addressing whatever is waiting (§24.3), storing
 *   the §24.6 verdict, and **re-verified**: a fresh verification link goes to
 *   the new address and tickets wait until it is clicked.
 * - **Give back seats** — cancelled at once, and the waitlist promoted first
 *   come first served into the room they leave.
 *
 * It can never **add** a seat (decision 25): more seats are a new submission
 * of the form, which joins the party at the back of the queue (§25.5).
 *
 * Every change is written to the party's Activity with no actor — the party
 * made it — and the link closes once the show has started.
 */

export type UpdateSeat = {
  id: number;
  fullName: string;
  /** A generated "Guest of …" name, waiting for the party to supply one. */
  unnamed: boolean;
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST';
  delivered: boolean;
  admitted: boolean;
};

export type UpdatableParty = {
  registrationId: number;
  concertName: string;
  showName: string;
  startsAt: string | null;
  timeZone: string | null;
  contactName: string;
  contactEmail: string | null;
  /** False while a verification link is outstanding. */
  verified: boolean;
  seats: UpdateSeat[];
  /** Why nothing can be changed any more, or null while the link is open. */
  closedReason: 'SHOW_STARTED' | null;
};

/**
 * The party behind an update token: live, not cancelled, with its live seats.
 * A token that matches nothing, or a party deleted or cancelled, is null — one
 * answer for every miss, as the ticket page and the form give.
 */
export async function loadUpdatableParty(
  token: string,
  now: Date = new Date(),
  executor: Pick<Tx, 'execute'> = getDb(),
): Promise<UpdatableParty | null> {
  if (!UPDATE_TOKEN.test(token)) return null;
  const [row] = await executor.execute<{
    id: string;
    concert_name: string;
    show_name: string;
    starts_at: string | null;
    timezone: string | null;
    contact_name: string;
    contact_email: string | null;
    verified: boolean;
  }>(sql`
    select r.id, c.name as concert_name, s.name as show_name,
           to_json(s.starts_at) #>> '{}' as starts_at, c.timezone,
           r.contact_name, r.contact_email::text as contact_email,
           (r.verification_token is null or r.email_verified_at is not null) as verified
      from registrations r
      join shows s on s.id = r.show_id
      join concerts c on c.id = s.concert_id
     where r.update_token = ${token}
       and r.deleted_at is null
       and r.status <> 'CANCELLED'
  `);
  if (!row) return null;
  const seats = await executor.execute<{
    id: string;
    full_name: string;
    unnamed: boolean;
    status: UpdateSeat['status'];
    delivered: boolean;
    admitted: boolean;
  }>(sql`
    select a.id, a.full_name, a.name_source = 'PLACEHOLDER' as unnamed, a.status::text as status,
           a.ticket_sent_at is not null as delivered,
           exists (select 1 from check_ins c where c.attendee_id = a.id and c.reverted_at is null) as admitted
      from attendees a
     where a.registration_id = ${Number(row.id)} and a.deleted_at is null and a.status <> 'CANCELLED'
     order by a.id
  `);
  const started = row.starts_at !== null && now >= new Date(row.starts_at);
  return {
    registrationId: Number(row.id),
    concertName: row.concert_name,
    showName: row.show_name,
    startsAt: row.starts_at,
    timeZone: row.timezone,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    verified: row.verified,
    seats: seats.map((seat) => ({
      id: Number(seat.id),
      fullName: seat.full_name,
      unnamed: seat.unnamed,
      status: seat.status,
      delivered: seat.delivered,
      admitted: seat.admitted,
    })),
    closedReason: started ? 'SHOW_STARTED' : null,
  };
}

export type UpdateOutcome = { ok: true; message: string } | { ok: false; message: string; addressWarning?: boolean };

const GONE: UpdateOutcome = { ok: false, message: 'This link is no longer valid.' };
const STARTED: UpdateOutcome = {
  ok: false,
  message: 'The concert has started, so this registration can no longer be changed here.',
};

async function openParty(token: string): Promise<UpdatableParty | UpdateOutcome> {
  const party = await loadUpdatableParty(token);
  if (!party) return GONE;
  if (party.closedReason === 'SHOW_STARTED') return STARTED;
  return party;
}

const isOutcome = (value: UpdatableParty | UpdateOutcome): value is UpdateOutcome => 'ok' in value;

/** Name guests: every seat named here must be this party's and not yet admitted. */
export async function nameGuests(
  token: string,
  names: { attendeeId: number; fullName: string }[],
): Promise<UpdateOutcome> {
  const party = await openParty(token);
  if (isOutcome(party)) return party;
  const seats = new Map(party.seats.map((seat) => [seat.id, seat]));
  const changes = names
    .map((entry) => ({ ...entry, fullName: entry.fullName.trim() }))
    .filter((entry) => {
      const seat = seats.get(entry.attendeeId);
      return seat && !seat.admitted && entry.fullName !== '' && entry.fullName !== seat.fullName;
    });
  if (names.some((entry) => !seats.has(entry.attendeeId))) {
    return { ok: false, message: 'That change could not be applied. Please reload and try again.' };
  }
  if (changes.length === 0) return { ok: true, message: 'Nothing to change.' };

  await getDb().transaction(async (tx) => {
    for (const change of changes) {
      await renameAttendee(change.attendeeId, change.fullName, { executor: tx });
    }
    await writeAuditLog(
      {
        action: 'registration.guests_named_by_party',
        entityType: 'registration',
        entityId: party.registrationId,
        after: { seats: changes.length },
        actorId: null,
      },
      tx,
    );
  });
  return { ok: true, message: `Saved ${changes.length} name${changes.length === 1 ? '' : 's'}.` };
}

/**
 * Give back seats. Returned seats are cancelled at once, and the room they
 * leave goes to the waitlist first come first served (§25.6). Giving back every
 * seat cancels the registration.
 */
export async function giveBackSeats(token: string, attendeeIds: number[]): Promise<UpdateOutcome> {
  const party = await openParty(token);
  if (isOutcome(party)) return party;
  const seats = new Map(party.seats.map((seat) => [seat.id, seat]));
  const ids = [...new Set(attendeeIds)];
  if (ids.length === 0) return { ok: false, message: 'Choose the seats to give back.' };
  if (ids.some((id) => !seats.has(id))) {
    return { ok: false, message: 'That change could not be applied. Please reload and try again.' };
  }
  if (ids.some((id) => seats.get(id)!.admitted)) {
    return { ok: false, message: 'A guest who is already inside cannot be given back.' };
  }

  const promoted = await getDb().transaction(async (tx) => {
    const [where] = await tx.execute<{ show_id: string; segment_id: string }>(sql`
      select show_id, segment_id from registrations where id = ${party.registrationId}
    `);
    await lockShowForClaim(Number(where.show_id), tx);
    const released = await tx.execute<{ id: string; was_confirmed: boolean }>(sql`
      update attendees a
         set status = 'CANCELLED', deleted_at = now()
        from (select id, status = 'CONFIRMED' as was_confirmed from attendees
               where id = any(${`{${ids.join(',')}}`}::bigint[])) prior
       where a.id = prior.id
         and a.registration_id = ${party.registrationId}
         and a.deleted_at is null
      returning a.id, prior.was_confirmed
    `);
    const left = party.seats.length - released.length;
    if (left === 0) {
      await tx.execute(sql`update registrations set status = 'CANCELLED' where id = ${party.registrationId}`);
      await tx.execute(sql`
        update email_outbox set status = 'CANCELLED', updated_at = now()
         where registration_id = ${party.registrationId} and status in ('DRAFT', 'QUEUED')
      `);
    } else {
      await recomputeStatus(tx, party.registrationId);
    }
    await writeAuditLog(
      {
        action: 'registration.seats_returned_by_party',
        entityType: 'registration',
        entityId: party.registrationId,
        after: { seats: released.length, cancelledParty: left === 0 },
        actorId: null,
      },
      tx,
    );
    const freed = released.filter((seat) => seat.was_confirmed).length;
    return freed > 0 ? promoteWaitlist(tx, Number(where.segment_id)) : 0;
  });

  const n = ids.length;
  return {
    ok: true,
    message:
      n === party.seats.length
        ? 'Your registration is cancelled. Thank you for letting us know.'
        : `${n} seat${n === 1 ? '' : 's'} given back. Thank you — ${promoted > 0 ? 'someone on the waitlist has' : 'they go back to'} ${promoted > 0 ? 'been offered them' : 'the room'}.`,
  };
}

/**
 * Offer the room just freed to the waitlist, first come first served by each
 * party's earliest waiting seat (§21.3) — **a whole party at a time**: its
 * waiting seats are promoted together or not at all (`promote_seats()` is
 * all-or-nothing), because cutting a party in half is a worse answer than
 * making it wait (`allocation.md` §7.4). The engine decides what fits — the
 * room just freed and any left open before — and the walk stops at the first
 * party it refuses, so a later, smaller party never jumps it.
 *
 * Only what the segment's policy would grant unreviewed: every waiting seat
 * under `AUTO_FCFS`, and under `REVIEW` only base seats — an extra there waits
 * for the admin's review, as §7.5 requires of every extra.
 */
async function promoteWaitlist(tx: Tx, segmentId: number): Promise<number> {
  const waiting = await tx.execute<{ registration_id: string; ids: string[] }>(sql`
    select a.registration_id, array_agg(a.id order by a.requested_at, a.id) as ids
      from attendees a
      join registrations r on r.id = a.registration_id
     where a.segment_id = ${segmentId}
       and a.status = 'WAITLIST'
       and a.deleted_at is null
       and r.deleted_at is null
       and r.status <> 'CANCELLED'
       and (a.allocation_type = 'BASE'
            or (resolve_setting('allocation.extras_policy', ${segmentId}::bigint) #>> '{}') = 'AUTO_FCFS')
     group by a.registration_id
     order by min(a.requested_at), a.registration_id
  `);
  let confirmed = 0;
  for (const party of waiting) {
    const ids = party.ids.map(Number);
    const outcome = await promoteSeats(segmentId, ids, { executor: tx });
    if (outcome.refused || outcome.confirmed === 0) break;
    confirmed += outcome.confirmed;
    await recomputeStatus(tx, Number(party.registration_id));
    await writeAuditLog(
      {
        action: 'registration.promoted',
        entityType: 'registration',
        entityId: Number(party.registration_id),
        after: { confirmed: outcome.confirmed, by: 'seats given back by another party' },
        actorId: null,
      },
      tx,
    );
  }
  return confirmed;
}

/**
 * Correct the party's email. The new address is checked (§24.6) — a domain
 * DNS is certain does not exist is refused once, as on the form — then stored,
 * pending messages re-addressed (§24.3), and a fresh verification link sent to
 * it: tickets wait until the new address is proved.
 */
export async function changeEmail(
  token: string,
  email: string,
  options: { addressConfirmed: boolean },
): Promise<UpdateOutcome> {
  const party = await openParty(token);
  if (isOutcome(party)) return party;
  const address = email.trim();
  const check = await checkAddress(address);
  if (check.issue && check.issue === 'This is not a valid email address.') {
    return { ok: false, message: 'Please enter a valid email address.' };
  }
  if (check.blocking && !options.addressConfirmed) {
    return { ok: false, message: `${check.blocking} Submit again to use it anyway.`, addressWarning: true };
  }
  if ((party.contactEmail ?? '').toLowerCase() === address.toLowerCase()) {
    return { ok: true, message: 'That is already the address on your registration.' };
  }

  await getDb().transaction(async (tx) => {
    const [current] = await tx.execute<{
      contact_phone: string | null;
      player_id: string | null;
      round_label: string | null;
      concert_name: string;
      show_name: string;
    }>(sql`
      select r.contact_phone, r.player_id, r.round_label, c.name as concert_name, s.name as show_name
        from registrations r join shows s on s.id = r.show_id join concerts c on c.id = s.concert_id
       where r.id = ${party.registrationId} for update of r
    `);
    await updateRegistrationDetails(
      party.registrationId,
      {
        contactName: party.contactName,
        contactEmail: address,
        contactPhone: current.contact_phone,
        playerId: current.player_id === null ? null : Number(current.player_id),
        roundLabel: current.round_label,
        emailIssue: check.issue,
      },
      { executor: tx },
    );

    // Re-verified: a new token, and the old link — sent to the old address —
    // stops proving anything.
    const verificationToken = mintVerificationToken();
    await tx.execute(sql`
      update registrations set verification_token = ${verificationToken}, email_verified_at = null
       where id = ${party.registrationId}
    `);
    await tx.execute(sql`
      update email_outbox set status = 'CANCELLED', updated_at = now()
       where registration_id = ${party.registrationId} and purpose = 'VERIFICATION'
         and status in ('DRAFT', 'QUEUED')
    `);
    await queueVerificationEmail(tx, {
      registrationId: party.registrationId,
      contactName: party.contactName,
      contactEmail: address,
      token: verificationToken,
      concertName: current.concert_name,
      showName: current.show_name,
      status: 'QUEUED',
    });
    await tx.execute(sql`select refresh_duplicate_candidates(${party.registrationId}::bigint)`);
    await writeAuditLog(
      {
        action: 'registration.email_changed_by_party',
        entityType: 'registration',
        entityId: party.registrationId,
        before: { contactEmail: party.contactEmail },
        after: { contactEmail: address, emailIssue: check.issue },
        actorId: null,
      },
      tx,
    );
  });
  return {
    ok: true,
    message: `Saved. We have sent a link to ${address} — please open it to confirm the new address before your tickets can be sent.`,
  };
}
