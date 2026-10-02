import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { claimSeats, lockShowForClaim, type SeatRequest } from '@/db/allocation';
import { defineCommand, SkipItem, type AnyCommand, type BlastLine, type Json, type Tx } from '@/lib/commands/define';
import { idSchema } from '@/lib/commands/selection';
import { addressShapeIssue } from '@/lib/email/address';
import { queueReceipt } from '@/lib/intake/receipt';
import { reviewAtIntake } from '@/lib/intake/review';
import { mintUpdateToken } from '@/lib/intake/update-link';
import { recomputeStatus } from '@/lib/registrations/mutations';
import type { RowIssue, StagedFields } from './staging';
import { STAGING_VIEWS, stagedRowWhere } from './staging-queries';

/**
 * The staging grid's commands (spec/v3.md §23.2, §25.7).
 *
 * **Commit staged rows** works a **party** at a time: the target is any of the
 * party's rows, and the whole party's staged rows commit together in one
 * transaction, through one `claim_seats()` call — the engine's whole-party
 * decisions stay whole. A party with a blocking issue on any row is skipped
 * and stays staged; the batch is committed in as many passes as it takes.
 *
 * **Undo import** removes everything a batch created: the parties it made go
 * to the Trash, and seats it added to parties that already existed are
 * cancelled and removed. It is irreversible — the batch is closed — so a large
 * one asks for the typed phrase (§23.3).
 */

// ---------------------------------------------------------------------------
// Commit staged rows
// ---------------------------------------------------------------------------

/**
 * The grid's own filter (spec/v3.md §32.1): the batch, and the tab and search
 * the admin was looking at when they chose "Select all N matching". Without the
 * last two, that selection committed every ready party in the batch.
 */
