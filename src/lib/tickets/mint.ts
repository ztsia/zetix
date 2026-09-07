import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { pgError, rethrowDbError } from '@/db/errors';
import {
  DEFAULT_TICKET_CODE_PREFIX,
  generateQrToken,
  generateTicketCode,
} from './identifiers';

/**
 * Assigning `ticket_code` and `qr_token` to attendees that have none.
 *
 * **This is a one-way door.** `qr_token` is immutable for the life of the
 * attendee (spec/tickets.md §10.1 rule 3, decision 28): a guest who kept the
 * first printed copy must still get through, so a reissue re-renders the PDF
 * and may repin the template version, but never mints a new token. Every
 * statement here therefore carries `where qr_token is null`, which makes
 * overwriting one structurally impossible rather than merely unintended.
 *
 * Attendees are **not** written by hand generally — F1's
 * `attendees_via_claim_seats` trigger refuses direct inserts, and
 * `attendees_promotion_guard` refuses a bare promotion to CONFIRMED. Neither
 * covers the columns here, and deliberately: minting takes no seat and changes
 * no count, so it needs no `zetix.granting` bypass. If a future guard does cover
 * them, that flag is the documented way through and its absence here would show
 * up as an immediate, loud failure rather than a silent one.
 */

/**
 * Attempts before giving up on a collision.
 *
 * Four Crockford symbols is a ~1.05M space, so at this concert's scale a single
 * collision is a low-percentage event and two in a row is vanishingly unlikely;
 * `qr_token` has 128 bits and will not collide at all. Five is not tuning — it
 * is "enough that exhausting it means something is actually wrong", e.g. a
 * `random` that stopped being random, which should surface as an error rather
 * than as an infinite loop on the night before a blast.
 */
const MAX_ATTEMPTS = 5;

export type MintResult = {
  /** Attendees that received identifiers on this call. */
  minted: number;
  /** Attendees that already had them, and were therefore left untouched. */
  alreadyIssued: number;
  /** How many statements it took. Above 1 means a collision was retried. */
  attempts: number;
};

export type MintScope = {
  showId?: number;
  segmentId?: number;
  attendeeIds?: number[];
};

/**
 * Mint identifiers for every attendee in scope that lacks them.
 *
 * Idempotent by construction: a second call mints nothing, because the only
 * rows it touches are those with a null `qr_token`. Pressing the button twice
 * is harmless, which matters — this is the step before a blast, and the blast
 * is the irreversible one.
 */
export async function mintIdentifiers(
  scope: MintScope,
  options: { prefix?: string } = {},
): Promise<MintResult> {
  const prefix = options.prefix ?? DEFAULT_TICKET_CODE_PREFIX;
  const db = getDb();

  const pending = await selectPending(scope);
  const alreadyIssued = await countIssued(scope);
  if (pending.length === 0) return { minted: 0, alreadyIssued, attempts: 0 };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rows = pending.map((id) => ({
      id,
      code: generateTicketCode(prefix),
      token: generateQrToken(),
    }));

    try {
      /**
       * One statement for the whole set rather than a row at a time: a blast
       * covers hundreds of attendees, and hundreds of round trips through the
       * Supabase pooler is the difference between an admin action and a
       * timeout. A unique violation aborts the statement, so a collision costs
       * a full retry with fresh values — which is the right trade when
       * collisions are a low-percentage event and round trips are not.
       *
       * `where a.qr_token is null` appears again here, not only in the select
       * above: between the two, another request could have minted the same
       * rows. Without it, this would overwrite a token that may already be on
       * a printed ticket.
       */
      const updated = await db.execute<{ id: string }>(sql`
        update attendees a
           set ticket_code = v.code,
               qr_token = v.token
          from (values ${sql.join(
            rows.map((r) => sql`(${r.id}::bigint, ${r.code}::text, ${r.token}::text)`),
            sql`, `,
          )}) as v(id, code, token)
         where a.id = v.id
           and a.qr_token is null
        returning a.id
      `);

      return { minted: updated.length, alreadyIssued, attempts: attempt };
    } catch (error) {
      // 23505 = unique_violation. Anything else is not a collision and must not
      // be retried — retrying a permissions or constraint error just delays a
      // real failure and muddies the message the admin eventually sees.
      if (pgError(error)?.code !== '23505' || attempt === MAX_ATTEMPTS) {
        rethrowDbError(error);
      }
    }
  }

  // Unreachable: the loop either returns or rethrows on its final attempt.
  throw new Error(`Could not mint unique identifiers in ${MAX_ATTEMPTS} attempts.`);
}

/** Attendee ids in scope that still need identifiers. */
async function selectPending(scope: MintScope): Promise<number[]> {
  const rows = await getDb().execute<{ id: string }>(sql`
    select a.id
      from attendees a
      join registrations r on r.id = a.registration_id
     where a.qr_token is null
       and ${scopeFilter(scope)}
       and ${ticketable()}
     order by a.id
  `);
  return rows.map((r) => Number(r.id));
}

/** Attendees in scope that already hold identifiers. */
async function countIssued(scope: MintScope): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n
      from attendees a
      join registrations r on r.id = a.registration_id
     where a.qr_token is not null
       and ${scopeFilter(scope)}
       and ${ticketable()}
  `);
  return rows[0]?.n ?? 0;
}

/**
 * Who gets a ticket.
 *
 * CONFIRMED only, and neither the attendee nor its registration soft-deleted.
 * A `WAITLIST` or `PENDING_REVIEW` row has no seat yet (spec/allocation.md
 * §7.5), and minting one a code would put a scannable ticket in the outbox for
 * a seat nobody granted.
 *
 * A **cancelled registration keeps** whatever it was already issued — nothing
 * here clears a token, and `ticket_sent_at` survives cancellation on purpose so
 * the door can say "cancelled — refer to desk" rather than "not found"
 * (spec/allocation.md §7.9). It simply stops being minted anything new.
 */
function ticketable() {
  return sql`
    a.status = 'CONFIRMED'
    and a.deleted_at is null
    and r.deleted_at is null
    and r.status <> 'CANCELLED'
  `;
}

function scopeFilter(scope: MintScope) {
  const clauses = [];
  if (scope.showId !== undefined) clauses.push(sql`a.show_id = ${scope.showId}`);
  if (scope.segmentId !== undefined) clauses.push(sql`a.segment_id = ${scope.segmentId}`);
  if (scope.attendeeIds !== undefined) {
    // An empty list must match nothing, not everything. `in ()` is a syntax
    // error in Postgres, so it becomes a false literal.
    clauses.push(
      scope.attendeeIds.length === 0
        ? sql`false`
        : sql`a.id in ${sql`(${sql.join(
            scope.attendeeIds.map((id) => sql`${id}`),
            sql`, `,
          )})`}`,
    );
  }
  // No scope at all would mint across every concert in the database. That is
  // never what a caller means, and the failure is silent and wide.
  if (clauses.length === 0) {
    throw new Error('mintIdentifiers needs a scope: showId, segmentId or attendeeIds.');
  }
  return sql.join(clauses, sql` and `);
}
