import 'server-only';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { claimSeats, lockShowForClaim } from '@/db/allocation';
import { getDb } from '@/db/client';
import { resolveSetting } from '@/db/settings';
import { queueReceipt } from '@/lib/intake/receipt';
import { reviewAtIntake } from '@/lib/intake/review';

/**
 * Editing a response (spec/v2.md §8.3.1) — **the sharpest rule set in V2**.
 *
 * The whole of it is one sentence: an edit may **correct or reduce, never
 * increase.** An edit form that can claim inventory is a second, unpoliced
 * allocation path, and it lets somebody who registered early keep an early
 * queue position for seats they never originally asked for.
 *
 * §8.3.1 states it as a table, and this module implements the table:
 *
 * | Change | Allowed | Effect |
 * |---|---|---|
 * | Fix a guest's name or email | Yes | Updates the attendee; flags `needs_reissue` if `ticket_sent_at` is set |
 * | Fix contact name / phone / custom | Yes | Updates the registration |
 * | **Remove** a guest | Yes | Attendee → `CANCELLED`, seat returns to the pool immediately |
 * | **Add** a guest | **No** | The form offers "request extra tickets" instead |
 *
 * **There is no "add" path in this module at all**, and that is deliberate
 * rather than an omission: {@link requestExtraSeats} is a separate function that
 * creates a *new request at the back of the queue*, because that is what the
 * spec says the offer is. Nothing here can grow an existing party.
 */

export type EditableSeat = {
  attendeeId: number;
  fullName: string;
  email: string | null;
  allocationType: string;
  /** A sent ticket closes editing to the registrant (§8.3.1, §7.6). */
  ticketSent: boolean;
};

export type EditableResponse = {
  registrationId: number;
  responseId: number;
  formId: number;
  slug: string;
  segmentId: number;
  showId: number;
  concertId: number;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  seats: EditableSeat[];
  /**
   * Why editing is closed, or null while it is open.
   *
   * Two reasons, and they are different facts for the reader: the window has
   * passed, or their tickets are already out. §8.3.1 closes editing once tickets
   * are sent *by default* — a name change on a ticket in somebody's inbox needs
   * a reissue decision, which is an admin's (§7.6).
   */
  closedReason: 'WINDOW' | 'TICKETS_SENT' | null;
};

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Load a response for editing, by `edit_token` (§8.3.1).
 *
 * **Only the newest response in a chain is editable.** The registration points
 * at its newest response, and every edit inserts another; an old token in an
 * old confirmation email must not reopen a superseded version and write it
 * forward over later corrections.
 */
export async function loadEditableResponse(
  editToken: string,
  now: Date = new Date(),
): Promise<EditableResponse | null> {
  if (!TOKEN.test(editToken)) return null;

  const rows = await getDb().execute<{
    registration_id: string;
    response_id: string;
    form_id: string;
    slug: string;
    segment_id: string;
    show_id: string;
    concert_id: string;
    contact_name: string;
    contact_email: string;
    contact_phone: string | null;
    allow_edit_until: string | null;
  }>(sql`
    select
      r.id as registration_id,
      fr.id as response_id,
      f.id as form_id,
      f.slug,
      r.segment_id,
      r.show_id,
      s.concert_id,
      r.contact_name,
      r.contact_email,
      r.contact_phone,
      f.allow_edit_until::text as allow_edit_until
    from form_responses fr
    join registration_forms f on f.id = fr.form_id
    -- This join is what makes only the newest response editable: the
    -- registration points at its newest response and every edit inserts
    -- another, so a superseded row is one that nothing points at and the join
    -- finds no registration for it. Stated as a join rather than as a flag
    -- checked afterwards because the flag was unreachable code -- an earlier
    -- version carried an is_current boolean that no test could make false.
    join registrations r on r.form_response_id = fr.id
    join shows s on s.id = r.show_id
    where fr.edit_token = ${editToken}
      and r.deleted_at is null
      and r.status <> 'CANCELLED'
    limit 1
  `);

  const row = rows[0];
  if (!row) return null;

  const seatRows = await getDb().execute<{
    id: string;
    full_name: string;
    email: string | null;
    allocation_type: string;
    ticket_sent: boolean;
  }>(sql`
    select id, full_name, email, allocation_type::text,
           ticket_sent_at is not null as ticket_sent
      from attendees
     where registration_id = ${Number(row.registration_id)}::bigint
       and deleted_at is null
       and status <> 'CANCELLED'
     order by id
  `);

  const seats = seatRows.map((seat) => ({
    attendeeId: Number(seat.id),
    fullName: seat.full_name,
    email: seat.email,
    allocationType: seat.allocation_type,
    ticketSent: seat.ticket_sent,
  }));

  const windowClosed =
    row.allow_edit_until !== null && now >= new Date(row.allow_edit_until);
  const ticketsSent = seats.some((seat) => seat.ticketSent);

  return {
    registrationId: Number(row.registration_id),
    responseId: Number(row.response_id),
    formId: Number(row.form_id),
    slug: row.slug,
    segmentId: Number(row.segment_id),
    showId: Number(row.show_id),
    concertId: Number(row.concert_id),
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    seats,
    // Tickets first: it is the more specific reason, and the one whose remedy
    // ("contact the orchestra") differs from simply being too late.
    closedReason: ticketsSent ? 'TICKETS_SENT' : windowClosed ? 'WINDOW' : null,
  };
}