const commitFilter = z
  .object({
    batchId: idSchema,
    view: z.enum(STAGING_VIEWS).optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

type PartyRows = {
  batchId: number;
  partyKey: string;
  segmentId: number;
  showId: number;
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
  batchCreatedAt: string;
  queueReceipts: boolean;
  rows: {
    id: number;
    rowNumber: number;
    seatIndex: number;
    fields: StagedFields;
    issues: RowIssue[];
    status: string;
    existingId: number | null;
    existingAction: 'ADD_SEATS' | 'SKIP' | 'SEPARATE' | null;
  }[];
};

/** The party each row id belongs to, in this concert, keyed by that id. */
async function partiesOf(tx: Tx, concertId: number, ids: number[], lock: boolean): Promise<Map<number, PartyRows>> {
  if (ids.length === 0) return new Map();
  const list = sql`${`{${ids.join(',')}}`}::bigint[]`;
  const heads = await tx.execute<{
    id: string;
    batch_id: string;
    party_key: string | null;
    segment_id: string;
    show_id: string;
    audience_mode: PartyRows['audienceMode'];
    created_at: string;
    queue_receipts: boolean;
  }>(sql`
    select r.id, r.batch_id, r.party_key, b.segment_id, b.show_id, g.audience_mode::text as audience_mode,
           to_json(b.created_at) #>> '{}' as created_at, b.queue_receipts
      from import_rows r
      join import_batches b on b.id = r.batch_id
      join show_segments g on g.id = b.segment_id
      join shows s on s.id = b.show_id
     where r.id = any(${list}) and s.concert_id = ${concertId} and r.deleted_at is null
  `);
  const out = new Map<number, PartyRows>();
  for (const head of heads) {
    const rows = await tx.execute<{
      id: string;
      row_number: number;
      seat_index: number;
      normalized: StagedFields;
      issues: RowIssue[];
      status: string;
      existing_registration_id: string | null;
      existing_action: PartyRows['rows'][number]['existingAction'];
    }>(sql`
      select id, row_number, seat_index, normalized, issues, status::text as status,
             existing_registration_id, existing_action::text as existing_action
        from import_rows
       where batch_id = ${head.batch_id}
         and party_key is not distinct from ${head.party_key}
         and deleted_at is null
       order by row_number, seat_index
       ${lock ? sql`for update` : sql``}
    `);
    out.set(Number(head.id), {
      batchId: Number(head.batch_id),
      partyKey: head.party_key ?? '',
      segmentId: Number(head.segment_id),
      showId: Number(head.show_id),
      audienceMode: head.audience_mode,
      batchCreatedAt: head.created_at,
      queueReceipts: head.queue_receipts,
      rows: rows.map((row) => ({
        id: Number(row.id),
        rowNumber: row.row_number,
        seatIndex: row.seat_index,
        fields: row.normalized,
        issues: row.issues ?? [],
        status: row.status,
        existingId: row.existing_registration_id === null ? null : Number(row.existing_registration_id),
        existingAction: row.existing_action,
      })),
    });
  }
  return out;
}

const staged = (party: PartyRows) => party.rows.filter((row) => row.status === 'STAGED');
const blocking = (party: PartyRows) =>
  staged(party).flatMap((row) => row.issues.filter((issue) => issue.level === 'BLOCKING'));

function partySkip(party: PartyRows): string | null {
  const rows = staged(party);
  if (rows.length === 0) return 'Already committed.';
  const blocks = blocking(party);
  if (blocks.length > 0) {
    return `Needs fixing first: ${blocks[0].message}${blocks.length > 1 ? ` (and ${blocks.length - 1} more)` : ''}`;
  }
  return null;
}

/**
 * A row's first-come time: its own timestamp, or — with none — the moment the
 * batch was staged plus its place in the file, so file order is the order
 * (spec/v3.md §25.7). Microseconds keep every row distinct.
 */
function requestedAtOf(party: PartyRows, row: PartyRows['rows'][number]): Date {
  if (row.fields.requestedAt) return new Date(row.fields.requestedAt);
  return new Date(new Date(party.batchCreatedAt).getTime() + row.rowNumber + row.seatIndex / 1000);
}

const commitRows = defineCommand({
  name: 'intake.commit_rows',
  entityType: 'import_row',
  verb: 'Commit',
  noun: { one: 'party', many: 'parties' },
  irreversible: false,
  filter: commitFilter,
  params: z.object({}).strict(),
  async match(tx, ctx, filter) {
    // One row per ready party — its first — in first-come order.
    const rows = await tx.execute<{ id: string }>(sql`
      with parties as (
        select r.party_key, min(r.id) as head,
               min(coalesce((r.normalized ->> 'requestedAt')::timestamptz, b.created_at)) as first_at,
               min(r.row_number) as first_row,
               bool_or(exists (select 1 from jsonb_array_elements(r.issues) i where i ->> 'level' = 'BLOCKING')) as blocked
          from import_rows r
          join import_batches b on b.id = r.batch_id
          join shows s on s.id = b.show_id
         where r.batch_id = ${filter.batchId} and s.concert_id = ${ctx.concertId}
           and r.status = 'STAGED' and r.deleted_at is null and b.status = 'STAGED'
         group by r.party_key
      ),
      -- The parties the grid's rows belong to, under the tab and search the
      -- admin selected from. A party is in when any of its rows is.
      shown as (
        select distinct r.party_key from import_rows r
         where ${stagedRowWhere(filter.batchId, filter.view ?? 'all', filter.search ?? '')}
      )
      select head as id from parties
       where not blocked
         and exists (select 1 from shown where shown.party_key is not distinct from parties.party_key)
       order by first_at, first_row
    `);
    return rows.map((row) => Number(row.id));
  },
  /**
   * Unticking any seat of a party excludes the party (spec/v3.md §32.1). The
   * grid lists seats and this commits parties, each by its first staged row —
   * so an unticked seat names the head of its party here.
   */
  async excludes(tx, ctx, excludedIds) {
    const rows = await tx.execute<{ id: string }>(sql`
      select min(o.id) as id
        from import_rows o
        join import_batches b on b.id = o.batch_id
        join shows s on s.id = b.show_id
       where s.concert_id = ${ctx.concertId}
         and o.status = 'STAGED' and o.deleted_at is null
         and exists (
           select 1 from import_rows x
            where x.id = any(${`{${excludedIds.join(',')}}`}::bigint[])
              and x.batch_id = o.batch_id
              and x.party_key is not distinct from o.party_key
         )
       group by o.batch_id, o.party_key
    `);
    return rows.map((row) => Number(row.id));
  },
  async describe(tx, ctx, ids, { lock }) {
    const parties = await partiesOf(tx, ctx.concertId, ids, lock);
    const seen = new Map<string, number>();
    return ids.flatMap((id) => {
      const party = parties.get(id);
      if (!party) return [];
      const key = `${party.batchId}|${party.partyKey}`;
      const first = seen.get(key);
      if (first === undefined) seen.set(key, id);
      const rows = staged(party);
      const head = party.rows[0];
      const already = rows.filter((row) => row.issues.some((issue) => issue.code === 'ALREADY_IMPORTED')).length;
      const action = head.existingAction;
      return [
        {
          id,
          label: `${head.fields.contactName ?? 'No name'} · ${rows.length} seat${rows.length === 1 ? '' : 's'}`,
          skip: first !== undefined ? 'The same party as another row in this selection.' : partySkip(party),
          detail:
            head.existingId && action === 'SKIP'
              ? 'Skipped — the existing party is kept as it is.'
              : head.existingId && action === 'ADD_SEATS'
                ? `Added to the existing party${already > 0 ? `; ${already} already there` : ''}.`
                : 'A new party.',
        },
      ];
    });
  },
  async blastRadius(tx, ctx, ids): Promise<BlastLine[]> {
    const parties = [...(await partiesOf(tx, ctx.concertId, ids, false)).values()].filter((p) => partySkip(p) === null);
    const seats = parties.reduce((n, p) => n + staged(p).length, 0);
    const lines: BlastLine[] = [
      {
        count: seats,
        text: 'seats claimed through the capacity check, first come first served. The parties land in review.',
        tone: 'neutral',
      },
    ];
    if (parties.some((p) => p.queueReceipts)) {
      lines.push({ count: parties.length, text: 'receipts queued — this batch sends them.', tone: 'warning' });
    }
    return lines;
  },
  async apply(tx, ctx, row): Promise<Json> {
    const party = (await partiesOf(tx, ctx.concertId, [row.id], true)).get(row.id)!;
    const rows = staged(party);
    const head = party.rows[0];

    if (head.existingId && head.existingAction === 'SKIP') {
      await tx.execute(sql`
        update import_rows set status = 'SKIPPED', updated_at = now()
         where id = any(${`{${rows.map((r) => r.id).join(',')}}`}::bigint[])
      `);
      await bumpBatch(tx, party.batchId);
      return { label: row.label, skipped: rows.length, note: 'Skipped: the existing party was kept as it is.' };
    }

    await lockShowForClaim(party.showId, tx);

    // The party these seats join: the one already here, or a new one.
    let registrationId: number;
    let created = false;
    const adding = head.existingId !== null && head.existingAction === 'ADD_SEATS';
    if (adding) {
      const [live] = await tx.execute<{ id: string }>(sql`
        select id from registrations
         where id = ${head.existingId} and deleted_at is null and status <> 'CANCELLED'
         for update
      `);
      if (!live) throw new SkipItem('The existing party is gone or cancelled. Edit a cell to re-check, or choose Keep separate.');
      registrationId = Number(live.id);
    } else {
      const f = head.fields;
      const first = rows.reduce((min, r) => Math.min(min, requestedAtOf(party, r).getTime()), Infinity);
      const [inserted] = await tx.execute<{ id: string }>(sql`
        insert into registrations (
          show_id, segment_id, player_id, source, import_batch_id, contact_name, contact_email,
          status, requested_at, update_token, email_issue
        ) values (
          ${party.showId}, ${party.segmentId},
          ${party.audienceMode === 'PLAYER_INVITED' ? f.playerId : null}::bigint, 'IMPORT', ${party.batchId},
          ${f.contactName}, ${f.contactEmail}, 'WAITLIST', ${new Date(first).toISOString()}::timestamptz,
          ${mintUpdateToken()}, ${f.contactEmail ? addressShapeIssue(f.contactEmail) : null}
        )
        returning id
      `);
      registrationId = Number(inserted.id);
      created = true;
    }

    // Seats already on the party are recognised, not added twice.
    const fresh = rows.filter((r) => !(adding && r.issues.some((issue) => issue.code === 'ALREADY_IMPORTED')));
    const already = rows.filter((r) => !fresh.includes(r));

    // §9.5: base past the player's quota is requested as extra — the engine
    // waitlists surplus base rather than promoting it.
    const [quota] = await tx.execute<{ quota: number | null; claimed: number }>(sql`
      select coalesce(pa.base_quota_override,
                      (resolve_setting('allocation.base_quota', ${party.segmentId}::bigint) #>> '{}')::int) as quota,
             (select count(*)::int from attendees a join registrations r on r.id = a.registration_id
               where a.segment_id = ${party.segmentId} and a.allocation_type = 'BASE' and a.status = 'CONFIRMED'
                 and a.deleted_at is null and r.deleted_at is null and r.status <> 'CANCELLED'
                 and r.player_id = rr.player_id) as claimed
        from registrations rr
        left join player_allocations pa on pa.player_id = rr.player_id and pa.segment_id = ${party.segmentId}
       where rr.id = ${registrationId}
    `);
    let baseLeft = quota?.quota == null ? 0 : Math.max(0, quota.quota - quota.claimed);
    let promoted = 0;
    const requests: SeatRequest[] = fresh.map((r) => {
      let type = r.fields.allocationType ?? 'EXTRA';
      if (type === 'BASE') {
        if (baseLeft > 0) baseLeft -= 1;
        else if (quota?.quota != null) {
          type = 'EXTRA';
          promoted += 1;
        }
      }
      return {
        fullName: r.fields.attendeeName,
        email: r.fields.attendeeEmail,
        allocationType: type,
        requestedAt: requestedAtOf(party, r),
      };
    });

    const [before] = await tx.execute<{ max_id: string | null }>(sql`
      select max(id) as max_id from attendees where registration_id = ${registrationId}
    `);
    if (requests.length > 0) {
      await claimSeats(party.segmentId, registrationId, requests, { executor: tx });
      const createdSeats = await tx.execute<{ id: string }>(sql`
        select id from attendees
         where registration_id = ${registrationId} and id > ${Number(before?.max_id ?? 0)}
         order by id
      `);
      for (let i = 0; i < createdSeats.length && i < fresh.length; i += 1) {
        await tx.execute(sql`
          update attendees set import_row_id = ${fresh[i].id} where id = ${Number(createdSeats[i].id)}
        `);
      }
    }
    await recomputeStatus(tx, registrationId);

    if (fresh.length > 0) {
      await tx.execute(sql`
        update import_rows set status = 'COMMITTED', registration_id = ${registrationId}, committed_at = now(), updated_at = now()
         where id = any(${`{${fresh.map((r) => r.id).join(',')}}`}::bigint[])
      `);
    }
    if (already.length > 0) {
      await tx.execute(sql`
        update import_rows set status = 'SKIPPED', registration_id = ${registrationId}, updated_at = now()
         where id = any(${`{${already.map((r) => r.id).join(',')}}`}::bigint[])
      `);
    }

    // Imports land in the same review queue as the forms (§25.4); seats added
    // to a party are a new claim on it.
    if (fresh.length > 0) {
      await reviewAtIntake(tx, registrationId, { resetApproval: !created });
      if (party.queueReceipts) await queueReceipt(tx, registrationId);
    }
    await ctx.audit({
      action: created ? 'registration.imported' : 'registration.seats_imported',
      entityType: 'registration',
      entityId: registrationId,
      after: { batchId: party.batchId, seats: fresh.length, alreadyThere: already.length, promotedToExtra: promoted },
    });
    await bumpBatch(tx, party.batchId);
    return {
      label: row.label,
      registrationId,
      seats: fresh.length,
      note:
        already.length > 0
          ? `${already.length} seat${already.length === 1 ? ' was' : 's were'} already on the party.`
          : promoted > 0
            ? `${promoted} base seat${promoted === 1 ? '' : 's'} past the quota requested as extra.`
            : null,
    };
  },
});

/** Keep the batch's counts true, and close it once nothing is left staged. */
async function bumpBatch(tx: Tx, batchId: number) {
  await tx.execute(sql`
    update import_batches b
       set created_count = (select count(*)::int from import_rows where batch_id = b.id and status = 'COMMITTED'),
           skipped_count = (select count(*)::int from import_rows where batch_id = b.id and status = 'SKIPPED'),
           status = case when exists (select 1 from import_rows where batch_id = b.id and status = 'STAGED' and deleted_at is null)
                         then b.status else 'COMMITTED'::import_status end,
           updated_at = now()
     where b.id = ${batchId}
  `);
}

// ---------------------------------------------------------------------------
// Undo import
// ---------------------------------------------------------------------------

const undoFilter = z.object({ batchId: idSchema }).strict();

type BatchFacts = {
  id: number;
  filename: string;
  status: string;
  parties: number;
  addedSeats: number;
  delivered: number;
  admitted: number;
};

async function batchFacts(tx: Tx, concertId: number, ids: number[], lock: boolean): Promise<Map<number, BatchFacts>> {
  if (ids.length === 0) return new Map();
  const list = sql`${`{${ids.join(',')}}`}::bigint[]`;
  const rows = await tx.execute<{
    id: string;
    filename: string;
    status: string;
    parties: number;
    added_seats: number;
    delivered: number;
    admitted: number;
  }>(sql`
    select b.id, b.filename, b.status::text as status,
           (select count(*)::int from registrations r where r.import_batch_id = b.id and r.deleted_at is null) as parties,
           (select count(*)::int from attendees a join import_rows ir on ir.id = a.import_row_id
              join registrations r on r.id = a.registration_id
             where ir.batch_id = b.id and a.deleted_at is null
               and r.import_batch_id is distinct from b.id) as added_seats,
           (select count(*)::int from attendees a join import_rows ir on ir.id = a.import_row_id
             where ir.batch_id = b.id and a.deleted_at is null and a.ticket_sent_at is not null) as delivered,
           (select count(*)::int from attendees a join import_rows ir on ir.id = a.import_row_id
              join check_ins c on c.attendee_id = a.id and c.reverted_at is null
             where ir.batch_id = b.id and a.deleted_at is null) as admitted
      from import_batches b join shows s on s.id = b.show_id
     where b.id = any(${list}) and s.concert_id = ${concertId}
     ${lock ? sql`for update of b` : sql``}
  `);
  return new Map(
    rows.map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        filename: row.filename,
        status: row.status,
        parties: row.parties,
        addedSeats: row.added_seats,
        delivered: row.delivered,
        admitted: row.admitted,
      },
    ]),
  );
}

