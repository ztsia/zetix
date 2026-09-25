import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import type { Tx } from '@/db/tx';
import {
  claimSeats,
  lockShowForClaim,
  promoteSeats,
  type AllocationType,
  type Executor,
  type SeatRequest,
} from '@/db/allocation';
import { flagReissueForChangedFields } from '@/lib/tickets/issue';

/**
 * Manual and late registrations, and cancellation
 * (spec/allocation.md §7.6, §7.9).
 *
 * > Players registering after the form closes are expected, not exceptional.
 *
 * Everything here is the admin doing by hand what a form would otherwise do,
 * and the rules that shape it are the same three every time:
 *
 * **Seats are never written directly.** Creating a registration and adding a
 * guest go through `claim_seats()`; restoring a cancelled one goes through
 * `promote_seats()`. Both hold the show lock and check the ceilings, so a
 * manual action cannot leave the §7.2 counters disagreeing with the room
 * (§7.6). The database refuses the alternative outright.
 *
 * **Only the hall ceiling is overridable, and only deliberately.** `override`
 * reaches the engine as `p_override`; the typed confirmation and the
 * `audit_log` row belong to the caller, which is the Server Action.
 *
 * **A changed ticket is flagged, never silently diverged** (spec/tickets.md
 * §10.6). Renaming an attendee or moving them to another show changes a field
 * printed on a PDF that may already be in somebody's inbox, so those edits set
 * `needs_reissue` for exactly the attendees whose pinned template prints the
 * field that changed.
 */

/** What the caller must prove it meant, for anything that can overfill a room. */
export type Override = {
  /** True once the admin has typed the confirmation (§7.5, §7.6). */
  override?: boolean;
};

export type { Tx };

/**
 * Where a mutation runs: the caller's transaction, or its own.
 *
 * V3's commands (spec/v3.md §23.1) work one row per transaction the runner
 * opens, so every mutation here can join that transaction instead of opening a
 * second one — which on the `max: 1` pool would wait for the connection the
 * runner's transaction holds and deadlock against it. A Server Action that
 * calls a mutation on its own still gets a transaction of its own.
 */
export type InTx = { executor?: Tx };

function within<T>(executor: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return executor ? fn(executor) : getDb().transaction(fn);
}

export type NewSeat = {
  fullName?: string | null;
  email?: string | null;
  allocationType: AllocationType;
};

export type CreateRegistrationInput = Override & {
  segmentId: number;
  contactName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  playerId?: number | null;
  roundLabel?: string | null;
  /**
   * The FCFS ordering key (§7.4). Defaults to now for a registration taken over
   * the phone, but an admin entering a form response that arrived earlier
   * should say when it arrived — the extras review walks in this order, and a
   * late-entered request that claims to have arrived now goes to the back of a
   * queue it should be in the middle of.
   */
  requestedAt?: Date | null;
  seats: NewSeat[];
  createdBy?: string | null;
};

export type CreateRegistrationResult = {
  registrationId: number;
  granted: { base: number; extra: number; other: number };
  pending: number;
  waitlisted: number;
};

const seatRequests = (seats: readonly NewSeat[]): SeatRequest[] =>
  seats.map((seat) => ({
    fullName: seat.fullName ?? null,
    email: seat.email ?? null,
    allocationType: seat.allocationType,
  }));

/**
 * The segment's show, and the concert behind it.
 *
 * Every mutation here takes a segment or a registration and derives the rest.
 * `show_id` is never accepted from a caller: `registrations` carries both ids
 * and the composite foreign key would reject a mismatched pair anyway, so
 * taking it from the request body only creates a way to be told a lie that the
 * database then has to catch (spec/domain.md §5.2).
 */
async function segmentContext(
  tx: Executor,
  segmentId: number,
): Promise<{ showId: number; concertId: number; audienceMode: string; name: string }> {
  const rows = await tx.execute<{
    show_id: string;
    concert_id: string;
    audience_mode: string;
    name: string;
  }>(sql`
    select g.show_id, s.concert_id, g.audience_mode, g.name
      from show_segments g
      join shows s on s.id = g.show_id
     where g.id = ${segmentId}
       and g.deleted_at is null
  `);
  if (rows.length === 0) throw new Error('That segment no longer exists.');
  return {
    showId: Number(rows[0].show_id),
    concertId: Number(rows[0].concert_id),
    audienceMode: rows[0].audience_mode,
    name: rows[0].name,
  };
}

