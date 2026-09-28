import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * Each form's funnel (spec/v3.md §25.6): *responses → parties → approved →
 * sent*, read from `party_pipeline` and never recomputed.
 *
 * - **responses** — submissions, counting an edit chain once.
 * - **parties** — live parties holding a response from this form, a merged
 *   submission included (`form_responses.registration_id`, `0204`).
 * - **approved** — of those, past the review gate (§25.4).
 * - **sent** — of those, every confirmed seat delivered.
 *
 * A feedback form has no seats; its funnel is its responses alone.
 */
export type FormFunnel = {
  id: number;
  title: string;
  slug: string;
  kind: 'PLAYER' | 'PUBLIC' | 'FEEDBACK';
  status: 'DRAFT' | 'OPEN' | 'CLOSED';
  segmentId: number | null;
  showId: number;
  responses: number;
  parties: number;
  approved: number;
  sent: number;
};

export async function formFunnels(concertId: number): Promise<FormFunnel[]> {
  const rows = await getDb().execute<{
    id: string;
    title: string;
    slug: string;
    kind: FormFunnel['kind'];
    status: FormFunnel['status'];
    segment_id: string | null;
    show_id: string;
    responses: number;
    parties: number;
    approved: number;
    sent: number;
  }>(sql`
    select f.id, f.title, f.slug, f.kind::text as kind, f.status::text as status, f.segment_id,
           s.id as show_id,
           (select count(*)::int from form_responses fr
             where fr.form_id = f.id
               and not exists (select 1 from form_responses later where later.supersedes_id = fr.id)) as responses,
           count(distinct p.registration_id)::int as parties,
           count(distinct p.registration_id) filter (where p.approved_at is not null)::int as approved,
           count(distinct p.registration_id)
             filter (where p.confirmed_seats > 0 and p.delivered_seats >= p.confirmed_seats)::int as sent
      from registration_forms f
      left join show_segments g on g.id = f.segment_id
      join shows s on s.id = coalesce(f.show_id, g.show_id)
      left join form_responses fr on fr.form_id = f.id
      left join party_pipeline p on p.registration_id = fr.registration_id
     where s.concert_id = ${concertId} and f.deleted_at is null
     group by f.id, s.id
     order by f.id
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    segmentId: row.segment_id === null ? null : Number(row.segment_id),
    showId: Number(row.show_id),
    responses: row.responses,
    parties: row.parties,
    approved: row.approved,
    sent: row.sent,
  }));
}
