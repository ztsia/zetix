import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { promoteSeats } from '@/db/allocation';
import {
  defineCommand,
  SkipItem,
  type AnyCommand,
  type BlastLine,
  type CommandContext,
  type RunContext,
  type TargetRow,
  type Tx,
} from '@/lib/commands/define';
import { recomputeStatus, removeAttendee } from '@/lib/registrations/mutations';
import { generateQrToken, generateTicketCode, DEFAULT_TICKET_CODE_PREFIX } from '@/lib/tickets/identifiers';
import { mintIdentifiers } from '@/lib/tickets/mint';
import {
  NO_ROOM,
  capacityLines,
  filter,
  matchSeats,
  noParams,
  seatFacts,
  withdrawTicketMailIfUnseated,
  withdrawnNote,
  type SeatFacts,
} from './shared';

/**
 * The seat-grain commands of spec/v3.md §23.2 that are the Audience
 * workspace's: Tickets, Door, and the seat half of Records.
 *
 * They run over the Seats grain's selection, and the party record's per-seat
 * actions are the same commands over one id, so a seat is changed one way
 * whichever screen it was reached from.
 */

function seatCommand<P>(spec: {
  name: string;
  verb: string;
  irreversible?: boolean;
  params: z.ZodType<P>;
  skip: (seat: SeatFacts, ctx: CommandContext<P>) => string | null;
  blastRadius?: (tx: Tx, ctx: CommandContext<P>, seats: SeatFacts[]) => Promise<BlastLine[]>;
  apply: (tx: Tx, ctx: RunContext<P>, seat: SeatFacts) => Promise<Record<string, unknown>>;
}): AnyCommand {
  return defineCommand({
    name: spec.name,
    entityType: 'attendee',
    verb: spec.verb,
    noun: { one: 'seat', many: 'seats' },
    irreversible: spec.irreversible ?? false,
    filter,
    params: spec.params,
    match: matchSeats,
    async describe(tx, ctx, ids, { lock }) {
      const facts = await seatFacts(tx, ctx.concertId, ids, lock);
      return ids
        .filter((id) => facts.has(id))
        .map((id): TargetRow => {
          const seat = facts.get(id)!;
          return { id, label: seat.label, skip: spec.skip(seat, ctx) };
        });
    },
    blastRadius: spec.blastRadius
      ? async (tx, ctx, ids) =>
          spec.blastRadius!(tx, ctx, [...(await seatFacts(tx, ctx.concertId, ids, false)).values()])
      : undefined,
    async apply(tx, ctx, row) {
      const seat = (await seatFacts(tx, ctx.concertId, [row.id], false)).get(row.id);
      if (!seat) throw new SkipItem('No longer exists in this concert.');
      const outcome = await spec.apply(tx, ctx, seat);
      return JSON.parse(JSON.stringify({ label: row.label, ...outcome }));
    },
  });
}

const notTicketable = (seat: SeatFacts) =>
  seat.partyStatus === 'CANCELLED'
    ? 'Its party is cancelled.'
    : seat.status !== 'CONFIRMED'
      ? 'Only a confirmed seat holds a ticket.'
      : null;

/**
 * The ticket design a seat is issued with: the segment's default, then the
 * show's, then the concert's through the cascade, then the concert's seeded
 * default (`tickets.md` §10.5, v3 §24.2). Read in the row's own transaction.
 */