/**
 * Bring `registrations.status` back in line with the seats hanging off it.
 *
 * A registration is not a seat and has no status of its own to grant — it
 * reflects its party (the same rule module `C` applies at import, from the
 * engine's outcome rather than from the rows). Confirmed if any seat is
 * confirmed; otherwise pending if any is held for review; otherwise waitlisted.
 *
 * Derived from the rows rather than from a claim outcome because the mutations
 * here change a party that already exists: adding a guest to a confirmed
 * registration must not demote it because the new seat waitlisted.
 *
 * **`CANCELLED` is never recomputed away.** Cancelling is a decision about the
 * booking, not a summary of its seats, and the cascade has already set every
 * seat to match.
 */
export async function recomputeStatus(tx: Executor, registrationId: number): Promise<void> {
  await tx.execute(sql`
    update registrations r
       set status = case
             when exists (
               select 1 from attendees a
                where a.registration_id = r.id
                  and a.status = 'CONFIRMED'
                  and a.deleted_at is null) then 'CONFIRMED'
             when exists (
               select 1 from attendees a
                where a.registration_id = r.id
                  and a.status = 'PENDING_REVIEW'
                  and a.deleted_at is null) then 'PENDING_REVIEW'
             else 'WAITLIST'
           end::booking_status
     where r.id = ${registrationId}
       and r.status <> 'CANCELLED'
       and r.deleted_at is null
  `);
}

/**
 * Create a registration by hand, against any segment, bypassing form windows
 * (§7.6).
 *
 * Nothing here reads `registration_forms`: whether a form is open, closed or
 * absent is a question about self-service registration, and this is the admin
 * entering a party that reached them another way — after the cutoff, over the
 * phone, at the door. That is the whole point of the screen.
 *
 * The seats still go through `claim_seats()`, so what the party actually gets
 * is the engine's decision under the current pool, deadline and policy: base
 * seats confirm while the player is owed them, extras hold for review in a
 * `REVIEW` segment, and anything that does not fit waitlists.
 */
