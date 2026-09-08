import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { promoteSeats, segmentPool, type SegmentPool } from '@/db/allocation';
import { writeAuditLog } from '@/lib/audit';
import { preselect, type Preselection } from './preselect';

/**
 * The extras review screen and its commit (spec/allocation.md §7.5).
 *
 * > Commit runs in one transaction, moves granted rows to `CONFIRMED`, leaves
 * > the rest `WAITLIST`, and **queues** the resulting emails without sending.
 *
 * Scoped to one segment, because allocation is computed per segment and a
 * screen spanning two would be showing one pool while spending another (§7.1).
 *
 * **Preselection recommends; the admin decides.** {@link loadReviewQueue}
 * returns the strict-FCFS walk as a starting point, and the admin is free to
 * tick past it — the row is flagged, the header shows the overage, and only a
 * commit past the segment's or the hall's capacity needs the typed confirmation
 * (§7.5). What the walk is authoritative about is *order*, never authority.
 */

export type ReviewRequest = {
  registrationId: number;
  requestedAt: Date;
  roundLabel: string | null;
  playerName: string | null;
  contactName: string;
  contactEmail: string | null;
  /** Seats awaiting review — the number the walk spends the pool on. */
  seatsRequested: number;
  /** Seats this registration already holds, so a player's base seat is visible. */
  seatsConfirmed: number;
  /** The names on the pending seats, placeholders included (§7.5's column). */
  guestNames: string[];
};

export type ReviewQueue = {
  segment: { id: number; name: string; showId: number; showName: string };
  pool: SegmentPool;
  allowPartialGrant: boolean;
  requests: ReviewRequest[];
  /** The FCFS recommendation, in walk order. */
  preselection: Preselection;
};

/**
 * Everything the review screen renders, for one segment.
 *
 * Ordered by `requested_at`, then id — the FCFS key of §7.4, never
 * `created_at`. An import run a week after the form closed must preserve the
 * order people actually asked in, and with two registration rounds that matters
 * more, not less.
 */
export async function loadReviewQueue(segmentId: number): Promise<ReviewQueue> {
  try {
    const segments = await getDb().execute<{
      id: string;
      name: string;
      show_id: string;
      show_name: string;
      allow_partial: boolean | null;
    }>(sql`
      select g.id, g.name, g.show_id, s.name as show_name,
             (resolve_setting('allocation.allow_partial_grant', g.id) #>> '{}')::boolean
               as allow_partial
        from show_segments g
        join shows s on s.id = g.show_id
       where g.id = ${segmentId}
         and g.deleted_at is null
    `);
    if (segments.length === 0) throw new Error('That segment no longer exists.');
    const segment = segments[0];

    const rows = await getDb().execute<{
      id: string;
      requested_at: string;
      round_label: string | null;
      player_name: string | null;
      contact_name: string;
      contact_email: string | null;
      pending_seats: number;
      confirmed_seats: number;
      guest_names: string[];
    }>(sql`
      select r.id,
             r.requested_at,
             r.round_label,
             p.full_name as player_name,
             r.contact_name,
             r.contact_email,
             count(*) filter (where a.status = 'PENDING_REVIEW')::int as pending_seats,
             count(*) filter (where a.status = 'CONFIRMED')::int      as confirmed_seats,
             coalesce(
               array_agg(a.full_name order by a.id)
                 filter (where a.status = 'PENDING_REVIEW'),
               '{}') as guest_names
        from registrations r
        join attendees a
          on a.registration_id = r.id
         and a.deleted_at is null
        left join players p on p.id = r.player_id
       where r.segment_id = ${segmentId}
         and r.deleted_at is null
         and r.status <> 'CANCELLED'
       group by r.id, p.full_name
      having count(*) filter (where a.status = 'PENDING_REVIEW') > 0
       order by r.requested_at, r.id
    `);

    const requests: ReviewRequest[] = rows.map((row) => ({
      registrationId: Number(row.id),
      requestedAt: new Date(row.requested_at),
      roundLabel: row.round_label,
      playerName: row.player_name,
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      seatsRequested: row.pending_seats,
      seatsConfirmed: row.confirmed_seats,
      guestNames: row.guest_names ?? [],
    }));

    const pool = await segmentPool(segmentId);
    const allowPartialGrant = segment.allow_partial === true;

    return {
      segment: {
        id: Number(segment.id),
        name: segment.name,
        showId: Number(segment.show_id),
        showName: segment.show_name,
      },
      pool,
      allowPartialGrant,
      requests,
      preselection: preselect(
        requests.map((r) => ({
          registrationId: r.registrationId,
          requestedAt: r.requestedAt,
          seats: r.seatsRequested,
        })),
        pool.extras_pool,
        allowPartialGrant,
      ),
    };
  } catch (error) {
    rethrowDbError(error);
  }
}

/** One row of the admin's decision: how many of this party's pending seats to grant. */
export type ReviewDecision = { registrationId: number; granted: number };

export type CommitResult = {
  confirmed: number;
  waitlisted: number;
  registrations: number;
  /** Set when a ceiling refused the commit and nothing was written. */
  refused: string | null;
};