export type EditInput = {
  contactName: string;
  contactPhone: string | null;
  custom: Record<string, unknown> | null;
  /** One entry per seat the registrant is keeping. Omitted seats are removed. */
  seats: { attendeeId: number; fullName: string; email: string | null }[];
  /** The exact payload as submitted, for the new `form_responses` row. */
  raw: unknown;
};

export type EditOutcome = {
  removed: number;
  /** The new response's token — the old one is superseded and stops working. */
  editToken: string;
};

/**
 * **Why nothing here flags `needs_reissue`.**
 *
 * §8.3.1 says a name fix flags a reissue when `ticket_sent_at` is set — and on
 * *this* screen that is unreachable, because the row above it in the same table
 * closes editing to the registrant entirely once tickets are sent. A party with
 * any live sent seat gets `closedReason: 'TICKETS_SENT'` and never reaches the
 * update.
 *
 * So the reissue decision belongs where §8.3.1 sends it — to admin
 * (`allocation.md` §7.6) — and module `B` already makes it properly:
 * `renameAttendee()` calls `flagReissueForChangedFields()`, which checks whether
 * the attendee's **pinned template actually prints the field** rather than
 * assuming every name change matters.
 *
 * An earlier version of this module hand-rolled the flag here anyway. A QA pass
 * found it reported zero every time — `RETURNING` sees the updated row, so the
 * before/after comparison was always false — and that the branch could not run
 * at all. Both are gone rather than fixed: code no test can reach is not a
 * safety net, it is a claim nobody can check.
 */

/**
 * Apply the §8.3.1 table.
 *
 * **Everything happens in one transaction**, because a half-applied edit is a
 * party whose seats and whose receipt disagree, and the receipt is what an admin
 * reads when the registrant disputes it.
 */
