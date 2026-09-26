import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import { TEMPLATE_PURPOSE } from '@/lib/email/templates';
import { designForSegment, NoTicketDesignError } from '@/lib/tickets/design';
import { defaultTemplateFor } from './purposes';

/**
 * A segment's delivery defaults (spec/v3.md §24.2): the ticket design its seats
 * are issued with (`show_segments.default_ticket_template_id`, the segment
 * level of `ticket.default_template_id`'s cascade) and the template its ticket
 * email is worded with (`segment_message_defaults`, purpose `TICKETS`). Both
 * are what the send wizard starts from; either can be changed per send.
 *
 * Null means "no choice here": the design falls through to the show's and the
 * concert's, the template to §24.2's table by audience.
 */

export type SegmentDelivery = {
  segmentId: number;
  label: string;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  designId: number | null;
  ticketTemplate: string | null;
  /** What applies when nothing is chosen here, for the "inherit" option's label. */
  inherited: { designLabel: string | null; template: string };
  designs: { id: number; label: string }[];
  templates: { key: string; name: string }[];
};

const TICKET_KEYS = Object.entries(TEMPLATE_PURPOSE)
  .filter(([, purpose]) => purpose === 'TICKETS')
  .map(([key]) => key);

export async function loadSegmentDelivery(concertId: number, segmentId: number): Promise<SegmentDelivery | null> {
  const db = getDb();
  const [segment] = await db.execute<{
    label: string;
    audience_mode: 'PLAYER_INVITED' | 'PUBLIC';
    design_id: string | null;
    ticket_template: string | null;
  }>(sql`
    select s.name || ' · ' || g.name as label, g.audience_mode, g.default_ticket_template_id as design_id,
           d.template_key as ticket_template
      from show_segments g
      join shows s on s.id = g.show_id
      left join segment_message_defaults d
        on d.segment_id = g.id and d.purpose = 'TICKETS' and d.deleted_at is null
     where g.id = ${segmentId} and s.concert_id = ${concertId}
       and g.deleted_at is null and s.deleted_at is null
  `);
  if (!segment) return null;

  const designs = await db.execute<{ id: string; name: string; version: number }>(sql`
    select id, name, version from ticket_templates
     where concert_id = ${concertId} and deleted_at is null
     order by name, version desc
  `);
  const templates = await db.execute<{ key: string; name: string }>(sql`
    select key, name from email_templates
     where key in (${sql.join(TICKET_KEYS.map((key) => sql`${key}`), sql`, `)}) and deleted_at is null
     order by name
  `);

  // What applies without a choice here: the cascade *above* the segment.
  let designLabel: string | null = null;
  try {
    const inherited = await designForSegment(db, segmentId, { aboveSegment: true });
    const found = designs.find((d) => Number(d.id) === inherited.id);
    designLabel = found ? `${found.name} · v${found.version}` : null;
  } catch (error) {
    if (!(error instanceof NoTicketDesignError)) throw error;
  }

  return {
    segmentId,
    label: segment.label,
    audienceMode: segment.audience_mode,
    designId: segment.design_id ? Number(segment.design_id) : null,
    ticketTemplate: segment.ticket_template,
    inherited: {
      designLabel,
      template: defaultTemplateFor('TICKETS', segment.audience_mode, null)!,
    },
    designs: designs.map((d) => ({ id: Number(d.id), label: `${d.name} · v${d.version}` })),
    templates: templates.map((t) => ({ key: t.key, name: t.name })),
  };
}

export class DeliveryDefaultsError extends Error {}

export async function saveSegmentDelivery(
  concertId: number,
  segmentId: number,
  choice: { designId: number | null; ticketTemplate: string | null },
  actorId: string | null,
): Promise<void> {
  const current = await loadSegmentDelivery(concertId, segmentId);
  if (!current) throw new DeliveryDefaultsError('That segment is not part of this concert.');
  if (choice.designId !== null && !current.designs.some((d) => d.id === choice.designId)) {
    throw new DeliveryDefaultsError('That ticket design is not one of this concert’s.');
  }
  if (choice.ticketTemplate !== null && !current.templates.some((t) => t.key === choice.ticketTemplate)) {
    throw new DeliveryDefaultsError('Choose a template that carries tickets.');
  }

  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      update show_segments set default_ticket_template_id = ${choice.designId}, updated_at = now()
       where id = ${segmentId}
    `);
    if (choice.ticketTemplate === null) {
      await tx.execute(sql`
        delete from segment_message_defaults where segment_id = ${segmentId} and purpose = 'TICKETS'
      `);
    } else {
      await tx.execute(sql`
        insert into segment_message_defaults (segment_id, purpose, template_key)
        values (${segmentId}, 'TICKETS', ${choice.ticketTemplate})
        on conflict (segment_id, purpose)
        do update set template_key = excluded.template_key, deleted_at = null, updated_at = now()
      `);
    }
    await writeAuditLog(
      {
        action: 'segment.delivery_defaults_changed',
        entityType: 'show_segment',
        entityId: segmentId,
        before: { designId: current.designId, ticketTemplate: current.ticketTemplate },
        after: choice,
        actorId,
        concertId,
      },
      tx,
    );
  });
}
