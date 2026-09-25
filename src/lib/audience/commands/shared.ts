import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { segmentPool } from '@/db/allocation';
import type { BlastLine, CommandContext, Tx } from '@/lib/commands/define';
import { audienceFilterSchema, FLAG_LABEL, type Flag, type Stage } from '../filter';
import { matchPartyIds, matchSeatIds } from '../queries';

/**
 * What every Audience command shares (spec/v3.md §23.2): the filter, how rows
 * are found and locked, and the few sentences more than one command says.
 */

export const filter = audienceFilterSchema;
export const noParams = z.object({}).strict();
export const overrideParams = z.object({ override: z.boolean().default(false) }).strict();

export const idArray = (ids: number[]) => sql`${`{${ids.join(',')}}`}::bigint[]`;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export type PartyFacts = {
  id: number;
  label: string;
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  segmentId: number;
  showId: number;
  stage: Stage | null;
  flags: Flag[];
  approvedAt: string | null;
  needsVerification: boolean;
  emailVerifiedAt: string | null;
  contactEmail: string | null;
  confirmed: number;
  pending: number;
  waitlisted: number;
  live: number;
  delivered: number;
  admitted: number;
  /** When the party's earliest seat awaiting review asked, for the first-come walk. */
  firstPendingAt: string | null;
  firstWaitlistAt: string | null;
};

/**
 * The live parties behind `ids` in this concert, locked when a command is about
 * to change them. The lock is on `registrations` — the view cannot be locked —
 * and taken before the pipeline is read, so the counts are the ones the row's
 * transaction will act on.
 */
export async function partyFacts(
  tx: Tx,
  concertId: number,
  ids: number[],
  lock: boolean,
): Promise<Map<number, PartyFacts>> {
  if (ids.length === 0) return new Map();
  if (lock) {
    await tx.execute(sql`
      select r.id from registrations r
       where r.id = any(${idArray(ids)}) and r.deleted_at is null
       order by r.id
       for update
    `);
  }
  const rows = await tx.execute<{
    id: string;
    contact_name: string;
    status: PartyFacts['status'];
    segment_id: string;
    show_id: string;
    stage: Stage | null;
    flags: Flag[] | null;
    approved_at: string | null;
    needs_verification: boolean;
    email_verified_at: string | null;
    contact_email: string | null;
    confirmed_seats: number;
    pending_seats: number;
    waitlisted_seats: number;
    live_seats: number;
    delivered_seats: number;
    admitted_seats: number;
    first_pending_at: string | null;
    first_waitlist_at: string | null;
  }>(sql`
    select p.registration_id as id, p.contact_name, r.status, p.segment_id, p.show_id,
           p.stage, p.flags, p.approved_at::text as approved_at,
           (r.verification_token is not null) as needs_verification,
           r.email_verified_at::text as email_verified_at,
           r.contact_email::text as contact_email,
           p.confirmed_seats, p.pending_seats, p.waitlisted_seats, p.live_seats,
           p.delivered_seats, p.admitted_seats,
           (select min(a.requested_at)::text from attendees a
             where a.registration_id = r.id and a.deleted_at is null
               and a.status = 'PENDING_REVIEW') as first_pending_at,
           (select min(a.requested_at)::text from attendees a
             where a.registration_id = r.id and a.deleted_at is null
               and a.status = 'WAITLIST') as first_waitlist_at
      from party_pipeline p
      join registrations r on r.id = p.registration_id
     where p.registration_id = any(${idArray(ids)})
       and p.concert_id = ${concertId}
  `);
  return new Map(
    rows.map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        label: row.contact_name,
        status: row.status,
        segmentId: Number(row.segment_id),
        showId: Number(row.show_id),
        stage: row.stage,
        flags: row.flags ?? [],
        approvedAt: row.approved_at,
        needsVerification: row.needs_verification,
        emailVerifiedAt: row.email_verified_at,
        contactEmail: row.contact_email,
        confirmed: row.confirmed_seats,
        pending: row.pending_seats,
        waitlisted: row.waitlisted_seats,
        live: row.live_seats,
        delivered: row.delivered_seats,
        admitted: row.admitted_seats,
        firstPendingAt: row.first_pending_at,
        firstWaitlistAt: row.first_waitlist_at,
      },
    ]),
  );
}

/** A party-grain `match`: the filter's parties, first come first. */
export const matchParties = (tx: Tx, ctx: CommandContext<unknown>, f: z.infer<typeof filter>) =>
  matchPartyIds(tx, ctx.concertId, f);

/** A seat-grain `match`. */
export const matchSeats = (tx: Tx, ctx: CommandContext<unknown>, f: z.infer<typeof filter>) =>
  matchSeatIds(tx, ctx.concertId, f);

/**
 * Hand-ticked parties in first-come order, by the earliest seat of the kind
 * the command spends (§21.3): pending for Grant extras, waitlisted for Promote.
 */
