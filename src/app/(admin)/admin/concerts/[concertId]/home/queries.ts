import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { designForSegment, NoTicketDesignError } from '@/lib/tickets/design';
import { TEMPLATE_KEYS } from '@/lib/email/templates';
import type { ChecklistFacts } from '@/lib/home/checklist';
import type { ShowView } from '../shows/queries';

/**
 * What Home reads beyond the queries other screens already own (spec/v3.md
 * §29.2). The counts come from `viewCounts()`, `inboxCounts()` and
 * `listBatches()`; the shows from the Shows screen's own query, so Home and
 * Shows cannot disagree about a capacity. This file adds only what no screen
 * had a reason to ask for until the checklist did.
 */

export type FormDate = {
  id: number;
  title: string;
  kind: 'PLAYER' | 'PUBLIC' | 'FEEDBACK';
  status: 'DRAFT' | 'OPEN' | 'CLOSED';
  segmentId: number | null;
  showId: number | null;
  opensAt: Date | null;
  closesAt: Date | null;
};

/** Every live form of the concert, both parents (segment and show). */
export async function concertForms(concertId: number): Promise<FormDate[]> {
  const rows = await getDb().execute<{
    id: string;
    title: string;
    kind: FormDate['kind'];
    status: FormDate['status'];
    segment_id: string | null;
    show_id: string | null;
    opens_at: string | null;
    closes_at: string | null;
  }>(sql`
    select f.id, f.title, f.kind::text as kind, f.status::text as status, f.segment_id, f.show_id,
           to_json(f.opens_at) #>> '{}' as opens_at, to_json(f.closes_at) #>> '{}' as closes_at
      from registration_forms f
      left join show_segments g on g.id = f.segment_id
      join shows s on s.id = coalesce(f.show_id, g.show_id)
     where s.concert_id = ${concertId} and f.deleted_at is null and s.deleted_at is null
     order by f.id`);
  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    kind: row.kind,
    status: row.status,
    segmentId: row.segment_id === null ? null : Number(row.segment_id),
    showId: row.show_id === null ? null : Number(row.show_id),
    opensAt: row.opens_at ? new Date(row.opens_at) : null,
    closesAt: row.closes_at ? new Date(row.closes_at) : null,
  }));
}

export type SeatFunnel = {
  live: number;
  confirmed: number;
  issued: number;
  delivered: number;
  admitted: number;
};

/** The seats behind the stage counts, from `party_pipeline`'s own rollups. */
export async function seatFunnel(concertId: number): Promise<SeatFunnel> {
  const [row] = await getDb().execute<SeatFunnel>(sql`
    select coalesce(sum(live_seats), 0)::int as live,
           coalesce(sum(confirmed_seats), 0)::int as confirmed,
           coalesce(sum(issued_seats), 0)::int as issued,
           coalesce(sum(delivered_seats), 0)::int as delivered,
           coalesce(sum(admitted_seats), 0)::int as admitted
      from party_pipeline where concert_id = ${concertId}`);
  return row ?? { live: 0, confirmed: 0, issued: 0, delivered: 0, admitted: 0 };
}

/**
 * The facts the checklist decides on (`src/lib/home/checklist.ts`), for the
 * shows already loaded and the concert's forms.
 */
