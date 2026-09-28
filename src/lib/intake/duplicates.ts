import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { dbErrorMessage } from '@/db/errors';
import { moveRegistration, recomputeStatus } from '@/lib/registrations/mutations';
import { defineCommand, SkipItem, type AnyCommand, type BlastLine, type Tx } from '@/lib/commands/define';
import { idSchema } from '@/lib/commands/selection';
import { queueReceipt } from './receipt';

/**
 * Duplicates and merging (spec/v3.md §25.5): *Merge parties*, *Not a
 * duplicate* and *Undo merge*, as commands over stored
 * `duplicate_candidates` pairs (§23.2).
 *
 * **Merge moves the absorbed party's seats into the survivor in one
 * transaction.** Seats keep their own `requested_at` (§21.3) and their
 * `qr_token` — a ticket already delivered still admits its guest. When the two
 * parties are in different segments the absorbed party is first **moved** to
 * the survivor's segment, through the same path as *Move to segment*
 * (`allocation.md` §7.6), whose deferred guard decides whether the destination
 * has room; the merge is then a merge within one segment. The absorbed party
 * is soft-deleted with `merged_into_id` pointing at the survivor, its pending
 * messages are withdrawn, and its form responses re-point.
 *
 * **Undo merge reverses exactly that**, from `merge_detail` and each seat's
 * `merged_from_id`: seats that came from the absorbed party go back to it, it
 * returns to the segment it left, and its responses re-point back. Withdrawn
 * messages are not revived; a resend is a decision for the admin.
 */

const candidateFilter = z
  .object({
    status: z.enum(['OPEN', 'MERGED', 'DISMISSED']).default('OPEN'),
    /** Pairs naming this party. */
    registrationId: idSchema.optional(),
    reason: z.enum(['EMAIL', 'PHONE', 'NAME', 'MANUAL']).optional(),
  })
  .strict();
type CandidateFilter = z.infer<typeof candidateFilter>;

type Pair = {
  id: number;
  status: 'OPEN' | 'MERGED' | 'DISMISSED';
  reasons: string[];
  mergeDetail: MergeDetail | null;
  a: Side;
  b: Side;
};

type Side = {
  id: number;
  name: string;
  deleted: boolean;
  mergedIntoId: number | null;
  status: string;
  segmentId: number;
  showId: number;
  playerId: number | null;
  requestedAt: string;
  liveSeats: number;
  admitted: number;
  sending: boolean;
};

export type MergeDetail = {
  survivorId: number;
  absorbedId: number;
  /** The segment the absorbed party was in before the merge moved it, if it did. */
  fromSegmentId: number | null;
  seatIds: number[];
  responseIds: number[];
  withdrawnMessageIds: number[];
  undoneAt?: string;
};

