import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { likePattern } from '@/lib/trash/queries';
import { ACTIVITY_VIEWS, type ActivityRow, type Paged, type RunRow } from './labels';

export * from './labels';

/**
 * The Activity log reader (spec/v3.md §23.1: "the run is kept and readable from
 * the Activity log"; §22.4 reads the same rows per party).
 *
 * Reads `audit_log` by its concert scope (`0201`), so a row whose entity was
 * later deleted permanently is still listed — that is the point of storing the
 * scope rather than joining for it. The actor is named from `app_users`; the
 * shared V1/V2 admin account reads as whatever it is called, and `R`'s named
 * accounts will read as people (spec/v3.md §28).
 */

export async function listActivity(
  concertId: number,
  options: {
    view: string | null;
    search: string;
    runId: number | null;
    pageIndex: number;
    pageSize: number;
  },
): Promise<Paged<ActivityRow>> {
  const view = ACTIVITY_VIEWS.find((v) => v.id === options.view);
  const search = options.search.trim();

  const rows = await getDb().execute<{
    id: string;
    at: string;
    actor: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    reason: string | null;
    command_run_id: string | null;
    before: unknown;
    after: unknown;
    total: number;
  }>(sql`
    select l.id, to_json(l.created_at) #>> '{}' as at,
           coalesce(u.display_name, u.email::text) as actor,
           l.action, l.entity_type, l.entity_id, l.reason, l.command_run_id,
           l.before, l.after,
           count(*) over ()::int as total
      from audit_log l
      left join app_users u on u.id = l.actor_id
     where l.concert_id = ${concertId}
       ${view ? sql`and l.entity_type = any(${`{${view.types.join(',')}}`}::text[])` : sql``}
       ${options.runId ? sql`and l.command_run_id = ${options.runId}` : sql``}
       ${
         search
           ? sql`and (l.action ilike ${likePattern(search)}
                      or l.reason ilike ${likePattern(search)}
                      or l.entity_id = ${search})`
           : sql``
       }
     order by l.created_at desc, l.id desc
     limit ${options.pageSize} offset ${options.pageIndex * options.pageSize}
  `);

  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((row) => ({
      id: Number(row.id),
      at: row.at,
      actor: row.actor,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      reason: row.reason,
      commandRunId: row.command_run_id == null ? null : Number(row.command_run_id),
      before: row.before,
      after: row.after,
    })),
  };
}

export async function listRuns(
  concertId: number,
  options: { pageIndex: number; pageSize: number },
): Promise<Paged<RunRow>> {
  const rows = await getDb().execute<{
    id: string;
    command: string;
    status: RunRow['status'];
    actor: string | null;
    total: number;
    done: number;
    skipped: number;
    failed: number;
    reason: string | null;
    started_at: string;
    finished_at: string | null;
    total_rows: number;
  }>(sql`
    select r.id, r.command, r.status, coalesce(u.display_name, u.email::text) as actor,
           r.total, r.done, r.skipped, r.failed, r.reason,
           to_json(r.started_at) #>> '{}' as started_at,
           to_json(r.finished_at) #>> '{}' as finished_at,
           count(*) over ()::int as total_rows
      from command_runs r
      left join app_users u on u.id = r.actor_id
     where r.concert_id = ${concertId}
     order by r.started_at desc, r.id desc
     limit ${options.pageSize} offset ${options.pageIndex * options.pageSize}
  `);
  return {
    total: rows[0]?.total_rows ?? 0,
    rows: rows.map((row) => ({
      id: Number(row.id),
      command: row.command,
      status: row.status,
      actor: row.actor,
      total: row.total,
      done: row.done,
      skipped: row.skipped,
      failed: row.failed,
      reason: row.reason,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
  };
}