export async function createRegistration(
  input: CreateRegistrationInput,
  options: InTx = {},
): Promise<CreateRegistrationResult> {
  if (input.seats.length === 0) {
    throw new Error('A registration needs at least one seat.');
  }

  try {
    return await within(options.executor, async (tx) => {
      const { showId } = await segmentContext(tx, input.segmentId);

      /**
       * **The hall lock, before the insert below references the show.**
       *
       * Same hazard the public submit path has: the `registrations` insert takes
       * `FOR KEY SHARE` on the `shows` row through its FK, and `claim_seats()`
       * then asks to upgrade that to `FOR UPDATE` — so two concurrent callers
       * deadlock with `40P01` instead of queueing (`allocation.md` §7.8).
       *
       * Contention is lower here than on a public form — this is an admin
       * screen — but "lower" is not "none": two committee members entering
       * late registrations at once is an ordinary evening, and an import runs
       * through the same engine. Found by a QA pass on module `M`; fixed here
       * too rather than left as the same bug in the other caller.
       */
      await lockShowForClaim(showId, tx);

      const rows = await tx.execute<{ id: string }>(sql`
        insert into registrations (
          show_id, segment_id, round_label, player_id, source,
          contact_name, contact_email, contact_phone, status, requested_at,
          created_by, approved_at, approved_by
        ) values (
          ${showId}, ${input.segmentId}, ${input.roundLabel ?? null},
          ${input.playerId ?? null}, 'ADMIN',
          ${input.contactName}, ${input.contactEmail ?? null},
          ${input.contactPhone ?? null},
          -- A placeholder, corrected from the seats a moment later in this same
          -- transaction. claim_seats() refuses a CANCELLED registration, so it
          -- has to be one of the other three, and WAITLIST is the one that is
          -- wrong in the safe direction: a party holding nothing rather than a
          -- party recorded as confirmed with no seats.
          'WAITLIST',
          ${(input.requestedAt ?? new Date()).toISOString()}::timestamptz,
          ${input.createdBy ?? null},
          -- Admin-created parties are approved on creation (spec/v3.md §25.4):
          -- the person entering them is the reviewer.
          now(), ${input.createdBy ?? null}
        )
        returning id
      `);
      const registrationId = Number(rows[0].id);

      const outcome = await claimSeats(
        input.segmentId,
        registrationId,
        seatRequests(input.seats),
        { override: input.override, executor: tx },
      );

      await recomputeStatus(tx, registrationId);

      return {
        registrationId,
        granted: {
          base: outcome.granted_base,
          extra: outcome.granted_extra,
          other: outcome.granted_other,
        },
        pending: outcome.pending,
        waitlisted: outcome.waitlisted,
      };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

export type RegistrationDetails = {
  contactName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  playerId?: number | null;
  roundLabel?: string | null;
  requestedAt?: Date | null;
  /**
   * The §24.6 verdict on `contactEmail` (`addressIssue()`), checked by the
   * caller before the transaction, since the MX lookup is a network call.
   * Stored only when the address actually changed.
   */
  emailIssue?: string | null;
};

export type DetailsResult = {
  emailChanged: boolean;
  /** Pending messages moved to the new address (spec/v3.md §24.3). */
  readdressed: number;
  /** Pending messages withdrawn because the address was cleared and they have nowhere to go. */
  withdrawn: number;
  /** Seats whose tickets already went to the old address — the record's resend question. */
  deliveredToOld: number;
  /** The contact as it was, for the caller's audit row. */
  before: { contactName: string; contactEmail: string | null } | null;
};

/**
 * Edit the registration itself: contact details, the player link, the round,
 * and the FCFS timestamp (§7.6).
 *
 * No seat moves, so no ceiling is involved and nothing needs the engine.
 *
 * `registration.contact_name` is a ticket binding — it is what a placeholder
 * seat prints as "Guest of {contact_name}" (decision 32) — so correcting it
 * after tickets have gone out flags those seats for reissue (§10.6).
 *
 * **A changed contact email re-addresses the party's pending messages in the
 * same transaction** (spec/v3.md §24.3): a draft or queued message would
 * otherwise go to the address the admin just corrected. A cleared email
 * withdraws them instead — there is nowhere left to send them. A `SENDING` message is
 * the dispatcher's and a `SENT` one is history; neither is rewritten. The
 * address check's result is stored with it, so `SUSPICIOUS_ADDRESS` follows the
 * new address (§24.6).
 */
export async function updateRegistrationDetails(
  registrationId: number,
  details: RegistrationDetails,
  options: InTx = {},
): Promise<DetailsResult> {
  try {
    return await within(options.executor, async (db) => {
      const before = await db.execute<{ contact_name: string; contact_email: string | null }>(sql`
        select contact_name, contact_email::text as contact_email
          from registrations where id = ${registrationId} for update
      `);
      const newEmail = details.contactEmail ?? null;
      const emailChanged =
        before.length > 0 &&
        (before[0].contact_email ?? '').toLowerCase() !== (newEmail ?? '').toLowerCase();

      await db.execute(sql`
        update registrations
           set contact_name  = ${details.contactName},
               contact_email = ${newEmail},
               contact_phone = ${details.contactPhone ?? null},
               player_id     = ${details.playerId ?? null},
               round_label   = ${details.roundLabel ?? null},
               requested_at  = coalesce(
                 ${details.requestedAt ? details.requestedAt.toISOString() : null}::timestamptz,
                 requested_at)
         where id = ${registrationId}
           and deleted_at is null
      `);

      let readdressed = 0;
      let withdrawn = 0;
      let deliveredToOld = 0;
      if (emailChanged) {
        await db.execute(sql`
          update registrations
             set email_issue = ${newEmail ? (details.emailIssue ?? null) : null},
                 email_checked_at = ${newEmail && details.emailIssue !== undefined ? sql`now()` : sql`null`},
                 email_issue_accepted_at = null
           where id = ${registrationId}
        `);
        if (newEmail) {
          const moved = await db.execute<{ id: string }>(sql`
            update email_outbox set to_email = ${newEmail}
             where registration_id = ${registrationId}
               and status in ('DRAFT', 'QUEUED')
            returning id
          `);
          readdressed = moved.length;
        } else {
          // Cleared: a pending message has no address left to go to, and must
          // not go to the old one the admin just removed.
          const cancelled = await db.execute<{ id: string }>(sql`
            update email_outbox set status = 'CANCELLED'
             where registration_id = ${registrationId}
               and status in ('DRAFT', 'QUEUED')
            returning id
          `);
          withdrawn = cancelled.length;
        }
        const [delivered] = await db.execute<{ n: number }>(sql`
          select count(*)::int as n from attendees
           where registration_id = ${registrationId} and deleted_at is null
             and status = 'CONFIRMED' and ticket_sent_at is not null
        `);
        deliveredToOld = delivered?.n ?? 0;
      }

      if (before.length > 0 && before[0].contact_name !== details.contactName) {
        await flagReissueForChangedFields(
          await attendeeIdsOf(registrationId, db),
          ['registration.contact_name'],
          db,
        );
      }
      return {
        emailChanged,
        readdressed,
        withdrawn,
        deliveredToOld,
        before: before[0]
          ? { contactName: before[0].contact_name, contactEmail: before[0].contact_email }
          : null,
      };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

async function attendeeIdsOf(
  registrationId: number,
  executor: Executor = getDb(),
): Promise<number[]> {
  const rows = await executor.execute<{ id: string }>(sql`
    select id from attendees
     where registration_id = ${registrationId} and deleted_at is null
  `);
  return rows.map((row) => Number(row.id));
}

/**
 * Add seats to a party that already exists (§7.6's "add … attendees").
 *
 * Through `claim_seats()` like any other grant, so a guest added after the
 * segment filled waitlists rather than quietly appearing in a full room.
 *
 * The party's existing seats are untouched, which is what makes the added-guest
 * case in `email.md` §11.4 work: the new attendee's `ticket_sent_at` is null, so
 * the next blast re-sends that registration's message carrying every PDF it now
 * holds.
 */
export async function addAttendees(
  registrationId: number,
  seats: NewSeat[],
  options: Override & InTx = {},
): Promise<{ confirmed: number; pending: number; waitlisted: number }> {
  if (seats.length === 0) throw new Error('Add at least one seat.');

  try {
    return await within(options.executor, async (tx) => {
      const rows = await tx.execute<{ segment_id: string; status: string }>(sql`
        select segment_id, status from registrations
         where id = ${registrationId} and deleted_at is null
      `);
      if (rows.length === 0) throw new Error('That registration no longer exists.');
      if (rows[0].status === 'CANCELLED') {
        throw new Error(
          'This registration is cancelled, so it cannot be given seats. Restore it first (spec/allocation.md §7.9).',
        );
      }
      const segmentId = Number(rows[0].segment_id);

      const outcome = await claimSeats(segmentId, registrationId, seatRequests(seats), {
        override: options.override,
        executor: tx,
      });
      await recomputeStatus(tx, registrationId);

      return {
        confirmed: outcome.granted_base + outcome.granted_extra + outcome.granted_other,
        pending: outcome.pending,
        waitlisted: outcome.waitlisted,
      };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * Rename one seat (§7.6's "rename").
 *
 * A blank name is not an error — it reverts the seat to the generated
 * placeholder, "Guest of {contact_name}" with `name_source = PLACEHOLDER`
 * (decision 32). The door searches on that string and the renderer prints it,
 * so it is a real name, never a null.
 *
 * `attendee.full_name` is the binding most templates print, so a rename after
 * delivery flags a reissue (§10.6). The door is unaffected either way: check-in
 * matches on `qr_token`, which never changes.
 */
export async function renameAttendee(
  attendeeId: number,
  fullName: string | null,
  options: InTx = {},
): Promise<{ before: string | null }> {
  const trimmed = (fullName ?? '').trim();

  try {
    // One transaction: the rename and its reissue flag land together or not at
    // all, so a name can never change on a delivered ticket unflagged.
    return await within(options.executor, async (db) => {
      const [previous] = await db.execute<{ full_name: string }>(sql`
        select full_name from attendees where id = ${attendeeId} and deleted_at is null for update
      `);
      await db.execute(sql`
        update attendees a
           set full_name = coalesce(
                 nullif(${trimmed}, ''),
                 'Guest of ' || r.contact_name),
               name_source = case
                 when nullif(${trimmed}, '') is null then 'PLACEHOLDER'
                 else 'PROVIDED' end::name_source
          from registrations r
         where r.id = a.registration_id
           and a.id = ${attendeeId}
           and a.deleted_at is null
      `);
      await flagReissueForChangedFields([attendeeId], ['attendee.full_name'], db);
      return { before: previous?.full_name ?? null };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * Remove one seat (§7.6's "remove"), returning it to the segment immediately.
 *
 * A soft delete plus `CANCELLED`, never a `DELETE` (decision 7). The row keeps
 * its `qr_token` and its `ticket_sent_at`, for the same reason cancelling a
 * whole registration does: a ticket that was delivered was delivered, and the
 * door needs the code to still resolve so it can say "cancelled — refer to
 * desk" rather than "not found" (§7.9, `checkin.md` §12.1).
 */
export async function removeAttendee(attendeeId: number, options: InTx = {}): Promise<void> {
  try {
    await within(options.executor, async (tx) => {
      const rows = await tx.execute<{ registration_id: string }>(sql`
        update attendees
           set status = 'CANCELLED', deleted_at = now()
         where id = ${attendeeId}
           and deleted_at is null
        returning registration_id
      `);
      if (rows.length === 0) return;
      await recomputeStatus(tx, Number(rows[0].registration_id));
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

export type MoveResult = {
  /** Seats that moved with the registration. */
  movedSeats: number;
  /** True when the destination is a different hall, so tickets were flagged. */
  showChanged: boolean;
};

/**
 * Move a registration to another segment, in the same show or a different one
 * (§7.6).
 *
 * Parent and children move **in one transaction**, which is what
 * `attendees_registration_fk` is deferred for: updating either side alone
 * leaves the pair disagreeing about segment and show, and there is no ordering
 * that avoids it. Re-creating the attendees is not an option — `qr_token` is
 * immutable for life, and a guest holding a printed ticket must still get in
 * (decision 28, spec/domain.md §5.2).
 *
 * Three things the destination decides:
 *
 * - **Room.** `attendees_move_guard` re-checks the destination segment and hall
 *   at commit, and raises its own sentence naming the numbers — which the
 *   dialog renders verbatim, as every other guard's message is. With
 *   `override` the caller has typed the confirmation and owns the `audit_log`
 *   row (§7.6).
 * - **Allocation type.** A `BASE` seat means "part of a player's entitlement",
 *   and a `PUBLIC` segment owes nobody one — `segment_pool()` does not count
 *   base there at all (§7.2). Such seats become `EXTRA` on the way in, so the
 *   seat keeps its meaning rather than becoming a base claim against a segment
 *   with no players.
 * - **Reissue.** Moving to another show changes the date, the doors and the
 *   venue printed on the ticket, so delivered seats are flagged (§10.6).
 */
export async function moveRegistration(
  registrationId: number,
  destinationSegmentId: number,
  options: Override & InTx = {},
): Promise<MoveResult> {
  try {
    const result = await within(options.executor, async (tx) => {
      const current = await tx.execute<{
        show_id: string;
        segment_id: string;
        concert_id: string;
        status: string;
      }>(sql`
        select r.show_id, r.segment_id, s.concert_id, r.status
          from registrations r
          join shows s on s.id = r.show_id
         where r.id = ${registrationId}
           and r.deleted_at is null
      `);
      if (current.length === 0) throw new Error('That registration no longer exists.');

      const from = {
        showId: Number(current[0].show_id),
        segmentId: Number(current[0].segment_id),
        concertId: Number(current[0].concert_id),
      };
      const to = await segmentContext(tx, destinationSegmentId);

      if (from.segmentId === destinationSegmentId) {
        return { movedSeats: 0, showChanged: false };
      }

      /**
       * Within one concert. Players are concert-scoped (`domain.md` §5.1), so a
       * move across concerts would leave `player_id` pointing at somebody who
       * is entitled to nothing in the destination — `claim_seats()` treats such
       * a player as owed no base at all — and the ticket would carry another
       * concert's name. It is not an edit, it is a different registration.
       */
      if (to.concertId !== from.concertId) {
        throw new Error(
          'A registration can only move within its own concert. Create it again in the other concert instead.',
        );
      }

      // The override reaches the deferred move guard the same way it reaches
      // the engine: a transaction-local flag the guard checks (§7.6).
      if (options.override) {
        await tx.execute(sql`select set_config('zetix.granting', 'on', true)`);
      }

      await tx.execute(sql`
        update registrations
           set show_id = ${to.showId}, segment_id = ${destinationSegmentId}
         where id = ${registrationId}
      `);

      const moved = await tx.execute<{ id: string }>(sql`
        update attendees
           set show_id = ${to.showId},
               segment_id = ${destinationSegmentId},
               allocation_type = case
                 when ${to.audienceMode} = 'PUBLIC' and allocation_type = 'BASE'
                   then 'EXTRA'::allocation_type
                 else allocation_type end
         where registration_id = ${registrationId}
           and deleted_at is null
        returning id
      `);

      await recomputeStatus(tx, registrationId);

      return { movedSeats: moved.length, showChanged: to.showId !== from.showId };
    });

    if (result.showChanged) {
      const db = options.executor ?? getDb();
      await flagReissueForChangedFields(
        await attendeeIdsOf(registrationId, db),
        ['show.name', 'show.starts_at', 'show.doors_open_at', 'show.venue_name', 'show.venue_address'],
        db,
      );
    }

    return result;
  } catch (error) {
    rethrowDbError(error);
  }
}

export type CancelResult = {
  /** Confirmed seats this cancellation returned to the segment. */
  seatsFreed: number;
  /** Seats still waiting in that segment, for §7.9's "N seats freed, M waiting". */
  seatsWaiting: number;
  /** Pending outbox messages withdrawn. */
  outboxCancelled: number;
};

/**
 * Cancel a registration (§7.9).
 *
 * The seats return to the segment immediately — `segment_pool()` stops counting
 * a cancelled party, and 0001's cascade sets every attendee to match, so
 * nothing here has to walk them.
 *
 * Two things it deliberately does:
 *
 * **It cancels pending outbox rows.** A party that is no longer coming must not
 * receive the tickets queued for them. `SENDING` is left alone: that message is
 * in the dispatcher's hands and flipping it underneath would leave a sent email
 * recorded as cancelled.
 *
 * **It never clears `ticket_sent_at`.** A ticket that was delivered was
 * delivered. The door reads the code and needs to find it, so it can say
 * "cancelled — refer to desk" rather than "not found" (`checkin.md` §12.1) —
 * and clearing it would also put the party back in the pending bucket for the
 * next blast (`email.md` §11.4).
 *
 * Where a cancelled `BASE` seat goes needs no code and gets none: before the
 * deadline `base_claimed(p)` drops and the seat returns to that player's
 * entitlement; after it, `unclaimed_base` is zero and the seat lands in the
 * extras pool. Both fall out of the §7.2 formulas.
 */
export async function cancelRegistration(
  registrationId: number,
  options: InTx = {},
): Promise<CancelResult> {
  try {
    return await within(options.executor, async (tx) => {
      const rows = await tx.execute<{ segment_id: string; freed: number }>(sql`
        select r.segment_id,
               (select count(*)::int from attendees a
                 where a.registration_id = r.id
                   and a.status = 'CONFIRMED'
                   and a.deleted_at is null) as freed
          from registrations r
         where r.id = ${registrationId}
           and r.deleted_at is null
           and r.status <> 'CANCELLED'
      `);
      if (rows.length === 0) {
        return { seatsFreed: 0, seatsWaiting: 0, outboxCancelled: 0 };
      }
      const segmentId = Number(rows[0].segment_id);

      await tx.execute(sql`
        update registrations set status = 'CANCELLED' where id = ${registrationId}
      `);

      const withdrawn = await tx.execute<{ id: string }>(sql`
        update email_outbox
           set status = 'CANCELLED'
         where registration_id = ${registrationId}
           and status in ('DRAFT', 'QUEUED')
        returning id
      `);

      const waiting = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n
          from attendees a
          join registrations r on r.id = a.registration_id
         where a.segment_id = ${segmentId}
           and a.status in ('PENDING_REVIEW', 'WAITLIST')
           and a.deleted_at is null
           and r.deleted_at is null
           and r.status <> 'CANCELLED'
      `);

      return {
        seatsFreed: rows[0].freed,
        seatsWaiting: waiting[0].n,
        outboxCancelled: withdrawn.length,
      };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

export type DeleteResult = {
  /** Seats returned to the segment by the delete. */
  seatsFreed: number;
  /** Rows soft-deleted, so the confirmation can name the party. */
  attendeesDeleted: number;
  /** Draft or queued messages withdrawn, so nothing is sent to a deleted party. */
  outboxCancelled: number;
};

/**
 * Thrown when a party has already been admitted, so a delete would rewrite
 * attendance rather than correct a mistake.
 */
export class AdmittedAttendeeError extends Error {
  constructor(readonly admitted: number) {
    super(
      `${admitted} of this party's guests ${admitted === 1 ? 'has' : 'have'} already been ` +
        'admitted. Revert the check-in on the check-in screen first, then delete — ' +
        'or cancel the registration instead, which keeps the record.',
    );
    this.name = 'AdmittedAttendeeError';
  }
}

/**
 * Delete a registration and its seats (§7.6's manual CRUD).
 *
 * **This is not "cancel".** The two are different facts and the system needs
 * both: a cancellation says a real booking is not coming — it frees seats,
 * stays in the record, and can be restored. A delete says the row should never
 * have existed: a duplicate import, a test party, an entry against the wrong
 * show. Only the second should vanish from the screens, and only the second is
 * reached by this.
 *
 * **The delete is soft** (decision 7): `deleted_at` is stamped and nothing is
 * removed. That is not merely a retention preference here — `qr_token` is
 * immutable for life (decision 28) and a hard delete would let Postgres hand
 * the same `ticket_code` out again, so a printed ticket in someone's pocket
 * could come to name a different guest.
 *
 * **The seats free themselves.** `claim_seats()`, `segment_pool()`,
 * `promote_seats()` and `manifest_for_show()` all filter
 * `a.deleted_at is null and r.deleted_at is null` already (`0001`, `0003`,
 * `0005`), so a deleted party stops occupying the segment and stops appearing
 * at the door without any of them being told. The count below is therefore
 * reported, not enacted.
 *
 * **Queued mail is withdrawn in the same transaction**, exactly as
 * {@link cancelRegistration} does. A draft left behind would be sent by the
 * next dispatcher run to a registrant whose booking the admin has just
 * deleted, carrying tickets for seats that no longer exist.
 *
 * @throws AdmittedAttendeeError when a seat holds a live check-in.
 */
export async function deleteRegistration(
  registrationId: number,
  options: InTx = {},
): Promise<DeleteResult> {
  try {
    return await within(options.executor, async (tx) => {
      const rows = await tx.execute<{ freed: number; admitted: number }>(sql`
        select (select count(*)::int from attendees a
                 where a.registration_id = r.id
                   and a.status = 'CONFIRMED'
                   and a.deleted_at is null) as freed,
               (select count(*)::int from check_ins ci
                  join attendees a on a.id = ci.attendee_id
                 where a.registration_id = r.id
                   and a.deleted_at is null
                   and ci.reverted_at is null) as admitted
          from registrations r
         where r.id = ${registrationId}
           and r.deleted_at is null
      `);
      if (rows.length === 0) {
        return { seatsFreed: 0, attendeesDeleted: 0, outboxCancelled: 0 };
      }

      /**
       * A guest who is physically inside the hall is not a row that should
       * never have existed. Refusing here rather than cascading keeps the
       * append-only check-in log honest (decision 7): deleting the attendee
       * would leave an admission referring to nobody, and the arrivals count
       * would silently drop a person the ushers actually saw.
       */
      if (rows[0].admitted > 0) throw new AdmittedAttendeeError(rows[0].admitted);

      const deleted = await tx.execute<{ id: string }>(sql`
        update attendees
           set deleted_at = now()
         where registration_id = ${registrationId}
           and deleted_at is null
        returning id
      `);

      await tx.execute(sql`
        update registrations set deleted_at = now() where id = ${registrationId}
      `);

      const withdrawn = await tx.execute<{ id: string }>(sql`
        update email_outbox
           set status = 'CANCELLED'
         where registration_id = ${registrationId}
           and status in ('DRAFT', 'QUEUED')
        returning id
      `);

      return {
        seatsFreed: rows[0].freed,
        attendeesDeleted: deleted.length,
        outboxCancelled: withdrawn.length,
      };
    });
  } catch (error) {
    if (error instanceof AdmittedAttendeeError) throw error;
    rethrowDbError(error);
  }
}

export type RestoreResult = {
  confirmed: number;
  pending: number;
  waitlisted: number;
  /** Set when the seats could not all come back; the engine's own sentence. */
  refused: string | null;
};

/**
 * Restore a cancelled registration (§7.6's "cancel and restore").
 *
 * **The seats are re-decided, not simply un-cancelled.** Time has passed and
 * the room may have been given away, so restoring asks the same questions
 * `claim_seats()` asks of a new party — but of the rows that already exist,
 * because their `qr_token`s must survive (decision 28):
 *
 * - Extras in a `REVIEW` segment go back to `PENDING_REVIEW`. They were never
 *   granted, they consume no seat, and the review screen is where they belong.
 * - Everything else is offered to `promote_seats()`, whole. If the room is
 *   gone, nothing is confirmed and the party comes back waitlisted with the
 *   database's sentence explaining why — the registration is restored either
 *   way, which is what the admin asked for.
 *
 * `override` confirms the seats regardless, for the case the admin means to
 * overfill (§7.6).
 */
export async function restoreRegistration(
  registrationId: number,
  options: Override & InTx = {},
): Promise<RestoreResult> {
  try {
    return await within(options.executor, async (tx) => {
      const rows = await tx.execute<{ segment_id: string }>(sql`
        select segment_id from registrations
         where id = ${registrationId}
           and deleted_at is null
           and status = 'CANCELLED'
      `);
      if (rows.length === 0) {
        throw new Error('That registration is not cancelled, so there is nothing to restore.');
      }
      const segmentId = Number(rows[0].segment_id);

      // Uncancelled first: `promote_seats()` will not touch a seat whose
      // registration is cancelled, and correctly so.
      await tx.execute(sql`
        update registrations set status = 'WAITLIST' where id = ${registrationId}
      `);

      const policy = await tx.execute<{ policy: string | null }>(sql`
        select (resolve_setting('allocation.extras_policy', ${segmentId}) #>> '{}') as policy
      `);
      const underReview = policy[0]?.policy === 'REVIEW';

      const seats = await tx.execute<{ id: string; allocation_type: string }>(sql`
        select id, allocation_type from attendees
         where registration_id = ${registrationId}
           and deleted_at is null
           and status = 'CANCELLED'
         order by id
      `);

      const holdForReview = underReview
        ? seats.filter((s) => s.allocation_type === 'EXTRA').map((s) => Number(s.id))
        : [];
      const toConfirm = seats
        .map((s) => Number(s.id))
        .filter((id) => !holdForReview.includes(id));

      if (holdForReview.length > 0) {
        await tx.execute(sql`
          update attendees set status = 'PENDING_REVIEW'
           where id in (${sql.join(
             holdForReview.map((id) => sql`${id}`),
             sql`, `,
           )})
        `);
      }

      const outcome =
        toConfirm.length > 0
          ? await promoteSeats(segmentId, toConfirm, {
              override: options.override,
              executor: tx,
            })
          : { confirmed: 0, skipped: 0, refused: false, reason: null };

      // Whatever did not come back confirmed is waiting, not cancelled: the
      // booking exists again, it simply holds no seat yet.
      const waitlisted = await tx.execute<{ id: string }>(sql`
        update attendees set status = 'WAITLIST'
         where registration_id = ${registrationId}
           and deleted_at is null
           and status = 'CANCELLED'
        returning id
      `);

      await recomputeStatus(tx, registrationId);

      return {
        confirmed: outcome.confirmed,
        pending: holdForReview.length,
        waitlisted: waitlisted.length,
        refused: outcome.refused ? outcome.reason : null,
      };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}
