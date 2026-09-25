import 'server-only';
import { sql } from 'drizzle-orm';
import { promoteSeats } from '@/db/allocation';
import { recomputeStatus } from '@/lib/registrations/mutations';
import {
  defineCommand,
  SkipItem,
  type AnyCommand,
  type BlastLine,
  type Tx,
} from '@/lib/commands/define';
import { z } from 'zod';
import {
  KIND_ENTITY,
  KIND_LABEL,
  TRASH_KINDS,
  matchTrash,
  trashFilterSchema,
  trashRowsFor,
  type TrashKind,
} from './queries';

/**
 * Restore and Delete permanently, for every kind the Trash lists
 * (spec/v3.md §23.6, decision 46).
 *
 * Both are commands, so both preview, run per row, and report (§23.1).
 *
 * **Restore is reversible and re-decides.** A restored row comes back as it
 * was, except where that would bypass a rule that protects the data (§23.4):
 * a seat that was confirmed when it was deleted is offered back to
 * `promote_seats()` rather than simply undeleted, because the room may have
 * been given away since. If it no longer fits it comes back waitlisted, with
 * the engine's sentence explaining why.
 *
 * **Delete permanently is a real `DELETE`, irreversible**, so it takes the typed
 * confirmation above `admin.typed_confirm_above` (§23.3), and its blast radius
 * counts what the foreign keys will take with it. Those cascades reach further
 * than the Trash suggests (`0200`'s handoff), so each kind refuses — per row, as
 * a skip with a reason — where a delete would damage something that is not in
 * the Trash:
 *
 * - a party or seat with a guest admitted at the door: the check-in would be
 *   erased and the arrivals count would drop a person the ushers saw;
 * - a form that a live party registered through: its responses are the
 *   receipts of what people typed (`domain.md` §5.1);
 * - a player a live party is linked to: unlinking changes that party's quota;
 * - a ticket design any ticket is pinned to: `set null` would silently unpin
 *   it (`tickets.md` §10.5);
 * - a message being sent right now.
 *
 * The audit row a permanent delete leaves records what was removed — counts
 * and ids — and never the personal data it removed (§23.6).
 */

const idArray = (ids: number[]) => sql`${`{${ids.join(',')}}`}::bigint[]`;

/** The table behind each kind, for locking the rows a command is about to change. */
const TABLE: Record<TrashKind, string> = {
  party: 'registrations',
  seat: 'attendees',
  message: 'email_outbox',
  form: 'registration_forms',
  player: 'players',
  ticket_template: 'ticket_templates',
};

async function lockRows(tx: Tx, kind: TrashKind, ids: number[]): Promise<void> {
  await tx.execute(sql`
    select id from ${sql.identifier(TABLE[kind])}
     where id = any(${idArray(ids)})
     for update
  `);
}

type Blocked = Map<number, string>;

