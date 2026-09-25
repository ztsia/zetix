import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { promoteSeats, segmentPool } from '@/db/allocation';
import {
  defineCommand,
  SkipItem,
  type AnyCommand,
  type BlastLine,
  type CommandContext,
  type TargetRow,
  type Tx,
} from '@/lib/commands/define';
import { addressIssue } from '@/lib/email/address';
import {
  cancelRegistration,
  deleteRegistration,
  moveRegistration,
  recomputeStatus,
  restoreRegistration,
} from '@/lib/registrations/mutations';
import { queueVerificationEmail } from '@/lib/registrations/verification';
import {
  NO_ROOM,
  capacityLines,
  filter,
  flagList,
  idArray,
  matchParties,
  noParams,
  orderParties,
  overrideParams,
  partyFacts,
  plural,
  walkStopped,
  withdrawTicketMailIfUnseated,
  withdrawnNote,
  type PartyFacts,
} from './shared';

/**
 * The party-grain commands of spec/v3.md §23.2 that are the Audience
 * workspace's (`S`): Review, Allocation, Verification and Records.
 *
 * Each is one definition over the shared filter, so any view's "select all N
 * matching" can run it (§22.3), and each re-describes its row under a lock when
 * the row's turn comes, so a re-run does only what is left (§23.1). Every seat
 * mutation goes through `claim_seats()` / `promote_seats()` or the V1/V2
 * mutations that do (§23.4).
 *
 * Merge parties and Not a duplicate are module `V`'s, with duplicate
 * detection; Delivery and Messages are module `T`'s, with the send wizard.
 */

/**
 * A party-grain definition from the parts that differ: which parties to skip
 * and why, what the preview counts, and what to do to one party.
 */
function partyCommand<P>(spec: {
  name: string;
  verb: string;
  irreversible?: boolean;
  params: z.ZodType<P>;
  order?: 'pending' | 'waitlist';
  skip: (party: PartyFacts, ctx: CommandContext<P>) => string | null;
  detail?: (party: PartyFacts, ctx: CommandContext<P>) => string | null;
  blastRadius?: (tx: Tx, ctx: CommandContext<P>, parties: PartyFacts[]) => Promise<BlastLine[]>;
  apply: (
    tx: Tx,
    ctx: Parameters<AnyCommand['apply']>[1] & { params: P },
    party: PartyFacts,
  ) => Promise<Record<string, unknown> & { note?: string | null }>;
}): AnyCommand {
  return defineCommand({
    name: spec.name,
    entityType: 'registration',
    verb: spec.verb,
    noun: { one: 'party', many: 'parties' },
    irreversible: spec.irreversible ?? false,
    filter,
    params: spec.params,
    // Both selections work in the order the command spends seats: by the
    // earliest seat of the kind it decides (§21.3), not the party's own time.
    match: spec.order
      ? async (tx, ctx, f) => orderParties(spec.order!)(tx, ctx, await matchParties(tx, ctx, f))
      : matchParties,
    order: spec.order ? orderParties(spec.order) : undefined,

    async describe(tx, ctx, ids, { lock }) {
      const facts = await partyFacts(tx, ctx.concertId, ids, lock);
      return ids
        .filter((id) => facts.has(id))
        .map((id): TargetRow => {
          const party = facts.get(id)!;
          return {
            id,
            label: party.label,
            skip: spec.skip(party, ctx),
            detail: spec.detail?.(party, ctx) ?? null,
          };
        });
    },

    blastRadius: spec.blastRadius
      ? async (tx, ctx, ids) => {
          const facts = await partyFacts(tx, ctx.concertId, ids, false);
          return spec.blastRadius!(tx, ctx, [...facts.values()]);
        }
      : undefined,

    async apply(tx, ctx, row) {
      const facts = await partyFacts(tx, ctx.concertId, [row.id], false);
      const party = facts.get(row.id);
      if (!party) throw new SkipItem('No longer exists in this concert.');
      const outcome = await spec.apply(tx, ctx, party);
      return JSON.parse(JSON.stringify({ label: row.label, ...outcome }));
    },
  });
}

