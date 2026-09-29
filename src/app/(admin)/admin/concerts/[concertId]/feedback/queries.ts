import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * After › Feedback (spec/v3.md §29.1, spec/v2.md §13.5): per show, its
 * feedback form, the switches that put it in the portal, who it goes to and
 * where its emails are.
 */

export type FeedbackForm = { id: number; title: string; status: 'DRAFT' | 'OPEN' | 'CLOSED'; responses: number };

export type FeedbackShow = {
  id: number;
  name: string;
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'COMPLETED';
  endsAt: Date | null;
  /** Attendees with a live check-in: who the feedback email is addressed to (§13.5.1). */
  admitted: number;
  /** `portal.feedback_enabled` and `portal.feedback_close_at`, resolved for the show. */
  enabled: boolean | null;
  closeAt: string | null;
  forms: FeedbackForm[];
  /** The show's feedback messages by where they are. */
  emails: { waiting: number; sent: number; failed: number };
};

export async function feedbackByShow(concertId: number): Promise<FeedbackShow[]> {
  const db = getDb();
  const [shows, forms, emails] = await Promise.all([
    db.execute<{
      id: string;
      name: string;
      status: FeedbackShow['status'];
      ends_at: string | null;
      admitted: number;
      enabled: unknown;
      close_at: unknown;
    }>(sql`
      select s.id, s.name, s.status::text as status, to_json(s.ends_at) #>> '{}' as ends_at,
             (select count(distinct c.attendee_id)::int
                from check_ins c join attendees a on a.id = c.attendee_id
               where a.show_id = s.id and a.deleted_at is null and c.reverted_at is null) as admitted,
             resolve_setting('portal.feedback_enabled', null, s.id, s.concert_id) as enabled,
             resolve_setting('portal.feedback_close_at', null, s.id, s.concert_id) as close_at
        from shows s
       where s.concert_id = ${concertId} and s.deleted_at is null
       order by s.starts_at asc nulls last, s.name`),
    db.execute<{ id: string; show_id: string; title: string; status: FeedbackForm['status']; responses: number }>(sql`
      select f.id, f.show_id, f.title, f.status::text as status,
             (select count(*)::int from feedback_responses r where r.form_id = f.id) as responses
        from registration_forms f join shows s on s.id = f.show_id
       where s.concert_id = ${concertId} and f.kind = 'FEEDBACK' and f.deleted_at is null
       order by f.id`),
    db.execute<{ show_id: string; waiting: number; sent: number; failed: number }>(sql`
      select r.show_id,
             count(*) filter (where o.status in ('DRAFT', 'QUEUED', 'SENDING'))::int as waiting,
             count(*) filter (where o.status = 'SENT')::int as sent,
             count(*) filter (where o.status in ('FAILED', 'BOUNCED'))::int as failed
        from email_outbox o
        join registrations r on r.id = o.registration_id
        join shows s on s.id = r.show_id
       where s.concert_id = ${concertId} and o.purpose = 'FEEDBACK' and o.deleted_at is null
       group by r.show_id`),
  ]);

  return shows.map((show) => {
    const mail = emails.find((row) => row.show_id === show.id);
    return {
      id: Number(show.id),
      name: show.name,
      status: show.status,
      endsAt: show.ends_at ? new Date(show.ends_at) : null,
      admitted: show.admitted,
      enabled: typeof show.enabled === 'boolean' ? show.enabled : null,
      closeAt: typeof show.close_at === 'string' ? show.close_at : null,
      forms: forms
        .filter((form) => form.show_id === show.id)
        .map((form) => ({ id: Number(form.id), title: form.title, status: form.status, responses: form.responses })),
      emails: { waiting: mail?.waiting ?? 0, sent: mail?.sent ?? 0, failed: mail?.failed ?? 0 },
    };
  });
}