export async function checklistFacts(
  concertId: number,
  shows: ShowView[],
  forms: FormDate[],
  suspicious: number,
): Promise<ChecklistFacts> {
  const db = getDb();
  const [concertRows, partyRows, operatorRows, templateRows, bookletRows, uncheckedRows, feedbackRows] =
    await Promise.all([
      db.execute<{ timezone: string | null; practical: boolean }>(sql`
        select timezone, coalesce(length(trim(practical_info_md)), 0) > 0 as practical
          from concerts where id = ${concertId}`),
      db.execute<{ segment_id: string; parties: number }>(sql`
        select segment_id, count(*)::int as parties
          from party_pipeline where concert_id = ${concertId} group by segment_id`),
      // Operators who can actually sign in: active, not deleted, still OPERATOR.
      db.execute<{ show_id: string; operators: number }>(sql`
        select a.show_id, count(*)::int as operators
          from operator_show_assignments a
          join app_users u on u.id = a.user_id
          join shows s on s.id = a.show_id
         where s.concert_id = ${concertId} and u.is_active and u.deleted_at is null
           and u.role = 'OPERATOR'
         group by a.show_id`),
      db.execute<{ key: string }>(sql`select key from email_templates where deleted_at is null`),
      db.execute<{ published: boolean }>(sql`
        select exists (select 1 from booklets where concert_id = ${concertId} and published) as published`),
      // Never checked: the address checks run in the app and store their
      // result (§24.6); a party from before V3 has never been through them.
      // A cancelled party is not sent anything, so it is not counted.
      db.execute<{ unchecked: number }>(sql`
        select count(*)::int as unchecked
          from party_pipeline p join registrations r on r.id = p.registration_id
         where p.concert_id = ${concertId} and r.contact_email is not null
           and r.email_checked_at is null and p.stage is distinct from 'CANCELLED'`),
      db.execute<{ id: string; enabled: unknown }>(sql`
        select s.id, resolve_setting('portal.feedback_enabled', null, s.id, s.concert_id) as enabled
          from shows s where s.concert_id = ${concertId} and s.deleted_at is null`),
    ]);

  const parties = new Map(partyRows.map((row) => [Number(row.segment_id), row.parties]));
  const operators = new Map(operatorRows.map((row) => [Number(row.show_id), row.operators]));
  const templates = new Set(templateRows.map((row) => row.key));
  const feedbackEnabled = new Map(feedbackRows.map((row) => [Number(row.id), row.enabled === true]));

  const hasDesign = new Map<number, boolean>();
  await Promise.all(
    shows.flatMap((show) =>
      show.segments.map(async (segment) => {
        try {
          await designForSegment(db, segment.id);
          hasDesign.set(segment.id, true);
        } catch (error) {
          if (!(error instanceof NoTicketDesignError)) throw error;
          hasDesign.set(segment.id, false);
        }
      }),
    ),
  );

  const feedbackRank = { none: 0, DRAFT: 1, CLOSED: 2, OPEN: 3 } as const;

  return {
    concertId,
    hasTimezone: Boolean(concertRows[0]?.timezone),
    hasPracticalInfo: Boolean(concertRows[0]?.practical),
    hasBooklet: Boolean(bookletRows[0]?.published),
    templatesMissing: TEMPLATE_KEYS.filter((key) => !templates.has(key)),
    addresses: { suspicious, unchecked: uncheckedRows[0]?.unchecked ?? 0 },
    shows: shows.map((show) => {
      let feedback: 'none' | 'DRAFT' | 'OPEN' | 'CLOSED' = 'none';
      for (const form of forms) {
        if (form.kind === 'FEEDBACK' && form.showId === show.id && feedbackRank[form.status] > feedbackRank[feedback]) {
          feedback = form.status;
        }
      }
      return {
        id: show.id,
        name: show.name,
        hasHall: show.held !== null,
        over: show.held !== null && show.held < 0 ? -show.held : 0,
        hasStart: show.startsAt !== null,
        hasEnd: show.endsAt !== null,
        operators: operators.get(show.id) ?? 0,
        feedback,
        feedbackEnabled: feedbackEnabled.get(show.id) ?? false,
        segments: show.segments.map((segment) => ({
          id: segment.id,
          name: segment.name,
          audienceMode: segment.audienceMode,
          hasCapacity: segment.pool !== null,
          hasBaseQuota: segment.resolved['allocation.base_quota']?.origin !== 'unset',
          hasDesign: hasDesign.get(segment.id) ?? false,
          formOpened: forms.some(
            (form) => form.segmentId === segment.id && form.kind !== 'FEEDBACK' && form.status !== 'DRAFT',
          ),
          parties: parties.get(segment.id) ?? 0,
        })),
      };
    }),
  };
}