/**
 * Commit the review, in one transaction (§7.5).
 *
 * **Only the registrations named in `decisions` are resolved.** The screen
 * sends every row it displayed, and anything granted becomes `CONFIRMED` while
 * the rest of *those* rows become `WAITLIST`. A request that arrived between the
 * screen loading and the admin pressing commit is left pending rather than
 * silently waitlisted on a decision nobody made about it.
 *
 * **All or nothing.** The seats go to `promote_seats()` in a single call, so
 * they are decided under one show lock against counts re-read there. If the
 * ceiling refuses, nothing is written and the reason comes back for the screen
 * to render — the admin reduces the selection or takes the override. A partial
 * commit would leave the number the admin was shown and the number the database
 * holds disagreeing, which is the one outcome a batch grant must not produce.
 *
 * **Emails are not queued here.** §7.5 says commit queues the resulting
 * messages without sending, and `email.md` §11.2 says the rows are rendered into
 * `DRAFT` for a human to review — but rendering `extras_granted` and
 * `extras_declined` needs the templates, the merge context and the attachment
 * shape that module `F` owns (`modules.md` §3). Writing half of that here would
 * mean either an outbox row with no rendered body, which the dispatcher cannot
 * send, or a second renderer for `F` to reconcile with. The outbox is keyed on
 * `(registration_id, template_key)` and this transaction leaves that key intact,
 * so `F` queues from the committed state with the filtered insert of §11.4 and
 * nothing here has to be undone.
 */
export async function commitReview(
  segmentId: number,
  decisions: readonly ReviewDecision[],
  options: { override?: boolean; reason?: string | null; actorId: string | null },
): Promise<CommitResult> {
  const named = decisions.filter((d) => Number.isSafeInteger(d.registrationId));
  if (named.length === 0) {
    return { confirmed: 0, waitlisted: 0, registrations: 0, refused: null };
  }

  try {
    return await getDb().transaction(async (tx) => {
      const ids = named.map((d) => d.registrationId);

      /**
       * The pending seats, re-read here rather than taken from the screen.
       * Ordered by id so "grant 2 of 4" always means the same two seats, and a
       * commit repeated after a refusal decides identically.
       */
      const pending = await tx.execute<{ id: string; registration_id: string }>(sql`
        select a.id, a.registration_id
          from attendees a
          join registrations r on r.id = a.registration_id
         where a.segment_id = ${segmentId}
           and a.status = 'PENDING_REVIEW'
           and a.deleted_at is null
           and r.deleted_at is null
           and r.status <> 'CANCELLED'
           and r.id in (${sql.join(
             ids.map((id) => sql`${id}`),
             sql`, `,
           )})
         order by a.registration_id, a.id
      `);

      const byRegistration = new Map<number, number[]>();
      for (const row of pending) {
        const key = Number(row.registration_id);
        const list = byRegistration.get(key) ?? [];
        list.push(Number(row.id));
        byRegistration.set(key, list);
      }

      const toConfirm: number[] = [];
      const toWaitlist: number[] = [];
      for (const decision of named) {
        const seats = byRegistration.get(decision.registrationId) ?? [];
        // Clamped to what is actually pending: a stale screen asking for more
        // seats than the party still has must not reach past them.
        const granted = Math.max(0, Math.min(decision.granted, seats.length));
        toConfirm.push(...seats.slice(0, granted));
        toWaitlist.push(...seats.slice(granted));
      }

      const outcome =
        toConfirm.length > 0
          ? await promoteSeats(segmentId, toConfirm, {
              override: options.override,
              executor: tx,
            })
          : { confirmed: 0, skipped: 0, refused: false, reason: null };

      if (outcome.refused) {
        // Nothing written: the WAITLIST half has not run, and returning rather
        // than throwing keeps the reason attached to a result the screen can
        // render beside the numbers it is already showing.
        return {
          confirmed: 0,
          waitlisted: 0,
          registrations: 0,
          refused: outcome.reason,
        };
      }

      if (toWaitlist.length > 0) {
        await tx.execute(sql`
          update attendees set status = 'WAITLIST'
           where id in (${sql.join(
             toWaitlist.map((id) => sql`${id}`),
             sql`, `,
           )})
        `);
      }

      // Each party's own status follows its seats: confirmed if it got any,
      // otherwise waitlisted. Done in one statement over the named ids rather
      // than a round trip each.
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
         where r.id in (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})
           and r.status <> 'CANCELLED'
           and r.deleted_at is null
      `);

      // On the transaction: a read on the pooled client would wait for the
      // connection this transaction holds (`max: 1`) and deadlock against itself.
      const pool = await segmentPool(segmentId, { executor: tx });

      /**
       * The record §7.5 asks for. Written inside the transaction and with an
       * explicit actor: a log on another connection would survive a rollback of
       * the thing it describes, and resolving the actor here would issue a
       * second query against a `max: 1` pool and deadlock against this
       * transaction.
       */
      await writeAuditLog(
        {
          action: options.override
            ? 'extras_review.committed_over_capacity'
            : 'extras_review.committed',
          entityType: 'show_segment',
          entityId: segmentId,
          before: { extras_pool: pool.extras_pool },
          after: {
            confirmed: outcome.confirmed,
            waitlisted: toWaitlist.length,
            registrations: named.length,
            over: pool.over,
          },
          reason: options.reason ?? null,
          actorId: options.actorId,
        },
        tx,
      );

      return {
        confirmed: outcome.confirmed,
        waitlisted: toWaitlist.length,
        registrations: named.length,
        refused: null,
      };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}