const undoImport = defineCommand({
  name: 'intake.undo_import',
  entityType: 'import_batch',
  verb: 'Undo import',
  noun: { one: 'import', many: 'imports' },
  irreversible: true,
  filter: undoFilter,
  params: z.object({}).strict(),
  match: async (_tx, _ctx, filter) => [filter.batchId],
  async describe(tx, ctx, ids, { lock }) {
    const facts = await batchFacts(tx, ctx.concertId, ids, lock);
    return ids.flatMap((id) => {
      const batch = facts.get(id);
      if (!batch) return [];
      return [
        {
          id,
          label: batch.filename,
          skip:
            batch.status === 'UNDONE'
              ? 'Already undone.'
              : batch.status === 'DRY_RUN'
                ? 'A dry run wrote nothing.'
                : batch.admitted > 0
                  ? `${batch.admitted} guest(s) from this import are already inside. Undo their check-in first.`
                  : null,
          detail: `${batch.parties} parties, ${batch.addedSeats} seats added to other parties`,
        },
      ];
    });
  },
  async blastRadius(tx, ctx, ids): Promise<BlastLine[]> {
    const all = [...(await batchFacts(tx, ctx.concertId, ids, false)).values()];
    const lines: BlastLine[] = [];
    const parties = all.reduce((n, b) => n + b.parties, 0);
    const added = all.reduce((n, b) => n + b.addedSeats, 0);
    const delivered = all.reduce((n, b) => n + b.delivered, 0);
    if (parties > 0) lines.push({ count: parties, text: 'parties this import created go to the Trash, with their seats.', tone: 'warning' });
    if (added > 0) lines.push({ count: added, text: 'seats it added to parties that already existed are cancelled and removed.', tone: 'warning' });
    if (delivered > 0) {
      lines.push({ count: delivered, text: 'tickets already delivered — their QR codes will be refused at the door.', tone: 'danger' });
    }
    lines.push({ count: all.length, text: 'import closed: its staged rows can no longer be committed.', tone: 'neutral' });
    return lines;
  },
  async apply(tx, ctx, row) {
    const parties = await tx.execute<{ id: string }>(sql`
      select id from registrations where import_batch_id = ${row.id} and deleted_at is null order by id for update
    `);
    const partyIds = parties.map((p) => Number(p.id));
    if (partyIds.length > 0) {
      const list = sql`${`{${partyIds.join(',')}}`}::bigint[]`;
      await tx.execute(sql`
        update email_outbox set status = 'CANCELLED', updated_at = now()
         where registration_id = any(${list}) and status in ('DRAFT', 'QUEUED')
      `);
      // The soft delete cascades to the seats (`registrations_cancel_cascade`).
      await tx.execute(sql`update registrations set deleted_at = now() where id = any(${list})`);
    }
    const added = await tx.execute<{ registration_id: string }>(sql`
      update attendees a
         set status = 'CANCELLED', deleted_at = now()
        from import_rows ir
       where ir.id = a.import_row_id and ir.batch_id = ${row.id}
         and a.deleted_at is null
      returning a.registration_id
    `);
    for (const registrationId of new Set(added.map((a) => Number(a.registration_id)))) {
      await recomputeStatus(tx, registrationId);
    }
    await tx.execute(sql`
      update import_rows set status = 'SKIPPED', updated_at = now()
       where batch_id = ${row.id} and status = 'STAGED'
    `);
    await tx.execute(sql`update import_batches set status = 'UNDONE', updated_at = now() where id = ${row.id}`);
    await ctx.audit({
      action: 'import.undone',
      entityType: 'import_batch',
      entityId: row.id,
      after: { parties: partyIds.length, seatsRemoved: added.length },
    });
    return { label: row.label, parties: partyIds.length, seats: added.length };
  },
});

export const IMPORT_COMMANDS: AnyCommand[] = [commitRows, undoImport];