async function matchCandidates(tx: Tx, concertId: number, filter: CandidateFilter): Promise<number[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select d.id from duplicate_candidates d
      join shows s on s.id = d.show_id
     where s.concert_id = ${concertId}
       and d.deleted_at is null
       and d.status = ${filter.status}::duplicate_status
       ${filter.registrationId ? sql`and ${filter.registrationId} in (d.registration_a_id, d.registration_b_id)` : sql``}
       ${filter.reason ? sql`and ${filter.reason} = any(d.reasons)` : sql``}
     order by d.id
  `);
  return rows.map((row) => Number(row.id));
}

async function loadPairs(tx: Tx, concertId: number, ids: number[], lock: boolean): Promise<Map<number, Pair>> {
  if (ids.length === 0) return new Map();
  const list = sql`${`{${ids.join(',')}}`}::bigint[]`;
  if (lock) {
    // Both parties, in id order so two runs over overlapping pairs cannot
    // deadlock, then the pair itself.
    await tx.execute(sql`
      select r.id from registrations r
       where r.id in (select registration_a_id from duplicate_candidates where id = any(${list})
                      union
                      select registration_b_id from duplicate_candidates where id = any(${list}))
       order by r.id
       for update
    `);
    await tx.execute(sql`select id from duplicate_candidates where id = any(${list}) order by id for update`);
  }
  const rows = await tx.execute<{
    id: string;
    status: Pair['status'];
    reasons: string[];
    merge_detail: MergeDetail | null;
    side: 'a' | 'b';
    r_id: string;
    name: string;
    deleted: boolean;
    merged_into_id: string | null;
    r_status: string;
    segment_id: string;
    show_id: string;
    player_id: string | null;
    requested_at: string;
    live_seats: number;
    admitted: number;
    sending: boolean;
  }>(sql`
    select d.id, d.status::text as status, d.reasons, d.merge_detail, x.side,
           r.id as r_id, r.contact_name as name, r.deleted_at is not null as deleted,
           r.merged_into_id, r.status::text as r_status, r.segment_id, r.show_id, r.player_id,
           r.requested_at::text as requested_at,
           (select count(*)::int from attendees a
             where a.registration_id = r.id and a.deleted_at is null and a.status <> 'CANCELLED') as live_seats,
           (select count(*)::int from attendees a
              join check_ins c on c.attendee_id = a.id and c.reverted_at is null
             where a.registration_id = r.id and a.deleted_at is null) as admitted,
           exists (select 1 from email_outbox o where o.registration_id = r.id and o.status = 'SENDING') as sending
      from duplicate_candidates d
      join shows s on s.id = d.show_id
      cross join lateral (values ('a', d.registration_a_id), ('b', d.registration_b_id)) as x(side, rid)
      join registrations r on r.id = x.rid
     where d.id = any(${list}) and s.concert_id = ${concertId} and d.deleted_at is null
  `);
  const pairs = new Map<number, Pair>();
  for (const row of rows) {
    const id = Number(row.id);
    const side: Side = {
      id: Number(row.r_id),
      name: row.name,
      deleted: row.deleted,
      mergedIntoId: row.merged_into_id === null ? null : Number(row.merged_into_id),
      status: row.r_status,
      segmentId: Number(row.segment_id),
      showId: Number(row.show_id),
      playerId: row.player_id === null ? null : Number(row.player_id),
      requestedAt: row.requested_at,
      liveSeats: row.live_seats,
      admitted: row.admitted,
      sending: row.sending,
    };
    const pair = pairs.get(id) ?? ({ id, status: row.status, reasons: row.reasons, mergeDetail: row.merge_detail } as Pair);
    pair[row.side] = side;
    pairs.set(id, pair);
  }
  return pairs;
}

const pairLabel = (pair: Pair) => `${pair.a.name} and ${pair.b.name}`;

/** Which side survives: the admin's pick from the record, or the earlier request in bulk. */
function survivorOf(pair: Pair, keep: Keep): { survivor: Side; absorbed: Side } {
  const aFirst =
    pair.a.requestedAt < pair.b.requestedAt || (pair.a.requestedAt === pair.b.requestedAt && pair.a.id < pair.b.id);
  const keepA = keep === 'A' || (keep === 'EARLIER' && aFirst) || (keep === 'LATER' && !aFirst);
  return keepA ? { survivor: pair.a, absorbed: pair.b } : { survivor: pair.b, absorbed: pair.a };
}

const keepSchema = z.enum(['EARLIER', 'LATER', 'A', 'B']);
type Keep = z.infer<typeof keepSchema>;

// ---------------------------------------------------------------------------
// Merge parties
// ---------------------------------------------------------------------------

const mergeParams = z
  .object({ keep: keepSchema.default('EARLIER'), override: z.boolean().default(false) })
  .strict();

function mergeSkip(pair: Pair, keep: Keep): string | null {
  if (pair.status === 'MERGED') return 'Already merged.';
  if (pair.status === 'DISMISSED') return 'Marked not a duplicate.';
  if (pair.a.deleted || pair.b.deleted) return 'One of the two is no longer live.';
  const { survivor, absorbed } = survivorOf(pair, keep);
  if (survivor.status === 'CANCELLED') return `${survivor.name} is cancelled. Restore it first, or keep the other party.`;
  if (absorbed.sending || survivor.sending) return 'A message to one of them is being sent right now. Try again in a moment.';
  if (survivor.segmentId !== absorbed.segmentId && absorbed.admitted > 0) {
    return `${absorbed.name} has guests already admitted, and merging would move them to another segment.`;
  }
  return null;
}

const merge = defineCommand({
  name: 'intake.merge',
  entityType: 'duplicate_candidate',
  verb: 'Merge',
  noun: { one: 'pair', many: 'pairs' },
  irreversible: false,
  filter: candidateFilter,
  params: mergeParams,
  match: (tx, ctx, filter) => matchCandidates(tx, ctx.concertId, filter),
  async describe(tx, ctx, ids, { lock }) {
    const pairs = await loadPairs(tx, ctx.concertId, ids, lock);
    return ids.flatMap((id) => {
      const pair = pairs.get(id);
      if (!pair?.a || !pair.b) return [];
      const skip = mergeSkip(pair, ctx.params.keep);
      const { survivor, absorbed } = survivorOf(pair, ctx.params.keep);
      return [
        {
          id,
          label: pairLabel(pair),
          skip,
          detail: skip
            ? null
            : `${absorbed.name}'s ${absorbed.liveSeats} seat${absorbed.liveSeats === 1 ? '' : 's'} join ${survivor.name}` +
              (survivor.segmentId !== absorbed.segmentId ? ', moving segment' : ''),
        },
      ];
    });
  },
  async blastRadius(tx, ctx, ids): Promise<BlastLine[]> {
    const pairs = [...(await loadPairs(tx, ctx.concertId, ids, false)).values()].filter(
      (pair) => pair.a && pair.b && mergeSkip(pair, ctx.params.keep) === null,
    );
    const moving = pairs.filter((pair) => pair.a.segmentId !== pair.b.segmentId).length;
    const lines: BlastLine[] = [
      {
        count: pairs.length,
        text: 'parties are merged into the other of their pair and moved to the Trash. Undo merge brings them back.',
        tone: 'neutral',
      },
    ];
    if (moving > 0) {
      lines.push({
        count: moving,
        text: "of them are in different segments: the absorbed party's seats move to the survivor's segment, which must have room.",
        tone: 'warning',
      });
    }
    return lines;
  },
  async apply(tx, ctx, row) {
    const pair = (await loadPairs(tx, ctx.concertId, [row.id], false)).get(row.id)!;
    const { survivor, absorbed } = survivorOf(pair, ctx.params.keep);
    const detail = await mergeParties(tx, survivor, absorbed, { override: ctx.params.override });

    await tx.execute(sql`
      update duplicate_candidates
         set status = 'MERGED', decided_by = ${ctx.actorId}, decided_at = now(),
             merge_detail = ${JSON.stringify(detail)}::jsonb
       where id = ${row.id}
    `);
    await ctx.audit({
      action: 'registration.merged',
      entityType: 'registration',
      entityId: survivor.id,
      after: { absorbed: absorbed.id, seats: detail.seatIds.length, movedFrom: detail.fromSegmentId },
    });
    await ctx.audit({
      action: 'registration.merged_away',
      entityType: 'registration',
      entityId: absorbed.id,
      after: { into: survivor.id },
    });
    return {
      label: row.label,
      survivor: survivor.id,
      seats: detail.seatIds.length,
      note: detail.withdrawnMessageIds.length > 0
        ? `${detail.withdrawnMessageIds.length} pending message(s) to ${absorbed.name} withdrawn.`
        : null,
    };
  },
});

