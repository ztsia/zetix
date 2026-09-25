import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { Tx } from '@/lib/commands/define';
import {
  TRASH_KINDS,
  type TrashFilter,
  type TrashKind,
  type TrashPage,
  type TrashRow,
} from './labels';

export * from './labels';

/**
 * The Trash (spec/v3.md §23.6): every soft-deleted row of one concert, by kind.
 *
 * Deletion stays soft (`deleted_at`), and this is where it lands. Each kind is
 * one query producing `(id, label, detail, deleted_at)`, and the same query
 * serves three callers so they cannot disagree about what "in the Trash" means:
 * the page that lists it, a command's "select all N matching" filter, and each
 * command's `describe`.
 *
 * **What is listed where.** A seat deleted *with its party* is not listed as a
 * seat: restoring or purging the party carries it. Only a seat deleted on its
 * own, from a party that is still live, is a seat in the Trash.
 *
 * **Email templates are not here.** They are global rather than concert-scoped,
 * their key is text while every command target is a bigint
 * (`command_run_items.entity_id`), and nothing deletes one yet. The first
 * module to add a delete for them owns that decision (`modules-v3.md`: `T`).
 */

/**
 * One kind's rows in one concert's Trash, as `(id, label, detail, deleted_at)`.
 * `ids` narrows to those rows — how `describe` reuses it.
 */
function trashRows(kind: TrashKind, concertId: number): SQL {
  switch (kind) {
    case 'party':
      return sql`
        select r.id, r.contact_name as label,
               concat_ws(' · ', r.contact_email::text, g.name,
                 (select count(*) from attendees a where a.registration_id = r.id)
                   || ' seat(s)') as detail,
               r.deleted_at
          from registrations r
          join shows s on s.id = r.show_id
          join show_segments g on g.id = r.segment_id
         where s.concert_id = ${concertId}
           and r.deleted_at is not null`;
    case 'seat':
      return sql`
        select a.id, coalesce(nullif(a.full_name, ''), 'Unnamed guest') as label,
               concat_ws(' · ', 'Party: ' || r.contact_name, a.ticket_code) as detail,
               a.deleted_at
          from attendees a
          join registrations r on r.id = a.registration_id
          join shows s on s.id = a.show_id
         where s.concert_id = ${concertId}
           and a.deleted_at is not null
           and r.deleted_at is null`;
    case 'message':
      return sql`
        select o.id, o.subject as label,
               concat_ws(' · ', o.to_email::text, o.status::text, o.purpose::text) as detail,
               o.deleted_at
          from email_outbox o
          left join registrations r on r.id = o.registration_id
          left join shows s on s.id = r.show_id
          left join players p on p.id = o.player_id
         where coalesce(s.concert_id, p.concert_id) = ${concertId}
           and o.deleted_at is not null`;
    case 'form':
      return sql`
        select f.id, f.title as label,
               concat_ws(' · ', f.kind::text, f.slug, f.round_label) as detail,
               f.deleted_at
          from registration_forms f
          left join show_segments g on g.id = f.segment_id
          join shows s on s.id = coalesce(f.show_id, g.show_id)
         where s.concert_id = ${concertId}
           and f.deleted_at is not null`;
    case 'player':
      return sql`
        select p.id, p.full_name as label,
               concat_ws(' · ', p.email::text, p.instrument, p.section) as detail,
               p.deleted_at
          from players p
         where p.concert_id = ${concertId}
           and p.deleted_at is not null`;
    case 'ticket_template':
      return sql`
        select t.id, t.name || ' v' || t.version as label,
               null::text as detail,
               t.deleted_at
          from ticket_templates t
         where t.concert_id = ${concertId}
           and t.deleted_at is not null`;
  }
}

/** `%` and `_` typed into the search box are text, not wildcards. */
export const likePattern = (search: string) =>
  `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const searchClause = (search: string): SQL =>
  search.trim()
    ? sql`where t.label ilike ${likePattern(search)} or t.detail ilike ${likePattern(search)}`
    : sql``;

type Row = { id: string; label: string; detail: string | null; deleted_at: string };

const toRow = (row: Row): TrashRow => ({
  id: Number(row.id),
  label: row.label,
  detail: row.detail,
  deletedAt: row.deleted_at,
});

/** Every id matching the Trash filter, newest deletion first — a command's `match`. */
export async function matchTrash(
  tx: Tx,
  kind: TrashKind,
  concertId: number,
  filter: TrashFilter,
): Promise<number[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select t.id from (${trashRows(kind, concertId)}) t
    ${searchClause(filter.search)}
    order by t.deleted_at desc, t.id
  `);
  return rows.map((row) => Number(row.id));
}

/** The Trash rows behind `ids` — a command's `describe` starts here. */
export async function trashRowsFor(
  tx: Tx,
  kind: TrashKind,
  concertId: number,
  ids: number[],
): Promise<Map<number, TrashRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.execute<Row>(sql`
    select t.id, t.label, t.detail, to_json(t.deleted_at) #>> '{}' as deleted_at
      from (${trashRows(kind, concertId)}) t
     where t.id = any(${`{${ids.join(',')}}`}::bigint[])
  `);
  return new Map(rows.map((row) => [Number(row.id), toRow(row)]));
}

/** One page of one kind, plus the count of every kind for the tabs. */
export async function listTrash(
  concertId: number,
  kind: TrashKind,
  options: { search: string; pageIndex: number; pageSize: number },
): Promise<TrashPage> {
  const db = getDb();
  const rows = await db.execute<Row & { total: number }>(sql`
    select t.id, t.label, t.detail, to_json(t.deleted_at) #>> '{}' as deleted_at,
           count(*) over ()::int as total
      from (${trashRows(kind, concertId)}) t
    ${searchClause(options.search)}
     order by t.deleted_at desc, t.id
     limit ${options.pageSize} offset ${options.pageIndex * options.pageSize}
  `);

  const countRows = await db.execute<{ kind: TrashKind; n: number }>(
    sql.join(
      TRASH_KINDS.map(
        (k) => sql`select ${k}::text as kind, count(*)::int as n from (${trashRows(k, concertId)}) t`,
      ),
      sql` union all `,
    ),
  );
  const counts = Object.fromEntries(TRASH_KINDS.map((k) => [k, 0])) as Record<TrashKind, number>;
  for (const row of countRows) counts[row.kind] = row.n;

  return { rows: rows.map(toRow), total: rows[0]?.total ?? 0, counts };
}
