import 'server-only';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/lib/commands/define';
import type { Stage } from '@/lib/audience/filter';

/**
 * What Delivery needs to know about a party (spec/v3.md §24.1), read in one
 * query over `party_pipeline` so a skip reason and the stage badge beside it
 * can never disagree.
 */

export type DeliveryFacts = {
  id: number;
  label: string;
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  segmentId: number;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  stage: Stage | null;
  approved: boolean;
  unverified: boolean;
  contactName: string;
  contactEmail: string | null;
  /** The §24.6 finding, when it has not been accepted. */
  suspicious: string | null;
  confirmed: number;
  pending: number;
  waitlisted: number;
  issued: number;
  delivered: number;
  /** The segment's stored default for `TICKETS` (`segment_message_defaults`), if any. */
  segmentTicketTemplate: string | null;
  /** The party's pending ticket email, if one is waiting. */
  pendingTickets: {
    id: number;
    status: 'DRAFT' | 'QUEUED' | 'SENDING';
    templateKey: string | null;
    toEmail: string;
    /** The seat count its wording states. */
    seatCount: number | null;
  } | null;
  /** Ticket-bearing messages still `DRAFT` or `QUEUED` — what Cancel sending would withdraw. */
  withdrawable: number;
};

const idArray = (ids: number[]) => sql`${`{${ids.join(',')}}`}::bigint[]`;

export async function deliveryFacts(
  tx: Tx,
  concertId: number,
  ids: number[],
  lock: boolean,
): Promise<Map<number, DeliveryFacts>> {
  if (ids.length === 0) return new Map();
  if (lock) {
    await tx.execute(sql`
      select id from registrations
       where id = any(${idArray(ids)}) and deleted_at is null
       order by id
       for update
    `);
  }
  const rows = await tx.execute<{
    id: string;
    contact_name: string;
    status: DeliveryFacts['status'];
    segment_id: string;
    audience_mode: DeliveryFacts['audienceMode'];
    stage: Stage | null;
    approved: boolean;
    unverified: boolean;
    contact_email: string | null;
    suspicious: string | null;
    confirmed_seats: number;
    pending_seats: number;
    waitlisted_seats: number;
    issued_seats: number;
    delivered_seats: number;
    segment_ticket_template: string | null;
    pending_id: string | null;
    pending_status: 'DRAFT' | 'QUEUED' | 'SENDING' | null;
    pending_template: string | null;
    pending_to: string | null;
    pending_count: string | null;
    withdrawable: number;
  }>(sql`
    select p.registration_id as id, p.contact_name, r.status, p.segment_id, p.audience_mode,
           p.stage, (p.approved_at is not null) as approved,
           (r.verification_token is not null and r.email_verified_at is null) as unverified,
           r.contact_email::text as contact_email,
           case when r.email_issue is not null and r.email_issue_accepted_at is null
                then r.email_issue end as suspicious,
           p.confirmed_seats, p.pending_seats, p.waitlisted_seats, p.issued_seats, p.delivered_seats,
           d.template_key as segment_ticket_template,
           o.id as pending_id, o.status as pending_status, o.template_key as pending_template,
           o.to_email::text as pending_to, o.context ->> 'attendee_count' as pending_count,
           (select count(*)::int from email_outbox w
             where w.registration_id = r.id and w.status in ('DRAFT', 'QUEUED')
               and (w.purpose = 'TICKETS'
                    or (w.purpose = 'EXTRAS_DECISION' and w.template_key = 'extras_granted'))
           ) as withdrawable
      from party_pipeline p
      join registrations r on r.id = p.registration_id
      left join segment_message_defaults d
        on d.segment_id = p.segment_id and d.purpose = 'TICKETS' and d.deleted_at is null
      left join lateral (
        select id, status, template_key, to_email, context from email_outbox
         where registration_id = r.id and purpose = 'TICKETS'
           and status in ('DRAFT', 'QUEUED', 'SENDING')
         order by id desc limit 1
      ) o on true
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
        audienceMode: row.audience_mode,
        stage: row.stage,
        approved: row.approved,
        unverified: row.unverified,
        contactName: row.contact_name,
        contactEmail: row.contact_email,
        suspicious: row.suspicious,
        confirmed: row.confirmed_seats,
        pending: row.pending_seats,
        waitlisted: row.waitlisted_seats,
        issued: row.issued_seats,
        delivered: row.delivered_seats,
        segmentTicketTemplate: row.segment_ticket_template,
        pendingTickets: row.pending_id
          ? {
              id: Number(row.pending_id),
              status: row.pending_status!,
              templateKey: row.pending_template,
              toEmail: row.pending_to ?? '',
              seatCount: row.pending_count === null ? null : Number(row.pending_count),
            }
          : null,
        withdrawable: row.withdrawable,
      },
    ]),
  );
}
