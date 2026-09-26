import 'server-only';
import { sql } from 'drizzle-orm';
import type { Executor } from '@/db/allocation';

/**
 * Which ticket design a seat is issued with (spec/tickets.md §10.5, v3 §24.2).
 *
 * **One resolver.** `seats.issue`, `seats.reissue` and the send wizard's
 * design step all pin through here, so the design the wizard shows as the
 * default is the design a plain Issue would have pinned.
 *
 * The cascade, first match wins: the segment's `default_ticket_template_id`,
 * then the show's `ticket_template_id`, then the concert's
 * `ticket.default_template_id` through the settings cascade, then the concert's
 * seeded default. A soft-deleted design is passed over at every level.
 */

export type Design = { id: number; version: number };

export class NoTicketDesignError extends Error {
  constructor() {
    super('This concert has no ticket design yet. Open Ticket designs once to create the default.');
    this.name = 'NoTicketDesignError';
  }
}

/** The default design for every seat in `segmentId`. */
export async function designForSegment(executor: Executor, segmentId: number): Promise<Design> {
  const [row] = await executor.execute<{ id: string | null; version: number | null }>(sql`
    with segment as (
      select g.id, s.concert_id, g.default_ticket_template_id, s.ticket_template_id
        from show_segments g
        join shows s on s.id = g.show_id
       where g.id = ${segmentId}
    ),
    chosen as (
      select t.id, t.version, 1 as rank from segment
        join ticket_templates t on t.id = segment.default_ticket_template_id and t.deleted_at is null
      union all
      select t.id, t.version, 2 from segment
        join ticket_templates t on t.id = segment.ticket_template_id and t.deleted_at is null
      union all
      select t.id, t.version, 3 from segment
        join ticket_templates t
          on t.id = (resolve_setting('ticket.default_template_id', null, null, segment.concert_id)
                      #>> '{}')::bigint
         and t.deleted_at is null
      union all
      select t.id, t.version, 4 from segment
        join ticket_templates t on t.concert_id = segment.concert_id and t.is_default and t.deleted_at is null
    )
    select id, version from chosen order by rank, version desc limit 1
  `);
  if (!row?.id) throw new NoTicketDesignError();
  return { id: Number(row.id), version: row.version! };
}

/** The default design for one seat: its segment's (§10.5). */
export async function designFor(executor: Executor, seatId: number): Promise<Design> {
  const [row] = await executor.execute<{ segment_id: string }>(sql`
    select segment_id from attendees where id = ${seatId}
  `);
  if (!row) throw new Error(`Seat ${seatId} does not exist.`);
  return designForSegment(executor, Number(row.segment_id));
}

/**
 * A design the admin chose by id, at its current version — or null when it is
 * gone or belongs to another concert (a global design, `concert_id` null, is
 * anyone's), so a stale choice from an open wizard
 * cannot pin a design from somewhere else.
 */
export async function chosenDesign(
  executor: Executor,
  concertId: number,
  templateId: number,
): Promise<Design | null> {
  const [row] = await executor.execute<{ id: string; version: number }>(sql`
    select id, version from ticket_templates
     where id = ${templateId} and deleted_at is null
       and (concert_id = ${concertId} or concert_id is null)
  `);
  return row ? { id: Number(row.id), version: row.version } : null;
}