const CANCELLED = 'Cancelled. Restore it first.';

/** The preview line for ticket emails a run would withdraw (§23.3). */
async function pendingTicketMail(tx: Tx, ids: number[]): Promise<BlastLine[]> {
  if (ids.length === 0) return [];
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from email_outbox
     where registration_id = any(${idArray(ids)}) and status in ('DRAFT', 'QUEUED')
       and (purpose = 'TICKETS' or (purpose = 'EXTRAS_DECISION' and template_key = 'extras_granted'))
  `);
  return row.n > 0
    ? [{ count: row.n, text: 'ticket emails waiting to be sent are withdrawn from any party left with no confirmed seat.', tone: 'neutral' }]
    : [];
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * **Approve** (§25.4): the review gate. Approval gates the ticket, never the
 * seat. Parties with flags are skipped in bulk — "parties with no flags can be
 * approved in bulk from the view" — unless the admin approves from the record,
 * where the flags are in front of them.
 */
const approve = partyCommand({
  name: 'audience.approve',
  verb: 'Approve',
  params: z.object({ includeFlagged: z.boolean().default(false) }).strict(),
  skip: (party, ctx) =>
    party.approvedAt
      ? 'Already approved.'
      : party.status === 'CANCELLED'
        ? CANCELLED
        : party.flags.length > 0 && !ctx.params.includeFlagged
          ? `Has flags to look at first: ${flagList(party.flags)}. Open the record to approve it.`
          : null,
  detail: (party) => (party.pending > 0 ? `${plural(party.pending, 'extra', 'extras')} still waiting for a decision` : null),
  async blastRadius(_tx, _ctx, parties) {
    const pending = parties.filter((p) => p.pending > 0).length;
    return pending > 0
      ? [
          {
            count: pending,
            text: 'of them also have extras waiting. Approving does not decide those; grant or decline them too.',
            tone: 'neutral',
          },
        ]
      : [];
  },
  async apply(tx, ctx, party) {
    const rows = await tx.execute(sql`
      update registrations set approved_at = now(), approved_by = ${ctx.actorId}
       where id = ${party.id} and approved_at is null
      returning id
    `);
    if (rows.length === 0) throw new SkipItem('Already approved.');
    await ctx.audit({
      action: 'registration.approved',
      entityType: 'registration',
      entityId: party.id,
      after: { flags: party.flags },
    });
    return {};
  },
});

/**
 * **Grant extras** (`allocation.md` §7.5, v3 §22.2): the first-come walk, one
 * party at a time. Parties run in the order their earliest waiting seat asked,
 * and once one does not fit, the rest of the run in that segment is skipped
 * rather than letting a smaller, later party take the seats it was refused.
 *
 * With `allow_partial_grant` the boundary party takes what is left and keeps
 * the rest waiting for a decision. With the override every waiting seat is
 * confirmed and any seat past capacity is flagged `OVER_CAPACITY` (§23.5).
 */
const grantExtras = partyCommand({
  name: 'audience.grant_extras',
  verb: 'Grant extras',
  params: overrideParams,
  order: 'pending',
  skip: (party) =>
    party.status === 'CANCELLED'
      ? CANCELLED
      : party.pending === 0
        ? 'No extras waiting for a decision.'
        : null,
  detail: (party) => plural(party.pending, 'seat', 'seats') + ' waiting',
  async blastRadius(tx, ctx, parties) {
    const bySegment = new Map<number, number>();
    for (const party of parties) {
      bySegment.set(party.segmentId, (bySegment.get(party.segmentId) ?? 0) + party.pending);
    }
    const lines: BlastLine[] = [];
    for (const [segmentId, seats] of bySegment) {
      const pool = await segmentPool(segmentId, { executor: tx });
      const [segment] = await tx.execute<{ label: string }>(sql`
        select s.name || ' · ' || g.name as label
          from show_segments g join shows s on s.id = g.show_id where g.id = ${segmentId}
      `);
      if (ctx.params.override) {
        const after = pool.confirmed + seats;
        lines.push({
          count: seats,
          text:
            after > pool.sellable
              ? `extras to confirm in ${segment.label}. With the override this puts it at ${after} of ${pool.sellable}; the seats past capacity are flagged Over capacity.`
              : `extras to confirm in ${segment.label}, which has room for them.`,
          tone: after > pool.sellable ? 'danger' : 'neutral',
        });
      } else {
        lines.push({
          count: seats,
          text:
            seats > pool.extras_pool
              ? `extras asked for in ${segment.label}, and ${pool.extras_pool} left in the pool. Granted first come first; the walk stops at the first party that does not fit.`
              : `extras asked for in ${segment.label}; ${pool.extras_pool} left in the pool, so all of them fit.`,
          tone: seats > pool.extras_pool ? 'warning' : 'neutral',
        });
      }
    }
    return lines;
  },
  async apply(tx, ctx, party) {
    if (!ctx.params.override && (await walkStopped(tx, ctx.runId, party.segmentId))) {
      throw new SkipItem(`${NO_ROOM} an earlier party in this segment did not fit, and first come first served stops there.`);
    }
    const seats = await tx.execute<{ id: string }>(sql`
      select id from attendees
       where registration_id = ${party.id} and status = 'PENDING_REVIEW' and deleted_at is null
       order by requested_at, id
    `);
    let chosen = seats.map((s) => Number(s.id));
    let note: string | null = null;

    if (!ctx.params.override) {
      const pool = await segmentPool(party.segmentId, { executor: tx });
      if (chosen.length > pool.extras_pool) {
        const [policy] = await tx.execute<{ partial: boolean | null }>(sql`
          select (resolve_setting('allocation.allow_partial_grant', ${party.segmentId}::bigint)
                   #>> '{}')::boolean as partial
        `);
        if (policy?.partial && pool.extras_pool > 0) {
          chosen = chosen.slice(0, pool.extras_pool);
          note = `${chosen.length} of ${seats.length} granted; the pool is empty, so the rest still wait for a decision.`;
        } else {
          throw new SkipItem(
            `${NO_ROOM} ${plural(seats.length, 'seat', 'seats')} asked for, ${pool.extras_pool} left in the pool. Grant with the override, or decline.`,
          );
        }
      }
    }

    const outcome = await promoteSeats(party.segmentId, chosen, {
      override: ctx.params.override,
      executor: tx,
    });
    if (outcome.refused) throw new SkipItem(`${NO_ROOM} ${outcome.reason}`);
    await recomputeStatus(tx, party.id);
    await ctx.audit({
      action: ctx.params.override ? 'registration.extras_granted_over_capacity' : 'registration.extras_granted',
      entityType: 'registration',
      entityId: party.id,
      after: { granted: outcome.confirmed, asked: seats.length, overCapacity: outcome.over_capacity ?? 0 },
    });
    return { granted: outcome.confirmed, note };
  },
});

/** **Decline extras**: the waiting extras go to the waitlist, where a freed seat can still reach them. */
const declineExtras = partyCommand({
  name: 'audience.decline_extras',
  verb: 'Decline extras',
  params: noParams,
  order: 'pending',
  skip: (party) =>
    party.status === 'CANCELLED' ? CANCELLED : party.pending === 0 ? 'No extras waiting for a decision.' : null,
  detail: (party) => plural(party.pending, 'seat', 'seats') + ' to the waitlist',
  async blastRadius(_tx, _ctx, parties) {
    const seats = parties.reduce((n, p) => n + p.pending, 0);
    return [{ count: seats, text: 'extras move to the waitlist. Promote them later if seats free up.', tone: 'neutral' }];
  },
  async apply(tx, ctx, party) {
    const rows = await tx.execute(sql`
      update attendees set status = 'WAITLIST'
       where registration_id = ${party.id} and status = 'PENDING_REVIEW' and deleted_at is null
      returning id
    `);
    await recomputeStatus(tx, party.id);
    await ctx.audit({
      action: 'registration.extras_declined',
      entityType: 'registration',
      entityId: party.id,
      after: { declined: rows.length },
    });
    return { declined: rows.length };
  },
});

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * **Confirm seats**: every seat still waiting — for review or on the waitlist —
 * offered to `promote_seats()` as one decision. With the override it goes past
 * the ceilings and the quota, and the seats that needed it are flagged
 * (§23.5).
 */
const confirmSeats = partyCommand({
  name: 'audience.confirm_seats',
  verb: 'Confirm seats',
  params: overrideParams,
  order: 'waitlist',
  skip: (party) =>
    party.status === 'CANCELLED'
      ? CANCELLED
      : party.pending + party.waitlisted === 0
        ? 'Every seat is already confirmed.'
        : null,
  detail: (party) => plural(party.pending + party.waitlisted, 'seat', 'seats') + ' to confirm',
  async blastRadius(tx, ctx, parties) {
    const bySegment = new Map<number, number>();
    for (const p of parties) bySegment.set(p.segmentId, (bySegment.get(p.segmentId) ?? 0) + p.pending + p.waitlisted);
    return capacityLines(tx, bySegment, ctx.params.override);
  },
  async apply(tx, ctx, party) {
    const seats = await tx.execute<{ id: string }>(sql`
      select id from attendees
       where registration_id = ${party.id} and status in ('PENDING_REVIEW', 'WAITLIST')
         and deleted_at is null
       order by requested_at, id
    `);
    const outcome = await promoteSeats(party.segmentId, seats.map((s) => Number(s.id)), {
      override: ctx.params.override,
      executor: tx,
    });
    if (outcome.refused) throw new SkipItem(`${NO_ROOM} ${outcome.reason}`);
    await recomputeStatus(tx, party.id);
    await ctx.audit({
      action: ctx.params.override ? 'registration.seats_confirmed_over_capacity' : 'registration.seats_confirmed',
      entityType: 'registration',
      entityId: party.id,
      after: { confirmed: outcome.confirmed, overCapacity: outcome.over_capacity ?? 0 },
    });
    return { confirmed: outcome.confirmed };
  },
});

/**
 * **Promote from waitlist**: the waitlist walked first come first, without the
 * override. A party that no longer fits stops the walk in its segment.
 */
const promote = partyCommand({
  name: 'audience.promote',
  verb: 'Promote',
  params: noParams,
  order: 'waitlist',
  skip: (party) =>
    party.status === 'CANCELLED' ? CANCELLED : party.waitlisted === 0 ? 'Nobody on the waitlist.' : null,
  detail: (party) => plural(party.waitlisted, 'seat', 'seats') + ' waiting',
  async blastRadius(tx, _ctx, parties) {
    const bySegment = new Map<number, number>();
    for (const p of parties) bySegment.set(p.segmentId, (bySegment.get(p.segmentId) ?? 0) + p.waitlisted);
    return capacityLines(tx, bySegment, false);
  },
  async apply(tx, ctx, party) {
    if (await walkStopped(tx, ctx.runId, party.segmentId)) {
      throw new SkipItem(`${NO_ROOM} an earlier party in this segment did not fit, and first come first served stops there.`);
    }
    const seats = await tx.execute<{ id: string }>(sql`
      select id from attendees
       where registration_id = ${party.id} and status = 'WAITLIST' and deleted_at is null
       order by requested_at, id
    `);
    const outcome = await promoteSeats(party.segmentId, seats.map((s) => Number(s.id)), { executor: tx });
    if (outcome.refused) throw new SkipItem(`${NO_ROOM} ${outcome.reason}`);
    await recomputeStatus(tx, party.id);
    await ctx.audit({
      action: 'registration.promoted',
      entityType: 'registration',
      entityId: party.id,
      after: { confirmed: outcome.confirmed },
    });
    return { confirmed: outcome.confirmed };
  },
});

/**
 * **Waitlist**: give a party's confirmed and waiting seats back to the room.
 * The seats keep their tickets — a QR never changes silently — but the door
 * stops admitting them while they are not confirmed.
 */
const waitlist = partyCommand({
  name: 'audience.waitlist',
  verb: 'Waitlist',
  params: noParams,
  skip: (party) =>
    party.status === 'CANCELLED'
      ? CANCELLED
      : party.admitted > 0
        ? `${plural(party.admitted, 'guest is', 'guests are')} already inside. Undo the check-in first.`
        : party.confirmed + party.pending === 0
          ? 'Already waitlisted.'
          : null,
  async blastRadius(tx, _ctx, parties) {
    const confirmed = parties.reduce((n, p) => n + p.confirmed, 0);
    const delivered = parties.reduce((n, p) => n + p.delivered, 0);
    const lines: BlastLine[] = [];
    if (confirmed > 0) lines.push({ count: confirmed, text: 'confirmed seats go back to the room.', tone: 'warning' });
    if (delivered > 0) {
      lines.push({
        count: delivered,
        text: 'tickets already delivered. The door will refuse them while the seats are waitlisted.',
        tone: 'danger',
      });
    }
    lines.push(...(await pendingTicketMail(tx, parties.map((p) => p.id))));
    return lines;
  },
  async apply(tx, ctx, party) {
    const rows = await tx.execute(sql`
      update attendees set status = 'WAITLIST', over_capacity_at = null
       where registration_id = ${party.id} and status in ('CONFIRMED', 'PENDING_REVIEW')
         and deleted_at is null
      returning id
    `);
    await recomputeStatus(tx, party.id);
    const withdrawn = await withdrawTicketMailIfUnseated(tx, party.id);
    await ctx.audit({
      action: 'registration.waitlisted',
      entityType: 'registration',
      entityId: party.id,
      after: { seats: rows.length, messagesWithdrawn: withdrawn },
    });
    return { seats: rows.length, note: withdrawnNote(withdrawn) };
  },
});

/**
 * **Move to segment** (`allocation.md` §7.6): parent and seats together, in
 * the same show or another. The destination's room is checked by the
 * deferred move guard, which is forced to fire inside the row's own savepoint
 * so a refusal skips this party instead of failing the run at commit.
 */
const move = partyCommand({
  name: 'audience.move',
  verb: 'Move',
  params: z
    .object({ segmentId: z.number().int().positive(), override: z.boolean().default(false) })
    .strict(),
  skip: (party, ctx) =>
    party.segmentId === ctx.params.segmentId
      ? 'Already in that segment.'
      : party.admitted > 0 && ctx.params.segmentId !== party.segmentId
        ? `${plural(party.admitted, 'guest is', 'guests are')} already inside.`
        : null,
  async blastRadius(tx, ctx, parties) {
    const [destination] = await tx.execute<{ label: string; show_id: string; concert_id: string }>(sql`
      select s.name || ' · ' || g.name as label, g.show_id, s.concert_id
        from show_segments g join shows s on s.id = g.show_id
       where g.id = ${ctx.params.segmentId} and g.deleted_at is null
    `);
    if (!destination || Number(destination.concert_id) !== ctx.concertId) {
      return [{ count: 0, text: 'The destination segment is not in this concert.', tone: 'danger' }];
    }
    const lines = await capacityLines(
      tx,
      new Map([[ctx.params.segmentId, parties.reduce((n, p) => n + p.confirmed, 0)]]),
      ctx.params.override,
    );
    const otherShow = parties.filter((p) => p.showId !== Number(destination.show_id));
    const delivered = otherShow.reduce((n, p) => n + p.delivered, 0);
    if (delivered > 0) {
      lines.push({
        count: delivered,
        text: 'delivered tickets are for another show. They are flagged Changed after send, to reissue.',
        tone: 'warning',
      });
    }
    return lines;
  },
  async apply(tx, ctx, party) {
    const [destination] = await tx.execute<{ concert_id: string }>(sql`
      select s.concert_id from show_segments g join shows s on s.id = g.show_id
       where g.id = ${ctx.params.segmentId} and g.deleted_at is null
    `);
    if (!destination || Number(destination.concert_id) !== ctx.concertId) {
      throw new SkipItem('The destination segment is not in this concert.');
    }
    const result = await moveRegistration(party.id, ctx.params.segmentId, {
      override: ctx.params.override,
      executor: tx,
    });
    // `attendees_move_guard` is deferred to commit; fire it now, inside this
    // row's savepoint, so a full destination refuses this party alone.
    await tx.execute(sql`set constraints all immediate`);
    await ctx.audit({
      action: ctx.params.override ? 'registration.moved_over_capacity' : 'registration.moved',
      entityType: 'registration',
      entityId: party.id,
      before: { segmentId: party.segmentId },
      after: { segmentId: ctx.params.segmentId, seats: result.movedSeats },
    });
    return {
      seats: result.movedSeats,
      note: result.showChanged ? 'Moved to another show; delivered tickets are flagged for reissue.' : null,
    };
  },
});

/**
 * **Cancel** (§7.9): the booking is not coming. Seats return to the segment at
 * once, pending messages are withdrawn, and delivered tickets keep their codes
 * so the door says "cancelled — refer to desk" rather than "not found".
 */
const cancel = partyCommand({
  name: 'audience.cancel',
  verb: 'Cancel',
  params: noParams,
  skip: (party) =>
    party.status === 'CANCELLED'
      ? 'Already cancelled.'
      : party.admitted > 0
        ? `${plural(party.admitted, 'guest is', 'guests are')} already inside. Undo the check-in first.`
        : null,
  async blastRadius(tx, _ctx, parties) {
    const ids = parties.map((p) => p.id);
    const [row] = await tx.execute<{ messages: number }>(sql`
      select count(*)::int as messages from email_outbox
       where registration_id = any(${idArray(ids)}) and status in ('DRAFT', 'QUEUED')
    `);
    const lines: BlastLine[] = [];
    const confirmed = parties.reduce((n, p) => n + p.confirmed, 0);
    const delivered = parties.reduce((n, p) => n + p.delivered, 0);
    if (confirmed > 0) lines.push({ count: confirmed, text: 'confirmed seats return to their segments.', tone: 'warning' });
    if (delivered > 0) {
      lines.push({
        count: delivered,
        text: 'tickets already delivered. Their QR codes will be refused at the door ("cancelled — refer to desk").',
        tone: 'danger',
      });
    }
    if (row.messages > 0) lines.push({ count: row.messages, text: 'messages waiting to be sent are withdrawn.', tone: 'neutral' });
    return lines;
  },
  async apply(tx, ctx, party) {
    const result = await cancelRegistration(party.id, { executor: tx });
    await ctx.audit({ action: 'registration.cancelled', entityType: 'registration', entityId: party.id, after: result });
    return { ...result };
  },
});

/**
 * **Restore** a cancelled party (§7.9). Its seats are re-decided, not simply
 * un-cancelled: if the room has gone they come back waitlisted, and the report
 * says so with the engine's reason.
 */
const restore = partyCommand({
  name: 'audience.restore',
  verb: 'Restore',
  params: overrideParams,
  skip: (party) => (party.status !== 'CANCELLED' ? 'Not cancelled.' : null),
  async apply(tx, ctx, party) {
    const result = await restoreRegistration(party.id, { override: ctx.params.override, executor: tx });
    await ctx.audit({
      action: ctx.params.override ? 'registration.restored_over_capacity' : 'registration.restored',
      entityType: 'registration',
      entityId: party.id,
      after: result,
    });
    return { ...result, note: result.refused ? `Came back waitlisted: ${result.refused}` : null };
  },
});

// ---------------------------------------------------------------------------
// Verification (v2.md §8.1.4)
// ---------------------------------------------------------------------------

const verificationSkip = (party: PartyFacts) =>
  !party.needsVerification
    ? 'Was never asked to verify.'
    : party.emailVerifiedAt
      ? 'Already verified.'
      : party.status === 'CANCELLED'
        ? CANCELLED
        : null;

/**
 * **Release (treat as verified)**: an admin vouches for the address. The
 * timestamp is stamped and the token kept, so the record still shows the party
 * was asked to verify and a person decided instead of a click.
 */
const release = partyCommand({
  name: 'audience.release',
  verb: 'Release',
  params: noParams,
  skip: verificationSkip,
  async apply(tx, ctx, party) {
    const rows = await tx.execute(sql`
      update registrations set email_verified_at = now()
       where id = ${party.id} and email_verified_at is null
      returning id
    `);
    if (rows.length === 0) throw new SkipItem('Already verified.');
    await ctx.audit({
      action: 'registration.verification_overridden',
      entityType: 'registration',
      entityId: party.id,
      after: { overridden: true },
    });
    return {};
  },
});

/** **Send verification reminder**: the `public_verify` link again, queued to send (§24.2). */
const remind = partyCommand({
  name: 'audience.remind_verification',
  verb: 'Send reminder to',
  params: noParams,
  skip: (party) => verificationSkip(party) ?? (party.contactEmail ? null : 'No email address.'),
  async blastRadius(_tx, _ctx, parties) {
    return [{ count: parties.length, text: 'verification emails queued to send.', tone: 'neutral' }];
  },
  async apply(tx, ctx, party) {
    const [row] = await tx.execute<{
      token: string;
      contact_name: string;
      contact_email: string;
      concert_name: string;
      show_name: string;
    }>(sql`
      select r.verification_token as token, r.contact_name, r.contact_email::text as contact_email,
             c.name as concert_name, s.name as show_name
        from registrations r
        join shows s on s.id = r.show_id
        join concerts c on c.id = s.concert_id
       where r.id = ${party.id}
    `);
    const pending = await tx.execute(sql`
      select 1 from email_outbox
       where registration_id = ${party.id} and purpose = 'VERIFICATION'
         and status in ('DRAFT', 'QUEUED', 'SENDING')
    `);
    if (pending.length > 0) throw new SkipItem('A verification email is already waiting to be sent.');
    const queued = await queueVerificationEmail(tx, {
      registrationId: party.id,
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      token: row.token,
      concertName: row.concert_name,
      showName: row.show_name,
      status: 'QUEUED',
    });
    if (!queued) throw new Error('There is no "public_verify" email template to send.');
    await ctx.audit({ action: 'registration.verification_reminded', entityType: 'registration', entityId: party.id });
    return {};
  },
});

// ---------------------------------------------------------------------------
// Addresses (§24.6)
// ---------------------------------------------------------------------------

/**
 * **Check address**: run the syntax, typo and MX checks on the contact email
 * and store the verdict, which is what raises or clears `SUSPICIOUS_ADDRESS`.
 * Parties that arrived before V3 were never checked; this is how they are.
 */
const checkAddress = partyCommand({
  name: 'audience.check_address',
  verb: 'Check the address of',
  params: noParams,
  skip: (party) => (party.contactEmail ? null : 'No email address.'),
  async apply(tx, ctx, party) {
    const issue = await addressIssue(party.contactEmail!);
    await tx.execute(sql`
      update registrations
         set email_issue = ${issue}, email_checked_at = now(),
             email_issue_accepted_at = case when ${issue}::text is null then null
                                            else email_issue_accepted_at end
       where id = ${party.id}
    `);
    if (issue) {
      await ctx.audit({ action: 'registration.address_flagged', entityType: 'registration', entityId: party.id, after: { issue } });
    }
    return { note: issue };
  },
});

/** **Accept address**: the admin says the address is right; the flag clears, the finding stays. */
const acceptAddress = partyCommand({
  name: 'audience.accept_address',
  verb: 'Accept the address of',
  params: noParams,
  skip: (party) => (party.flags.includes('SUSPICIOUS_ADDRESS') ? null : 'The address is not flagged.'),
  async apply(tx, ctx, party) {
    await tx.execute(sql`update registrations set email_issue_accepted_at = now() where id = ${party.id}`);
    await ctx.audit({ action: 'registration.address_accepted', entityType: 'registration', entityId: party.id });
    return {};
  },
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * **Delete** (§23.6): soft, into the Trash, restorable. Refused per party
 * while a guest is inside — an admission is not a row that should never have
 * existed.
 */
const remove = partyCommand({
  name: 'audience.delete',
  verb: 'Delete',
  params: noParams,
  skip: (party) =>
    party.admitted > 0
      ? `${plural(party.admitted, 'guest is', 'guests are')} already inside. Undo the check-in first, or cancel instead.`
      : null,
  async blastRadius(tx, _ctx, parties) {
    const ids = parties.map((p) => p.id);
    const [row] = await tx.execute<{ messages: number }>(sql`
      select count(*)::int as messages from email_outbox
       where registration_id = any(${idArray(ids)}) and status in ('DRAFT', 'QUEUED')
    `);
    const lines: BlastLine[] = [
      { count: parties.reduce((n, p) => n + p.live, 0), text: 'seats go to the Trash with them.', tone: 'warning' },
    ];
    const delivered = parties.reduce((n, p) => n + p.delivered, 0);
    if (delivered > 0) {
      lines.push({ count: delivered, text: 'tickets already delivered. Their QR codes will be refused at the door.', tone: 'danger' });
    }
    if (row.messages > 0) lines.push({ count: row.messages, text: 'messages waiting to be sent are withdrawn.', tone: 'neutral' });
    return lines;
  },
  async apply(tx, ctx, party) {
    const result = await deleteRegistration(party.id, { executor: tx });
    await ctx.audit({ action: 'registration.deleted', entityType: 'registration', entityId: party.id, after: result });
    return { ...result };
  },
});

/**
 * **Edit field**, in bulk: the fields that are safe to set across many
 * parties at once — the round and the player link. Contact details are edited
 * one party at a time, on the record.
 */
const editField = partyCommand({
  name: 'audience.edit_field',
  verb: 'Edit',
  params: z.discriminatedUnion('field', [
    z.object({ field: z.literal('round_label'), value: z.string().trim().max(200).nullable() }).strict(),
    z.object({ field: z.literal('player_id'), value: z.number().int().positive().nullable() }).strict(),
  ]),
  skip: () => null,
  async blastRadius(tx, ctx) {
    if (ctx.params.field !== 'player_id' || ctx.params.value === null) return [];
    const [player] = await tx.execute<{ ok: boolean }>(sql`
      select true as ok from players
       where id = ${ctx.params.value} and concert_id = ${ctx.concertId} and deleted_at is null
    `);
    return player ? [] : [{ count: 0, text: 'That player is not in this concert.', tone: 'danger' }];
  },
  async apply(tx, ctx, party) {
    const { field, value } = ctx.params;
    if (field === 'player_id' && value !== null) {
      const [player] = await tx.execute(sql`
        select 1 from players where id = ${value} and concert_id = ${ctx.concertId} and deleted_at is null
      `);
      if (!player) throw new SkipItem('That player is not in this concert.');
    }
    const [before] = await tx.execute<{ value: string | null }>(sql`
      select ${sql.identifier(field)}::text as value from registrations where id = ${party.id}
    `);
    await tx.execute(sql`
      update registrations set ${sql.identifier(field)} = ${value} where id = ${party.id}
    `);
    await ctx.audit({
      action: 'registration.updated',
      entityType: 'registration',
      entityId: party.id,
      before: { [field]: before?.value ?? null },
      after: { [field]: value },
    });
    return {};
  },
});

export const PARTY_COMMANDS: AnyCommand[] = [
  approve,
  grantExtras,
  declineExtras,
  confirmSeats,
  promote,
  waitlist,
  move,
  cancel,
  restore,
  release,
  remind,
  checkAddress,
  acceptAddress,
  remove,
  editField,
];