export async function applyResponseEdit(
  editToken: string,
  input: EditInput,
): Promise<EditOutcome | { error: string }> {
  const current = await loadEditableResponse(editToken);
  if (!current) return { error: 'That edit link is no longer valid.' };
  if (current.closedReason === 'TICKETS_SENT') {
    return {
      error:
        'Your tickets have already been sent, so this registration can no longer be changed here. Please contact the orchestra.',
    };
  }
  if (current.closedReason === 'WINDOW') {
    return { error: 'The window for changing this registration has closed.' };
  }

  const keptIds = new Set(input.seats.map((seat) => seat.attendeeId));
  const known = new Set(current.seats.map((seat) => seat.attendeeId));

  /**
   * **An id that is not already on this registration is refused outright.**
   *
   * This is the "add" row of the table, enforced rather than merely not
   * offered: the screen has no add control, so anything arriving here is a
   * crafted payload, and accepting it would be exactly the unpoliced second
   * allocation path §8.3.1 exists to prevent.
   */
  for (const seat of input.seats) {
    if (!known.has(seat.attendeeId)) {
      return { error: 'That change could not be applied. Please reload and try again.' };
    }
  }

  /**
   * Removing every seat is a cancellation, and it is not this screen's to make.
   * Silently emptying a party would leave a `CONFIRMED` registration holding
   * nothing, which every count in the system would have to special-case.
   */
  if (input.seats.length === 0) {
    return {
      error:
        'You cannot remove everyone from a registration here. Please contact the orchestra to cancel it.',
    };
  }

  const newToken = randomBytes(24).toString('base64url');

  try {
    return await getDb().transaction(async (tx) => {
      for (const seat of input.seats) {
        await tx.execute(sql`
          update attendees
             set full_name = ${seat.fullName},
                 email = ${seat.email},
                 name_source = 'PROVIDED'
           where id = ${seat.attendeeId}::bigint
             and registration_id = ${current.registrationId}::bigint
             and deleted_at is null
        `);
      }

      /**
       * **Remove** — `CANCELLED` plus a soft delete, exactly as
       * `removeAttendee()` does it (§7.6). The seat returns to the pool
       * immediately and **nothing needs recounting**: `confirmed`,
       * `unclaimed_base` and `extras_pool` are recomputed inside the row lock on
       * every claim, so the next read already reflects it (§8.3.1, §7.8). There
       * is no counter to drift.
       */
      const removedIds = current.seats
        .filter((seat) => !keptIds.has(seat.attendeeId))
        .map((seat) => seat.attendeeId);

      if (removedIds.length > 0) {
        await tx.execute(sql`
          update attendees
             set status = 'CANCELLED', deleted_at = now()
           where registration_id = ${current.registrationId}::bigint
             and id in ${sql`(${sql.join(removedIds.map((id) => sql`${id}::bigint`), sql`, `)})`}
             and deleted_at is null
        `);
      }

      await tx.execute(sql`
        update registrations
           set contact_name = ${input.contactName},
               contact_phone = ${input.contactPhone},
               custom = ${input.custom === null ? null : JSON.stringify(input.custom)}::text::jsonb
         where id = ${current.registrationId}::bigint
      `);

      /**
       * **The edit inserts a new `form_responses` row**, chained by
       * `supersedes_id`, and never mutates `raw` — which §8.2.3 promises is the
       * receipt of what the person actually typed. The chain is the edit
       * history, and it is what an admin reads when somebody disputes what they
       * submitted.
       *
       * The pinned `form_schema` is **carried forward from the response being
       * superseded**, not re-read from the form. The answers are an edit of what
       * was asked then; re-pinning the current schema would change what they
       * mean if an admin has since edited the form (§8.2.4).
       */
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into form_responses (
          form_id, raw, form_schema, identity_key, supersedes_id,
          submitted_at, edit_token
        )
        select
          prev.form_id,
          ${JSON.stringify(input.raw)}::text::jsonb,
          prev.form_schema,
          -- Carried forward: the identity has not changed, and the partial
          -- unique index is on (form_id, identity_key), so re-using the value
          -- would collide with the row being superseded.
          null,
          prev.id,
          now(),
          ${newToken}
        from form_responses prev
        where prev.id = ${current.responseId}::bigint
        returning id
      `);

      await tx.execute(sql`
        update registrations set form_response_id = ${Number(inserted[0].id)}::bigint
         where id = ${current.registrationId}::bigint
      `);

      /** A party that lost seats may no longer be `CONFIRMED`. */
      await tx.execute(sql`
        update registrations r
           set status = case
                 when exists (select 1 from attendees a
                               where a.registration_id = r.id and a.status = 'CONFIRMED'
                                 and a.deleted_at is null) then 'CONFIRMED'
                 when exists (select 1 from attendees a
                               where a.registration_id = r.id and a.status = 'PENDING_REVIEW'
                                 and a.deleted_at is null) then 'PENDING_REVIEW'
                 else 'WAITLIST'
               end::booking_status
         where r.id = ${current.registrationId}::bigint
           and r.status <> 'CANCELLED'
      `);

      return { removed: removedIds.length, editToken: newToken };
    });
  } catch (error) {
    console.error('response edit failed:', error);
    return { error: 'Something went wrong and nothing was changed. Please try again.' };
  }
}

/**
 * "Request extra tickets" — the offer that replaces adding a guest (§8.3.1).
 *
 * **A new request at the back of the FCFS queue.** Keeping the original
 * timestamp would let an early registrant reserve a queue position for seats
 * they had not yet asked for, which is the precise abuse the no-add rule exists
 * to prevent.
 *
 * Since V3 the seats join **the same party**, each carrying the request's own
 * `requested_at` (spec/v3.md §21.3, §25.5 — one party per email per segment).
 * V2 made a second registration because a seat had no time of its own and the
 * party's time was the ordering key; the seat's time now is. The party goes
 * back to review, since this is a new claim, and gets an updated receipt.
 *
 * The seats go through `claim_seats()` like every other grant, so the segment's
 * `extras_policy` decides what actually happens — `PENDING_REVIEW` under
 * `REVIEW`, granted or waitlisted under `AUTO_FCFS`.
 */
export async function requestExtraSeats(
  editToken: string,
  names: string[],
): Promise<{ requested: number; granted: number; pending: number; waitlisted: number } | { error: string }> {
  const current = await loadEditableResponse(editToken);
  if (!current) return { error: 'That edit link is no longer valid.' };

  /**
   * **The same three refusals `applyResponseEdit()` makes, and for stronger
   * reasons.**
   *
   * An earlier version of this function checked only that the token resolved,
   * which made it a second allocation path with none of the guards its sibling
   * has eleven lines above. A QA pass drained a segment's extras pool from a
   * public URL with one edit token: `form.extra_rows_max` of 2, forty names
   * requested, forty granted.
   *
   * Editing is *correcting*; this is *claiming*. So every limit that closes the
   * edit screen closes this too — and where the two differ, this one is the one
   * that must be stricter, never looser.
   */
  if (current.closedReason === 'TICKETS_SENT') {
    return {
      error:
        'Your tickets have already been sent, so extra seats need to go through the orchestra. Please get in touch.',
    };
  }
  if (current.closedReason === 'WINDOW') {
    return { error: 'The window for changing this registration has closed.' };
  }

  const wanted = names.map((name) => name.trim()).filter((name) => name !== '');
  if (wanted.length === 0) return { error: 'Add at least one name.' };

  /**
   * `form.extra_rows_max` through the cascade — the same key that governs the
   * `GUESTS_EXTRA` repeater on the form itself (§8.3's table), because this is
   * that repeater arriving by another door.
   *
   * **A cap that does not resolve refuses**, exactly as `limits.ts` refuses
   * rather than rendering a repeater with an invented number. Here the stakes
   * are higher than a mis-drawn form: an unresolved cap that defaulted to
   * "unlimited" is precisely the bug this guard was written for.
   */
  const cap = await resolveSetting<number>('form.extra_rows_max', {
    segmentId: current.segmentId,
    showId: current.showId,
    concertId: current.concertId,
  });
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    return { error: 'Extra seats cannot be requested for this show. Please contact the orchestra.' };
  }
  if (wanted.length > Math.trunc(cap)) {
    return {
      error: `You may request at most ${Math.trunc(cap)} extra seat${Math.trunc(cap) === 1 ? '' : 's'} at a time.`,
    };
  }

  try {
    return await getDb().transaction(async (tx) => {
      // The hall lock first, for the same reason the submit path takes it.
      await lockShowForClaim(current.showId, tx);

      const registrationId = current.registrationId;
      await tx.execute(sql`select id from registrations where id = ${registrationId}::bigint for update`);

      const outcome = await claimSeats(
        current.segmentId,
        registrationId,
        // The request's own time on every seat (spec/v3.md §21.3): the back of
        // the first-come queue, never the party's earlier place.
        wanted.map((fullName) => ({ fullName, email: null, allocationType: 'EXTRA' as const, requestedAt: new Date() })),
        { executor: tx },
      );

      await tx.execute(sql`
        update registrations r
           set status = case
                 when exists (select 1 from attendees a
                               where a.registration_id = r.id and a.status = 'CONFIRMED'
                                 and a.deleted_at is null) then 'CONFIRMED'
                 when exists (select 1 from attendees a
                               where a.registration_id = r.id and a.status = 'PENDING_REVIEW'
                                 and a.deleted_at is null) then 'PENDING_REVIEW'
                 else 'WAITLIST'
               end::booking_status
         where r.id = ${registrationId}::bigint
      `);

      // A new claim is reviewed like any other (§25.4), and the party is told
      // what it now holds.
      await reviewAtIntake(tx, registrationId, { resetApproval: true });
      await queueReceipt(tx, registrationId, { holdMinutes: 0 });

      return {
        requested: wanted.length,
        granted: outcome.granted_extra,
        pending: outcome.pending,
        waitlisted: outcome.waitlisted,
      };
    });
  } catch (error) {
    console.error('extra seat request failed:', error);
    return { error: 'Something went wrong and nothing was requested. Please try again.' };
  }
}