async function designFor(tx: Tx, seatId: number): Promise<{ id: number; version: number }> {
  const [row] = await tx.execute<{ id: string | null; version: number | null }>(sql`
    with seat as (
      select a.segment_id, a.show_id, s.concert_id, g.default_ticket_template_id, s.ticket_template_id
        from attendees a
        join shows s on s.id = a.show_id
        join show_segments g on g.id = a.segment_id
       where a.id = ${seatId}
    ),
    chosen as (
      select t.id, t.version, 1 as rank from seat
        join ticket_templates t on t.id = seat.default_ticket_template_id and t.deleted_at is null
      union all
      select t.id, t.version, 2 from seat
        join ticket_templates t on t.id = seat.ticket_template_id and t.deleted_at is null
      union all
      select t.id, t.version, 3 from seat
        join ticket_templates t
          on t.id = (resolve_setting('ticket.default_template_id', null, null, seat.concert_id)
                      #>> '{}')::bigint
         and t.deleted_at is null
      union all
      select t.id, t.version, 4 from seat
        join ticket_templates t on t.concert_id = seat.concert_id and t.is_default and t.deleted_at is null
    )
    select id, version from chosen order by rank, version desc limit 1
  `);
  if (!row?.id) {
    throw new Error('This concert has no ticket design yet. Open Ticket designs once to create the default.');
  }
  return { id: Number(row.id), version: row.version! };
}

// ---------------------------------------------------------------------------
// Tickets (tickets.md §10.5, §10.6)
// ---------------------------------------------------------------------------

/** **Issue**: mint the code and QR, and pin the design version. Idempotent. */
const issue = seatCommand({
  name: 'seats.issue',
  verb: 'Issue tickets for',
  params: noParams,
  skip: (seat) => notTicketable(seat) ?? (seat.issued ? 'Already issued.' : null),
  async apply(tx, ctx, seat) {
    await mintIdentifiers({ attendeeIds: [seat.id] }, { executor: tx });
    const design = await designFor(tx, seat.id);
    const pinned = await tx.execute(sql`
      update attendees
         set ticket_template_id = ${design.id}, ticket_template_version = ${design.version},
             ticket_issued_at = coalesce(ticket_issued_at, now())
       where id = ${seat.id} and ticket_template_id is null and qr_token is not null
      returning id
    `);
    await ctx.audit({
      action: 'attendee.ticket_issued',
      entityType: 'attendee',
      entityId: seat.id,
      after: { templateId: design.id, version: design.version, pinned: pinned.length > 0 },
    });
    return {};
  },
});

/**
 * **Reissue**: repin to the current design and put the seat back in the queue
 * to send. The QR is untouched (decision 28).
 */
const reissue = seatCommand({
  name: 'seats.reissue',
  verb: 'Reissue',
  params: noParams,
  skip: (seat) => notTicketable(seat) ?? (seat.issued ? null : 'Not issued yet. Issue it instead.'),
  async blastRadius(_tx, _ctx, seats) {
    const delivered = seats.filter((s) => s.delivered).length;
    return delivered > 0
      ? [{ count: delivered, text: 'tickets were already delivered. They go back to Ready to send, to be sent again.', tone: 'warning' }]
      : [];
  },
  async apply(tx, ctx, seat) {
    const design = await designFor(tx, seat.id);
    await tx.execute(sql`
      update attendees
         set ticket_template_id = ${design.id}, ticket_template_version = ${design.version},
             ticket_sent_at = null, ticket_sent_source = null, needs_reissue = false
       where id = ${seat.id}
    `);
    await ctx.audit({
      action: 'attendee.ticket_reissued',
      entityType: 'attendee',
      entityId: seat.id,
      after: { templateId: design.id, version: design.version, wasDelivered: seat.delivered },
    });
    return { requeued: seat.delivered };
  },
});

/**
 * **Void and re-issue QR** (§23.4, decision 55): the one command that replaces
 * a `qr_token`, for a leaked or disputed ticket. The code printed beside it is
 * replaced too, so a manual lookup of the old printout finds nothing. Every
 * copy already printed or emailed stops working at the door.
 */