async function blocked(tx: Tx, query: ReturnType<typeof sql>): Promise<Blocked> {
  const rows = await tx.execute<{ id: string; reason: string }>(query);
  return new Map(rows.map((row) => [Number(row.id), row.reason]));
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function restoreBlocks(tx: Tx, kind: TrashKind, ids: number[]): Promise<Blocked> {
  const any = idArray(ids);
  switch (kind) {
    case 'party':
      return blocked(tx, sql`
        select r.id,
               case
                 when r.merged_into_id is not null
                   then 'Merged into another party. Undo the merge instead.'
                 else 'Its show or segment has been deleted.'
               end as reason
          from registrations r
          join shows s on s.id = r.show_id
          join show_segments g on g.id = r.segment_id
         where r.id = any(${any})
           and (r.merged_into_id is not null
                or s.deleted_at is not null or g.deleted_at is not null)`);
    case 'seat':
      return blocked(tx, sql`
        select a.id,
               case
                 when r.status = 'CANCELLED'
                   then 'Its party is cancelled. Restore the party first.'
                 else 'Its show or segment has been deleted.'
               end as reason
          from attendees a
          join registrations r on r.id = a.registration_id
          join shows s on s.id = a.show_id
          join show_segments g on g.id = a.segment_id
         where a.id = any(${any})
           and (r.status = 'CANCELLED' or s.deleted_at is not null or g.deleted_at is not null)`);
    case 'message':
      return blocked(tx, sql`
        select o.id,
               case
                 when r.deleted_at is not null
                   then 'Its party is in the Trash. Restore the party first.'
                 else 'Its player is in the Trash. Restore the player first.'
               end as reason
          from email_outbox o
          left join registrations r on r.id = o.registration_id
          left join players p on p.id = o.player_id
         where o.id = any(${any})
           and (r.deleted_at is not null or p.deleted_at is not null)`);
    case 'form':
      return blocked(tx, sql`
        select f.id, 'Its show or segment has been deleted.' as reason
          from registration_forms f
          left join show_segments g on g.id = f.segment_id
          join shows s on s.id = coalesce(f.show_id, g.show_id)
         where f.id = any(${any})
           and (s.deleted_at is not null or g.deleted_at is not null)`);
    case 'player':
    case 'ticket_template':
      return Promise.resolve(new Map());
  }
}

async function restoreBlast(tx: Tx, kind: TrashKind, ids: number[]): Promise<BlastLine[]> {
  if (kind !== 'party' && kind !== 'seat') return [];
  const [row] = await tx.execute<{ confirmed: number; delivered: number }>(
    kind === 'party'
      ? sql`
          select count(*) filter (where a.status = 'CONFIRMED')::int as confirmed,
                 count(*) filter (where a.status = 'CONFIRMED'
                                    and a.ticket_sent_at is not null)::int as delivered
            from registrations r
            join attendees a on a.registration_id = r.id and a.deleted_at = r.deleted_at
           where r.id = any(${idArray(ids)})`
      : sql`
          select count(*) filter (where a.ticket_code is not null)::int as confirmed,
                 count(*) filter (where a.ticket_sent_at is not null)::int as delivered
            from attendees a
           where a.id = any(${idArray(ids)})`,
  );
  const lines: BlastLine[] = [];
  if (row.confirmed > 0) {
    lines.push({
      count: row.confirmed,
      text:
        (kind === 'party' ? 'confirmed seats' : 'seats') +
        ' will be checked against capacity again. Any that no longer fit come back waitlisted.',
      tone: 'warning',
    });
  }
  if (row.delivered > 0) {
    lines.push({
      count: row.delivered,
      text: 'tickets were already delivered. Their QR codes work again only if the seat is confirmed.',
      tone: 'neutral',
    });
  }
  if (kind === 'party') {
    const [messages] = await tx.execute<{ cancelled: number }>(sql`
      select count(*)::int as cancelled from email_outbox
       where registration_id = any(${idArray(ids)}) and status = 'CANCELLED'
    `);
    if (messages.cancelled > 0) {
      lines.push({
        count: messages.cancelled,
        text: 'cancelled messages stay cancelled. Send tickets again if they are needed.',
        tone: 'neutral',
      });
    }
  }
  return lines;
}

/**
 * Offer seats to the engine as the restore's last step, so the room decides
 * whether they fit (§23.4). Confirmed seats were parked on the waitlist first:
 * `promote_seats()` moves only seats that are not confirmed, and confirms all
 * or none.
 */
async function redecide(tx: Tx, segmentId: number, seatIds: number[]) {
  if (seatIds.length === 0) return { confirmed: 0, waitlisted: 0, refused: null };
  const outcome = await promoteSeats(segmentId, seatIds, { executor: tx });
  return {
    confirmed: outcome.confirmed,
    waitlisted: seatIds.length - outcome.confirmed,
    refused: outcome.refused ? outcome.reason : null,
  };
}

async function restoreOne(tx: Tx, kind: TrashKind, id: number) {
  switch (kind) {
    case 'party': {
      const [party] = await tx.execute<{ deleted_at: string; segment_id: string }>(sql`
        select deleted_at::text, segment_id from registrations where id = ${id}
      `);
      // The seats that left with the party, identified by the same instant.
      // A seat removed on its own earlier stays in the Trash as a seat.
      const seats = await tx.execute<{ id: string; was_confirmed: boolean }>(sql`
        with restored as (
          update attendees a
             set deleted_at = null,
                 status = case when a.status = 'CONFIRMED' then 'WAITLIST'::booking_status
                               else a.status end
            from (select id, status = 'CONFIRMED' as was_confirmed
                    from attendees
                   where registration_id = ${id}
                     and deleted_at::text = ${party.deleted_at}) prior
           where a.id = prior.id
          returning a.id, prior.was_confirmed
        )
        select id, was_confirmed from restored
      `);
      await tx.execute(sql`update registrations set deleted_at = null where id = ${id}`);

      const decided = await redecide(
        tx,
        Number(party.segment_id),
        seats.filter((seat) => seat.was_confirmed).map((seat) => Number(seat.id)),
      );
      await recomputeStatus(tx, id);
      return {
        seats: seats.length,
        ...decided,
        // Shown in the report (`RunReportView`): a restore that came back
        // waitlisted is done, but not what the admin will assume "done" means.
        note: decided.refused ? `Came back waitlisted: ${decided.refused}` : null,
      };
    }
    case 'seat': {
      // The seat's status before it was removed is gone (`removeAttendee()`
      // cancels it), so it is decided the way a new seat on this party would
      // be, and never ahead of the party it belongs to:
      //
      // - an extra in a REVIEW segment goes back to review, as §7.5 requires
      //   of every extra there;
      // - a seat whose party holds no confirmed seat waits with its party
      //   rather than jumping the queue the party is in;
      // - otherwise the engine decides whether it fits.
      const [seat] = await tx.execute<{
        segment_id: string;
        registration_id: string;
        allocation_type: string;
        policy: string | null;
        party_confirmed: boolean;
      }>(sql`
        select a.segment_id, a.registration_id, a.allocation_type,
               (resolve_setting('allocation.extras_policy', a.segment_id) #>> '{}') as policy,
               exists (select 1 from attendees x
                        where x.registration_id = a.registration_id
                          and x.id <> a.id
                          and x.status = 'CONFIRMED'
                          and x.deleted_at is null) as party_confirmed
          from attendees a
         where a.id = ${id}
      `);
      const review = seat.allocation_type === 'EXTRA' && seat.policy === 'REVIEW';
      await tx.execute(sql`
        update attendees
           set deleted_at = null,
               status = ${review ? 'PENDING_REVIEW' : 'WAITLIST'}::booking_status
         where id = ${id}
      `);

      let outcome: { confirmed: number; waitlisted: number; pendingReview: number; note: string | null };
      if (review) {
        outcome = { confirmed: 0, waitlisted: 0, pendingReview: 1, note: 'Back in extras review.' };
      } else if (!seat.party_confirmed) {
        outcome = {
          confirmed: 0,
          waitlisted: 1,
          pendingReview: 0,
          note: 'Waitlisted with its party, which holds no confirmed seat.',
        };
      } else {
        const decided = await redecide(tx, Number(seat.segment_id), [id]);
        outcome = {
          confirmed: decided.confirmed,
          waitlisted: decided.waitlisted,
          pendingReview: 0,
          note: decided.refused ? `Came back waitlisted: ${decided.refused}` : null,
        };
      }
      await recomputeStatus(tx, Number(seat.registration_id));
      return outcome;
    }
    default:
      await tx.execute(sql`
        update ${sql.identifier(TABLE[kind])} set deleted_at = null where id = ${id}
      `);
      return {};
  }
}

// ---------------------------------------------------------------------------
// Delete permanently
// ---------------------------------------------------------------------------

function purgeBlocks(tx: Tx, kind: TrashKind, ids: number[]): Promise<Blocked> {
  const any = idArray(ids);
  switch (kind) {
    case 'party':
    case 'seat':
      return blocked(tx, sql`
        ${
          kind === 'party'
            ? sql`select o.registration_id as id,
                         'A message to this party is being sent right now.' as reason
                    from email_outbox o
                   where o.registration_id = any(${any}) and o.status = 'SENDING'
                  union all`
            : sql``
        }
        select ${kind === 'party' ? sql`a.registration_id` : sql`a.id`} as id,
               count(*) || ' guest(s) admitted at the door. Undo the check-in first, '
                 || 'or the admission would be erased.' as reason
          from attendees a
          join check_ins c on c.attendee_id = a.id and c.reverted_at is null
         where ${kind === 'party' ? sql`a.registration_id` : sql`a.id`} = any(${any})
         group by 1`);
    case 'message':
      return blocked(tx, sql`
        select id, 'Being sent right now.' as reason
          from email_outbox
         where id = any(${any}) and status = 'SENDING'`);
    case 'form':
      return blocked(tx, sql`
        select fr.form_id as id,
               count(distinct r.id) || ' live part' ||
                 case when count(distinct r.id) = 1 then 'y' else 'ies' end ||
                 ' registered through this form. Their responses would be erased.' as reason
          from form_responses fr
          join registrations r on r.form_response_id = fr.id and r.deleted_at is null
         where fr.form_id = any(${any})
         group by fr.form_id`);
    case 'player':
      return blocked(tx, sql`
        select o.player_id as id, 'A message to this player is being sent right now.' as reason
          from email_outbox o
         where o.player_id = any(${any}) and o.status = 'SENDING'
        union all
        select r.player_id as id,
               count(*) || ' live part' || case when count(*) = 1 then 'y is' else 'ies are' end ||
                 ' linked to this player. Deleting would change their quota.' as reason
          from registrations r
         where r.player_id = any(${any}) and r.deleted_at is null
         group by r.player_id`);
    case 'ticket_template':
      return blocked(tx, sql`
        select a.ticket_template_id as id,
               count(*) || ' ticket(s) pinned to this design. Deleting would unpin them.' as reason
          from attendees a
         where a.ticket_template_id = any(${any})
         group by a.ticket_template_id`);
  }
}

async function purgeBlast(
  tx: Tx,
  kind: TrashKind,
  ids: number[],
  concertId: number,
): Promise<BlastLine[]> {
  const any = idArray(ids);
  const label = KIND_LABEL[kind];
  const lines: BlastLine[] = [
    {
      count: ids.length,
      text: `${ids.length === 1 ? label.one : label.many} deleted for good, with the personal data they hold.`,
      tone: 'danger',
    },
  ];
  const add = (count: number, text: string, tone: BlastLine['tone']) => {
    if (count > 0) lines.push({ count, text, tone });
  };

  if (kind === 'party' || kind === 'seat') {
    const seatScope =
      kind === 'party' ? sql`a.registration_id = any(${any})` : sql`a.id = any(${any})`;
    const [row] = await tx.execute<{
      seats: number;
      delivered: number;
      reverted: number;
      notes: number;
      feedback: number;
    }>(sql`
      select count(*)::int as seats,
             count(*) filter (where a.ticket_sent_at is not null)::int as delivered,
             (select count(*)::int from check_ins c
               join attendees x on x.id = c.attendee_id
              where ${kind === 'party' ? sql`x.registration_id` : sql`x.id`} = any(${any})) as reverted,
             (select count(*)::int from portal_notes n
               join attendees x on x.id = n.attendee_id
              where ${kind === 'party' ? sql`x.registration_id` : sql`x.id`} = any(${any})) as notes,
             (select count(*)::int from feedback_responses f
               join attendees x on x.id = f.attendee_id
              where ${kind === 'party' ? sql`x.registration_id` : sql`x.id`} = any(${any})) as feedback
        from attendees a
       where ${seatScope}
    `);
    if (kind === 'party') add(row.seats, 'seats deleted with them.', 'warning');
    add(
      row.delivered,
      'tickets already delivered. Their QR codes will never resolve at the door again.',
      'danger',
    );
    add(row.reverted, 'reverted check-ins erased from the door log.', 'warning');
    add(row.notes, 'portal notes deleted.', 'warning');
    add(row.feedback, 'feedback responses deleted.', 'warning');
  }

  if (kind === 'party') {
    const [row] = await tx.execute<{ messages: number; conversation: number; responses: number }>(sql`
      select (select count(*)::int from email_outbox o where o.registration_id = any(${any})) as messages,
             (select count(*)::int from email_messages m
               join email_threads t on t.id = m.thread_id
              where t.registration_id = any(${any})) as conversation,
             (select count(*)::int from form_responses fr
               join registrations r on r.form_response_id = fr.id
              where r.id = any(${any})) as responses
    `);
    add(row.messages, 'messages removed from history.', 'warning');
    add(row.conversation, 'emails in their conversation deleted.', 'warning');
    add(row.responses, 'form responses, with their edit history, deleted.', 'warning');
  }

  if (kind === 'message') {
    const [row] = await tx.execute<{ sent: number }>(sql`
      select count(*) filter (where status in ('SENT', 'BOUNCED'))::int as sent
        from email_outbox where id = any(${any})
    `);
    add(row.sent, 'of them were sent. The record of sending them is removed.', 'warning');
  }

  if (kind === 'form') {
    const [row] = await tx.execute<{ responses: number; feedback: number }>(sql`
      select (select count(*)::int from form_responses where form_id = any(${any})) as responses,
             (select count(*)::int from feedback_responses where form_id = any(${any})) as feedback
    `);
    add(row.responses, 'form responses, the record of what people typed, deleted.', 'danger');
    add(row.feedback, 'feedback responses deleted.', 'danger');
  }

  if (kind === 'player') {
    const [row] = await tx.execute<{ invites: number; allocations: number; threads: number; unlinked: number }>(sql`
      select (select count(*)::int from email_outbox where player_id = any(${any})) as invites,
             (select count(*)::int from player_allocations where player_id = any(${any})) as allocations,
             (select count(*)::int from email_threads where player_id = any(${any})) as threads,
             (select count(*)::int from registrations where player_id = any(${any})) as unlinked
    `);
    add(row.invites, 'invite messages removed from history.', 'warning');
    add(row.allocations, 'quota overrides deleted.', 'warning');
    add(row.threads, 'conversations deleted.', 'warning');
    add(row.unlinked, 'parties in the Trash lose their link to the player.', 'neutral');
  }

  const [history] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log l
     where l.concert_id = ${concertId}
       and (l.before is not null or l.after is not null)
       and ${auditRefs(kind, ids)}
  `);
  add(history.n, 'earlier Activity entries keep what happened and when, but lose the details they recorded.', 'neutral');

  if (kind === 'ticket_template') {
    const [row] = await tx.execute<{ defaults: number }>(sql`
      select (select count(*)::int from shows where ticket_template_id = any(${any}))
           + (select count(*)::int from show_segments
               where default_ticket_template_id = any(${any})) as defaults
    `);
    add(row.defaults, 'shows or segments stop naming it as their design.', 'warning');
  }

  return lines;
}

/**
 * The audit rows about the rows a purge removes, as a condition on `audit_log`.
 *
 * Deleting a person for good has to reach the history too: `player.created`
 * holds the email it was created with, `registration.updated` the name it was
 * changed from. Those rows are kept — the change happened, and when — but their
 * `before` / `after` are replaced with a marker (§23.6). A party covers its
 * seats as well. Rows written in bulk with no entity id cannot be traced to a
 * person and are left as they are.
 */
function auditRefs(kind: TrashKind, ids: number[]): ReturnType<typeof sql> {
  const texts = sql`${`{${ids.join(',')}}`}::text[]`;
  switch (kind) {
    case 'party':
      return sql`(
        (l.entity_type = 'registration' and l.entity_id = any(${texts}))
        or (l.entity_type = 'attendee' and l.entity_id in (
              select a.id::text from attendees a where a.registration_id = any(${idArray(ids)}))))`;
    case 'player':
      return sql`(l.entity_type in ('player', 'players') and l.entity_id = any(${texts}))`;
    default:
      return sql`(l.entity_type = ${KIND_ENTITY[kind]} and l.entity_id = any(${texts}))`;
  }
}

const REDACTED = sql`'{"redacted":"deleted permanently"}'::jsonb`;

async function redactHistory(tx: Tx, kind: TrashKind, id: number, concertId: number) {
  await tx.execute(sql`
    update audit_log l
       set before = case when l.before is null then null else ${REDACTED} end,
           after  = case when l.after  is null then null else ${REDACTED} end
     where l.concert_id = ${concertId}
       and ${auditRefs(kind, [id])}
  `);
  // A restore's report named the row it restored; the name goes too.
  await tx.execute(sql`
    update command_run_items i
       set outcome = i.outcome - 'label'
      from command_runs r
     where r.id = i.run_id
       and r.concert_id = ${concertId}
       and i.entity_type = ${KIND_ENTITY[kind]}
       and i.entity_id = ${id}
       and i.outcome ? 'label'
  `);
}

async function purgeOne(tx: Tx, kind: TrashKind, id: number, concertId: number) {
  // Before the delete: a party's seats are found through the rows about to go.
  await redactHistory(tx, kind, id, concertId);
  if (kind === 'party') {
    // The party's form response and the edits it superseded — except any
    // response another party's own chain also passes through. Two parties can
    // share history (an edit that split a party, a merge undone), and deleting
    // a shared ancestor would cut the other party's record of what was typed.
    const chain = await tx.execute<{ id: string }>(sql`
      with recursive mine(id) as (
        select form_response_id from registrations
         where id = ${id} and form_response_id is not null
        union
        select fr.supersedes_id from form_responses fr
          join mine m on m.id = fr.id
         where fr.supersedes_id is not null
      ),
      others(id) as (
        select r.form_response_id from registrations r
         where r.id <> ${id}
           and r.form_response_id is not null
           and r.form_response_id in (
             select x.id from form_responses x
              where x.form_id in (select f.form_id from form_responses f where f.id in (select id from mine)))
        union
        select fr.supersedes_id from form_responses fr
          join others o on o.id = fr.id
         where fr.supersedes_id is not null
      )
      select id from mine
      except
      select id from others
    `);
    const [counts] = await tx.execute<{ seats: number; messages: number }>(sql`
      select (select count(*)::int from attendees where registration_id = ${id}) as seats,
             (select count(*)::int from email_outbox where registration_id = ${id}) as messages
    `);
    await tx.execute(sql`delete from registrations where id = ${id} and deleted_at is not null`);
    if (chain.length > 0) {
      await tx.execute(sql`
        delete from form_responses where id = any(${idArray(chain.map((row) => Number(row.id)))})
      `);
    }
    return { ...counts, responses: chain.length };
  }

  const deleted = await tx.execute<{ id: string }>(sql`
    delete from ${sql.identifier(TABLE[kind])}
     where id = ${id} and deleted_at is not null
    returning id
  `);
  if (deleted.length === 0) throw new SkipItem('No longer in the Trash.');
  return {};
}

// ---------------------------------------------------------------------------
// The definitions
// ---------------------------------------------------------------------------

const noParams = z.object({}).strict();

function trashCommand(kind: TrashKind, mode: 'restore' | 'purge'): AnyCommand {
  const label = KIND_LABEL[kind];
  const entityType = KIND_ENTITY[kind];

  return defineCommand({
    name: `trash.${mode}.${kind}`,
    entityType,
    verb: mode === 'restore' ? 'Restore' : 'Delete permanently',
    noun: { one: label.one, many: label.many },
    irreversible: mode === 'purge',
    filter: trashFilterSchema,
    params: noParams,

    match: (tx, ctx, filter) => matchTrash(tx, kind, ctx.concertId, filter),

    async describe(tx, ctx, ids, { lock }) {
      if (lock) await lockRows(tx, kind, ids);
      const rows = await trashRowsFor(tx, kind, ctx.concertId, ids);
      const inTrash = [...rows.keys()];
      const blocks =
        inTrash.length === 0
          ? new Map<number, string>()
          : await (mode === 'restore' ? restoreBlocks : purgeBlocks)(tx, kind, inTrash);
      return ids
        .filter((id) => rows.has(id))
        .map((id) => {
          const row = rows.get(id)!;
          return { id, label: row.label, detail: row.detail, skip: blocks.get(id) ?? null };
        });
    },

    blastRadius: (tx, ctx, ids) =>
      mode === 'restore' ? restoreBlast(tx, kind, ids) : purgeBlast(tx, kind, ids, ctx.concertId),

    async apply(tx, ctx, row) {
      const outcome = mode === 'restore' ? await restoreOne(tx, kind, row.id) : await purgeOne(tx, kind, row.id, ctx.concertId);
      await ctx.audit({
        action: `${entityType}.${mode === 'restore' ? 'restored' : 'purged'}`,
        entityType,
        entityId: row.id,
        // What was removed, never the personal data it held (§23.6).
        after: outcome,
      });
      // A restored row is named in the report; a purged one only by id, because
      // the report outlives the data it would otherwise repeat.
      return { ...outcome, label: mode === 'restore' ? row.label : `#${row.id}` };
    },
  });
}

export const TRASH_COMMANDS: AnyCommand[] = TRASH_KINDS.flatMap((kind) => [
  trashCommand(kind, 'restore'),
  trashCommand(kind, 'purge'),
]);

export const trashCommandName = (kind: TrashKind, mode: 'restore' | 'purge') =>
  `trash.${mode}.${kind}`;