/**
 * The merge itself, one pair, in the caller's transaction. Exported for the
 * import grid, whose "add seats to it" is the same act arriving another way.
 */
export async function mergeParties(
  tx: Tx,
  survivor: Pick<Side, 'id' | 'segmentId' | 'playerId' | 'name'>,
  absorbed: Pick<Side, 'id' | 'segmentId' | 'name'>,
  options: { override: boolean },
): Promise<MergeDetail> {
  let fromSegmentId: number | null = null;
  if (absorbed.segmentId !== survivor.segmentId) {
    // A move first (§7.6), so the capacity question is the one Move asks. The
    // deferred guard is fired here, inside this row, so a full destination
    // skips this pair instead of failing the run at commit.
    fromSegmentId = absorbed.segmentId;
    try {
      await moveRegistration(absorbed.id, survivor.segmentId, { override: options.override, executor: tx });
      await tx.execute(sql`set constraints all immediate`);
    } catch (error) {
      // The move guard words its refusal for a capacity edit; here nothing's
      // capacity changed, so the merge says what actually happened.
      console.error('merge move refused:', dbErrorMessage(error));
      throw new SkipItem(
        `${survivor.name}'s segment has no room for ${absorbed.name}'s seats. Free seats there, or merge with the override.`,
      );
    }
  }

  const seats = await tx.execute<{ id: string }>(sql`
    update attendees
       set registration_id = ${survivor.id}, merged_from_id = ${absorbed.id}
     where registration_id = ${absorbed.id} and deleted_at is null and status <> 'CANCELLED'
    returning id
  `);

  // Base seats now count against the survivor's player (`claim_seats()`
  // counts base by the party's player), against that player's own quota — the
  // override on `player_allocations` if there is one, else the segment's.
  // Past it is the line the engine draws, and the same override crosses it,
  // marking the seats that needed it (§23.5).
  if (survivor.playerId !== null) {
    const [quota] = await tx.execute<{ quota: number | null; claimed: number }>(sql`
      select coalesce(pa.base_quota_override,
                      (resolve_setting('allocation.base_quota', ${survivor.segmentId}::bigint) #>> '{}')::int) as quota,
             (select count(*)::int from attendees a join registrations r on r.id = a.registration_id
               where a.segment_id = ${survivor.segmentId} and a.allocation_type = 'BASE'
                 and a.status = 'CONFIRMED' and a.deleted_at is null and r.deleted_at is null
                 and r.status <> 'CANCELLED'
                 and r.player_id = ${survivor.playerId}::bigint) as claimed
        from (select 1) one
        left join player_allocations pa
               on pa.player_id = ${survivor.playerId}::bigint and pa.segment_id = ${survivor.segmentId}::bigint
    `);
    const over = quota && quota.quota !== null ? quota.claimed - quota.quota : 0;
    if (over > 0 && !options.override) {
      throw new SkipItem(
        `The merged party would hold ${quota!.claimed} base seats against a quota of ${quota!.quota}. Use the override to merge anyway.`,
      );
    }
    if (over > 0) {
      await tx.execute(sql`
        update attendees set over_capacity_at = now()
         where id in (select id from attendees
                       where registration_id = ${survivor.id} and merged_from_id = ${absorbed.id}
                         and allocation_type = 'BASE' and status = 'CONFIRMED' and deleted_at is null
                       order by id desc
                       limit ${over})
      `);
    }
  }

  const responses = await tx.execute<{ id: string }>(sql`
    update form_responses set registration_id = ${survivor.id}
     where registration_id = ${absorbed.id}
    returning id
  `);

  const withdrawn = await tx.execute<{ id: string; purpose: string }>(sql`
    update email_outbox set status = 'CANCELLED', updated_at = now()
     where registration_id = ${absorbed.id} and status in ('DRAFT', 'QUEUED')
    returning id, purpose::text as purpose
  `);

  await tx.execute(sql`
    update registrations set merged_into_id = ${survivor.id}, deleted_at = now()
     where id = ${absorbed.id}
  `);
  await recomputeStatus(tx, survivor.id);
  await tx.execute(sql`select refresh_duplicate_candidates(${survivor.id}::bigint)`);

  // The receipt the absorbed party was waiting for now belongs to the
  // survivor, and describes every seat.
  if (withdrawn.some((row) => row.purpose === 'RECEIPT')) {
    await queueReceipt(tx, survivor.id, { holdMinutes: 0 });
  }

  return {
    survivorId: survivor.id,
    absorbedId: absorbed.id,
    fromSegmentId,
    seatIds: seats.map((seat) => Number(seat.id)),
    responseIds: responses.map((response) => Number(response.id)),
    withdrawnMessageIds: withdrawn.map((message) => Number(message.id)),
  };
}