const voidQr = seatCommand({
  name: 'seats.void_qr',
  verb: 'Void and re-issue',
  irreversible: true,
  params: noParams,
  skip: (seat) =>
    notTicketable(seat) ??
    (!seat.hasToken ? 'Has no QR yet. Issue it instead.' : seat.admitted ? 'The guest is already inside.' : null),
  async blastRadius(_tx, _ctx, seats) {
    const delivered = seats.filter((s) => s.delivered).length;
    const lines: BlastLine[] = [
      {
        count: seats.length,
        text: 'QR codes replaced for good. Every copy already printed or emailed will be refused at the door; scanner phones drop the old code when they next refresh.',
        tone: 'danger',
      },
    ];
    if (delivered > 0) {
      lines.push({ count: delivered, text: 'were delivered, and go back to Ready to send with the new code.', tone: 'warning' });
    }
    return lines;
  },
  async apply(tx, ctx, seat) {
    const [before] = await tx.execute<{ ticket_code: string | null }>(sql`
      select ticket_code from attendees where id = ${seat.id}
    `);
    // A collision on either unique column is vanishingly rare; the savepoint
    // lets one retry without losing the row's transaction.
    for (let attempt = 1; ; attempt++) {
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`select set_config('zetix.voiding_qr', 'on', true)`);
          await sp.execute(sql`
            update attendees
               set qr_token = ${generateQrToken()},
                   ticket_code = ${generateTicketCode(DEFAULT_TICKET_CODE_PREFIX)},
                   ticket_sent_at = null, ticket_sent_source = null, needs_reissue = false
             where id = ${seat.id}
          `);
          await sp.execute(sql`select set_config('zetix.voiding_qr', 'off', true)`);
        });
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
      }
    }
    await ctx.audit({
      action: 'attendee.qr_voided',
      entityType: 'attendee',
      entityId: seat.id,
      before: { ticketCode: before?.ticket_code ?? null },
      after: { wasDelivered: seat.delivered },
    });
    return { note: seat.delivered ? 'The new ticket needs sending.' : null };
  },
});

/** **Dismiss reissue flag**: the change was cosmetic; the ticket stays as sent (§10.6). */
const dismissReissue = seatCommand({
  name: 'seats.dismiss_reissue',
  verb: 'Dismiss the reissue flag on',
  params: noParams,
  skip: (seat) => (seat.needsReissue ? null : 'Not flagged for reissue.'),
  async apply(tx, ctx, seat) {
    await tx.execute(sql`update attendees set needs_reissue = false where id = ${seat.id}`);
    await ctx.audit({ action: 'attendee.reissue_dismissed', entityType: 'attendee', entityId: seat.id });
    return {};
  },
});

// ---------------------------------------------------------------------------
// Door (checkin.md §12)
// ---------------------------------------------------------------------------

/** **Check in**: a manual admission from the console, logged as `MANUAL` like the scanner's desk override. */
const checkIn = seatCommand({
  name: 'seats.check_in',
  verb: 'Check in',
  params: noParams,
  skip: (seat) =>
    seat.admitted ? 'Already checked in.' : notTicketable(seat),
  async apply(tx, ctx, seat) {
    await tx.execute(sql`
      insert into check_ins (attendee_id, show_id, operator_id, scanned_at, synced_at, source, override_reason)
      values (${seat.id}, ${seat.showId}, ${ctx.actorId}, now(), now(), 'MANUAL', ${ctx.reason})
    `);
    await ctx.audit({ action: 'attendee.checked_in', entityType: 'attendee', entityId: seat.id, after: { source: 'MANUAL' } });
    return {};
  },
});