export function orderParties(kind: 'pending' | 'waitlist') {
  return async (tx: Tx, ctx: CommandContext<unknown>, ids: number[]) => {
    const rows = await tx.execute<{ id: string }>(sql`
      select r.id from registrations r
        left join lateral (
          select min(a.requested_at) as at from attendees a
           where a.registration_id = r.id and a.deleted_at is null
             and a.status = ${kind === 'pending' ? 'PENDING_REVIEW' : 'WAITLIST'}
        ) s on true
       where r.id = any(${idArray(ids)})
       order by s.at nulls last, r.requested_at, r.id
    `);
    const ordered = rows.map((row) => Number(row.id));
    return [...ordered, ...ids.filter((id) => !ordered.includes(id))];
  };
}

// ---------------------------------------------------------------------------
// The first-come walk inside one run
// ---------------------------------------------------------------------------

/**
 * The prefix every "does not fit" skip carries, so a later row of the same run
 * can tell that the walk stopped (`allocation.md` §7.5: strict order, never
 * best-fit).
 */
export const NO_ROOM = 'Does not fit:';

/**
 * Whether an earlier row of this run, in the same segment, already failed to
 * fit. First come first served means the clock decides, not the packing: once
 * a party of four is turned away for want of room, a later party of two may
 * not take the seats it was refused. The override is the admin's way past it.
 */
export async function walkStopped(tx: Tx, runId: number, segmentId: number): Promise<boolean> {
  const [row] = await tx.execute<{ stopped: boolean }>(sql`
    select exists (
      select 1 from command_run_items i
        join registrations r on r.id = i.entity_id
       where i.run_id = ${runId}
         and i.status = 'SKIPPED'
         and i.outcome ->> 'reason' like ${`${NO_ROOM}%`}
         and r.segment_id = ${segmentId}) as stopped
  `);
  return row?.stopped ?? false;
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export type SeatFacts = {
  id: number;
  label: string;
  registrationId: number;
  segmentId: number;
  showId: number;
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  partyStatus: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  issued: boolean;
  hasToken: boolean;
  delivered: boolean;
  needsReissue: boolean;
  admitted: boolean;
};

export async function seatFacts(
  tx: Tx,
  concertId: number,
  ids: number[],
  lock: boolean,
): Promise<Map<number, SeatFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.execute<{
    id: string;
    full_name: string;
    contact_name: string;
    registration_id: string;
    segment_id: string;
    show_id: string;
    status: SeatFacts['status'];
    party_status: SeatFacts['partyStatus'];
    issued: boolean;
    has_token: boolean;
    delivered: boolean;
    needs_reissue: boolean;
    admitted: boolean;
  }>(sql`
    select a.id, a.full_name, r.contact_name, a.registration_id, a.segment_id, a.show_id,
           a.status, r.status as party_status,
           (a.qr_token is not null and a.ticket_template_id is not null) as issued,
           (a.qr_token is not null) as has_token,
           (a.ticket_sent_at is not null) as delivered,
           a.needs_reissue,
           exists (select 1 from check_ins c
                    where c.attendee_id = a.id and c.reverted_at is null) as admitted
      from attendees a
      join registrations r on r.id = a.registration_id
      join shows s on s.id = a.show_id
     where a.id = any(${idArray(ids)})
       and s.concert_id = ${concertId}
       and a.deleted_at is null
       and r.deleted_at is null
     ${lock ? sql`for update of a` : sql``}
  `);
  return new Map(
    rows.map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        label: `${row.full_name} (${row.contact_name})`,
        registrationId: Number(row.registration_id),
        segmentId: Number(row.segment_id),
        showId: Number(row.show_id),
        status: row.status,
        partyStatus: row.party_status,
        issued: row.issued,
        hasToken: row.has_token,
        delivered: row.delivered,
        needsReissue: row.needs_reissue,
        admitted: row.admitted,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Capacity, for previews (§23.5)
// ---------------------------------------------------------------------------

/**
 * "This puts the Public segment at 312 of 300" — the overage a run with the
 * override would cause, counted from `segment_pool()` before it happens.
 * `seatsBySegment` is how many seats the run would confirm in each segment.
 */
export async function capacityLines(
  tx: Tx,
  seatsBySegment: Map<number, number>,
  override: boolean,
): Promise<BlastLine[]> {
  const lines: BlastLine[] = [];
  for (const [segmentId, seats] of seatsBySegment) {
    if (seats === 0) continue;
    const pool = await segmentPool(segmentId, { executor: tx });
    const [segment] = await tx.execute<{ label: string }>(sql`
      select s.name || ' · ' || g.name as label
        from show_segments g join shows s on s.id = g.show_id where g.id = ${segmentId}
    `);
    const label = segment?.label ?? `segment ${segmentId}`;
    const after = pool.confirmed + seats;
    if (after > pool.sellable) {
      lines.push({
        count: seats,
        text: override
          ? `seats to confirm in ${label}. With the override this puts it at ${after} of ${pool.sellable}; the seats past capacity are flagged Over capacity.`
          : `seats to confirm in ${label}, which has ${Math.max(0, pool.open_seats)} open. Parties that do not fit are skipped, first come first; turn on the override to seat them anyway.`,
        tone: override ? 'danger' : 'warning',
      });
    } else {
      lines.push({
        count: seats,
        text: `seats to confirm in ${label}, which has ${pool.open_seats} open and ${pool.extras_pool} in the extras pool.`,
        tone: 'neutral',
      });
    }
  }
  return lines;
}

export function flagList(flags: Flag[]): string {
  return flags.map((flag) => FLAG_LABEL[flag]).join(', ');
}