// ---------------------------------------------------------------------------
// Not a duplicate
// ---------------------------------------------------------------------------

const notDuplicate = defineCommand({
  name: 'intake.not_duplicate',
  entityType: 'duplicate_candidate',
  verb: 'Mark not a duplicate',
  noun: { one: 'pair', many: 'pairs' },
  irreversible: false,
  filter: candidateFilter,
  params: z.object({}).strict(),
  match: (tx, ctx, filter) => matchCandidates(tx, ctx.concertId, filter),
  async describe(tx, ctx, ids, { lock }) {
    const pairs = await loadPairs(tx, ctx.concertId, ids, lock);
    return ids.flatMap((id) => {
      const pair = pairs.get(id);
      if (!pair?.a || !pair.b) return [];
      return [
        {
          id,
          label: pairLabel(pair),
          skip:
            pair.status === 'DISMISSED'
              ? 'Already marked not a duplicate.'
              : pair.status === 'MERGED'
                ? 'Already merged. Undo the merge instead.'
                : null,
        },
      ];
    });
  },
  async apply(tx, ctx, row) {
    await tx.execute(sql`
      update duplicate_candidates
         set status = 'DISMISSED', decided_by = ${ctx.actorId}, decided_at = now()
       where id = ${row.id} and status = 'OPEN'
    `);
    await ctx.audit({ action: 'duplicate.dismissed', entityType: 'duplicate_candidate', entityId: row.id });
    return { label: row.label };
  },
});