/** **Undo check-in**: every live admission of the seat is reverted, never deleted (decision 7). */
const undoCheckIn = seatCommand({
  name: 'seats.undo_check_in',
  verb: 'Undo the check-in of',
  params: noParams,
  skip: (seat) => (seat.admitted ? null : 'Not checked in.'),
  async apply(tx, ctx, seat) {
    const rows = await tx.execute<{ id: string }>(sql`
      update check_ins set reverted_at = now(), reverted_by = ${ctx.actorId}
       where attendee_id = ${seat.id} and reverted_at is null
      returning id
    `);
    await ctx.audit({
      action: 'checkin.reverted',
      entityType: 'attendee',
      entityId: seat.id,
      after: { checkIns: rows.map((r) => Number(r.id)) },
    });
    return {};
  },
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const SETTABLE = ['CONFIRMED', 'PENDING_REVIEW', 'WAITLIST', 'CANCELLED'] as const;
const STATUS_WORD: Record<(typeof SETTABLE)[number], string> = {
  CONFIRMED: 'confirmed',
  PENDING_REVIEW: 'waiting for review',
  WAITLIST: 'waitlisted',
  CANCELLED: 'cancelled',
};

/**
 * **Set status** (§20.1: "every status is settable"). Confirming goes through
 * `promote_seats()` like any grant, with the override when the admin means to
 * go past capacity; the other three are plain writes that free the seat.
 */
const setStatus = seatCommand({
  name: 'seats.set_status',
  verb: 'Set the status of',
  params: z.object({ status: z.enum(SETTABLE), override: z.boolean().default(false) }).strict(),
  skip: (seat, ctx) =>
    seat.status === ctx.params.status
      ? `Already ${STATUS_WORD[ctx.params.status]}.`
      : seat.partyStatus === 'CANCELLED'
        ? 'Its party is cancelled. Restore the party first.'
        : seat.admitted && ctx.params.status !== 'CONFIRMED'
          ? 'The guest is already inside. Undo the check-in first.'
          : null,
  async blastRadius(tx, ctx, seats) {
    if (ctx.params.status === 'CONFIRMED') {
      const bySegment = new Map<number, number>();
      for (const s of seats) bySegment.set(s.segmentId, (bySegment.get(s.segmentId) ?? 0) + 1);
      return capacityLines(tx, bySegment, ctx.params.override);
    }
    const delivered = seats.filter((s) => s.delivered && s.status === 'CONFIRMED').length;
    return delivered > 0
      ? [{ count: delivered, text: 'tickets already delivered. The door will refuse them once the seats are not confirmed.', tone: 'danger' }]
      : [];
  },
  async apply(tx, ctx, seat) {
    const target = ctx.params.status;
    if (target === 'CONFIRMED') {
      if (seat.status === 'CANCELLED') {
        await tx.execute(sql`update attendees set status = 'WAITLIST' where id = ${seat.id}`);
      }
      const outcome = await promoteSeats(seat.segmentId, [seat.id], { override: ctx.params.override, executor: tx });
      if (outcome.refused) throw new SkipItem(`${NO_ROOM} ${outcome.reason}`);
    } else {
      await tx.execute(sql`
        update attendees set status = ${target}::booking_status, over_capacity_at = null
         where id = ${seat.id}
      `);
    }
    await recomputeStatus(tx, seat.registrationId);
    const withdrawn = target === 'CONFIRMED' ? 0 : await withdrawTicketMailIfUnseated(tx, seat.registrationId);
    await ctx.audit({
      action: 'attendee.status_set',
      entityType: 'attendee',
      entityId: seat.id,
      before: { status: seat.status },
      after: { status: target, override: ctx.params.override, messagesWithdrawn: withdrawn },
    });
    return { note: withdrawnNote(withdrawn) };
  },
});

/** **Delete** one seat, into the Trash (§23.6). Refused while the guest is inside. */
const removeSeat = seatCommand({
  name: 'seats.delete',
  verb: 'Delete',
  params: noParams,
  skip: (seat) => (seat.admitted ? 'The guest is already inside. Undo the check-in first.' : null),
  async blastRadius(_tx, _ctx, seats) {
    const delivered = seats.filter((s) => s.delivered).length;
    return delivered > 0
      ? [{ count: delivered, text: 'tickets already delivered. Their QR codes will be refused at the door.', tone: 'danger' }]
      : [];
  },
  async apply(tx, ctx, seat) {
    await removeAttendee(seat.id, { executor: tx });
    const withdrawn = await withdrawTicketMailIfUnseated(tx, seat.registrationId);
    await ctx.audit({
      action: 'attendee.removed',
      entityType: 'attendee',
      entityId: seat.id,
      after: { messagesWithdrawn: withdrawn },
    });
    return { note: withdrawnNote(withdrawn) };
  },
});

export const SEAT_COMMANDS: AnyCommand[] = [
  issue,
  reissue,
  voidQr,
  dismissReissue,
  checkIn,
  undoCheckIn,
  setStatus,
  removeSeat,
];