// ---------------------------------------------------------------------------
// Undo merge
// ---------------------------------------------------------------------------

const undoMerge = defineCommand({
  name: 'intake.undo_merge',
  entityType: 'duplicate_candidate',
  verb: 'Undo merge',
  noun: { one: 'merge', many: 'merges' },
  irreversible: false,
  filter: candidateFilter,
  params: z.object({}).strict(),
  match: (tx, ctx, filter) => matchCandidates(tx, ctx.concertId, { ...filter, status: 'MERGED' }),
  async describe(tx, ctx, ids, { lock }) {
    const pairs = await loadPairs(tx, ctx.concertId, ids, lock);
    return ids.flatMap((id) => {
      const pair = pairs.get(id);
      if (!pair?.a || !pair.b) return [];
      const detail = pair.mergeDetail;
      const survivor = detail && (pair.a.id === detail.survivorId ? pair.a : pair.b);
      const absorbed = detail && (pair.a.id === detail.absorbedId ? pair.a : pair.b);
      return [
        {
          id,
          label: pairLabel(pair),
          skip:
            pair.status !== 'MERGED' || !detail || !survivor || !absorbed
              ? 'Not merged.'
              : survivor.deleted
                ? `${survivor.name} is in the Trash. Restore it first.`
                : absorbed.mergedIntoId !== survivor.id || !absorbed.deleted
                  ? `${absorbed.name} is no longer merged into ${survivor.name}.`
                  : survivor.sending
                    ? 'A message to this party is being sent right now. Try again in a moment.'
                    : null,
        },
      ];
    });
  },
  async apply(tx, ctx, row) {
    const pair = (await loadPairs(tx, ctx.concertId, [row.id], false)).get(row.id)!;
    const detail = pair.mergeDetail!;

    await tx.execute(sql`
      update registrations set deleted_at = null, merged_into_id = null where id = ${detail.absorbedId}
    `);
    const [admittedAway] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from attendees a
        join check_ins c on c.attendee_id = a.id and c.reverted_at is null
       where a.merged_from_id = ${detail.absorbedId} and a.registration_id = ${detail.survivorId}
         and a.deleted_at is null
    `);
    if (detail.fromSegmentId !== null && admittedAway.n > 0) {
      throw new SkipItem('Guests from these seats are already admitted; moving them back to another segment would move them out of the hall they are in.');
    }
    const seats = await tx.execute<{ id: string }>(sql`
      update attendees set registration_id = ${detail.absorbedId}, merged_from_id = null
       where merged_from_id = ${detail.absorbedId} and registration_id = ${detail.survivorId}
         and deleted_at is null
      returning id
    `);
    if (detail.fromSegmentId !== null) {
      try {
        await moveRegistration(detail.absorbedId, detail.fromSegmentId, { executor: tx });
        await tx.execute(sql`set constraints all immediate`);
      } catch (error) {
        console.error('undo merge move refused:', dbErrorMessage(error));
        throw new SkipItem('The segment it came from has no room to take its seats back. Free seats there first.');
      }
    }
    if (detail.responseIds.length > 0) {
      await tx.execute(sql`
        update form_responses set registration_id = ${detail.absorbedId}
         where id = any(${`{${detail.responseIds.join(',')}}`}::bigint[])
           and registration_id = ${detail.survivorId}
      `);
    }
    await recomputeStatus(tx, detail.absorbedId);
    await recomputeStatus(tx, detail.survivorId);
    await tx.execute(sql`
      update duplicate_candidates
         set status = 'DISMISSED', decided_by = ${ctx.actorId}, decided_at = now(),
             merge_detail = merge_detail || jsonb_build_object('undoneAt', now())
       where id = ${row.id}
    `);
    await ctx.audit({
      action: 'registration.merge_undone',
      entityType: 'registration',
      entityId: detail.absorbedId,
      after: { from: detail.survivorId, seats: seats.length },
    });
    return {
      label: row.label,
      seats: seats.length,
      note:
        detail.withdrawnMessageIds.length > 0
          ? 'Messages withdrawn by the merge are not revived; resend from the record if needed.'
          : null,
    };
  },
});

export const INTAKE_DUPLICATE_COMMANDS: AnyCommand[] = [merge, notDuplicate, undoMerge];
