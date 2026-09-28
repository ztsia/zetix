import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { RowIssue, StagedFields } from './staging';

/**
 * Reads for the staging grid (spec/v3.md §25.7). Views are the grid's tabs:
 * rows of parties ready to commit, rows that need fixing, and what is done.
 */

export const STAGING_VIEWS = ['all', 'ready', 'needs-fixing', 'committed', 'skipped'] as const;
export type StagingView = (typeof STAGING_VIEWS)[number];

export type BatchSummary = {
  id: number;
  filename: string;
  status: 'DRY_RUN' | 'COMMITTED' | 'STAGED' | 'UNDONE';
  segmentId: number;
  segmentLabel: string;
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
  queueReceipts: boolean;
  createdAt: string;
  counts: Record<StagingView, number> & { readyParties: number; blockedParties: number };
};

export type StagedRow = {
  id: number;
  rowNumber: number;
  seatIndex: number;
  status: 'STAGED' | 'COMMITTED' | 'SKIPPED';
  fields: StagedFields;
  issues: RowIssue[];
  partyKey: string;
  partySize: number;
  /** The first row of its party: where party-level controls sit. */
  isHead: boolean;
  partyBlocked: boolean;
  existing: { id: number; name: string } | null;
  existingAction: 'ADD_SEATS' | 'SKIP' | 'SEPARATE' | null;
  registrationId: number | null;
};

/** Rows of parties with a blocking issue on any staged row. */
const partyBlocked = sql`exists (
  select 1 from import_rows o
   where o.batch_id = r.batch_id and o.party_key is not distinct from r.party_key
     and o.status = 'STAGED' and o.deleted_at is null
     and exists (select 1 from jsonb_array_elements(o.issues) i where i ->> 'level' = 'BLOCKING'))`;

function viewClause(view: StagingView) {
  switch (view) {
    case 'all':
      return sql`true`;
    case 'ready':
      return sql`r.status = 'STAGED' and not ${partyBlocked}`;
    case 'needs-fixing':
      return sql`r.status = 'STAGED' and ${partyBlocked}`;
    case 'committed':
      return sql`r.status = 'COMMITTED'`;
    case 'skipped':
      return sql`r.status = 'SKIPPED'`;
  }
}

export async function batchSummary(concertId: number, batchId: number): Promise<BatchSummary | null> {
  const [row] = await getDb().execute<{
    id: string;
    filename: string;
    status: BatchSummary['status'];
    segment_id: string;
    segment_label: string;
    audience_mode: BatchSummary['audienceMode'];
    queue_receipts: boolean;
    created_at: string;
    all: number;
    ready: number;
    needs_fixing: number;
    committed: number;
    skipped: number;
    ready_parties: number;
    blocked_parties: number;
  }>(sql`
    select b.id, b.filename, b.status::text as status, b.segment_id,
           s.name || ' · ' || g.name as segment_label, g.audience_mode::text as audience_mode,
           b.queue_receipts, to_json(b.created_at) #>> '{}' as created_at,
           count(r.id)::int as all,
           count(r.id) filter (where r.status = 'STAGED' and not ${partyBlocked})::int as ready,
           count(r.id) filter (where r.status = 'STAGED' and ${partyBlocked})::int as needs_fixing,
           count(r.id) filter (where r.status = 'COMMITTED')::int as committed,
           count(r.id) filter (where r.status = 'SKIPPED')::int as skipped,
           count(distinct r.party_key) filter (where r.status = 'STAGED' and not ${partyBlocked})::int as ready_parties,
           count(distinct r.party_key) filter (where r.status = 'STAGED' and ${partyBlocked})::int as blocked_parties
      from import_batches b
      join show_segments g on g.id = b.segment_id
      join shows s on s.id = b.show_id
      left join import_rows r on r.batch_id = b.id and r.deleted_at is null
     where b.id = ${batchId} and s.concert_id = ${concertId}
     group by b.id, s.name, g.name, g.audience_mode
  `);
  if (!row) return null;
  return {
    id: Number(row.id),
    filename: row.filename,
    status: row.status,
    segmentId: Number(row.segment_id),
    segmentLabel: row.segment_label,
    audienceMode: row.audience_mode,
    queueReceipts: row.queue_receipts,
    createdAt: row.created_at,
    counts: {
      all: row.all,
      ready: row.ready,
      'needs-fixing': row.needs_fixing,
      committed: row.committed,
      skipped: row.skipped,
      readyParties: row.ready_parties,
      blockedParties: row.blocked_parties,
    },
  };
}

export async function listStagedRows(
  batchId: number,
  options: {
    view: StagingView;
    search: string;
    pageIndex: number;
    pageSize: number;
    /**
     * A viewer sees addresses masked, so a search they run must not match on
     * them — a hit-or-miss answer would spell the address out (spec/v3.md §28).
     */
    namesOnly?: boolean;
  },
): Promise<{ rows: StagedRow[]; total: number }> {
  const search = options.search.trim();
  const where = sql`
    r.batch_id = ${batchId} and r.deleted_at is null and ${viewClause(options.view)}
    ${
      search
        ? sql`and (r.normalized ->> 'contactName' ilike ${'%' + search + '%'}
                or r.normalized ->> 'attendeeName' ilike ${'%' + search + '%'}
                ${options.namesOnly ? sql`` : sql`or r.normalized ->> 'contactEmail' ilike ${'%' + search + '%'}`})`
        : sql``
    }`;
  const db = getDb();
  const [{ total }] = await db.execute<{ total: number }>(sql`
    select count(*)::int as total from import_rows r where ${where}
  `);
  const rows = await db.execute<{
    id: string;
    row_number: number;
    seat_index: number;
    status: StagedRow['status'];
    normalized: StagedFields;
    issues: RowIssue[];
    party_key: string | null;
    party_size: number;
    is_head: boolean;
    party_blocked: boolean;
    existing_id: string | null;
    existing_name: string | null;
    existing_action: StagedRow['existingAction'];
    registration_id: string | null;
  }>(sql`
    select r.id, r.row_number, r.seat_index, r.status::text as status, r.normalized, r.issues, r.party_key,
           (select count(*)::int from import_rows o
             where o.batch_id = r.batch_id and o.party_key is not distinct from r.party_key and o.deleted_at is null) as party_size,
           r.id = (select min(o.id) from import_rows o
                    where o.batch_id = r.batch_id and o.party_key is not distinct from r.party_key and o.deleted_at is null) as is_head,
           ${partyBlocked} as party_blocked,
           r.existing_registration_id as existing_id, x.contact_name as existing_name,
           r.existing_action::text as existing_action, r.registration_id
      from import_rows r
      left join registrations x on x.id = r.existing_registration_id
     where ${where}
     order by (select min(o.row_number) from import_rows o
                where o.batch_id = r.batch_id and o.party_key is not distinct from r.party_key),
              r.party_key, r.row_number, r.seat_index
     limit ${options.pageSize} offset ${options.pageIndex * options.pageSize}
  `);
  return {
    total,
    rows: rows.map((row) => ({
      id: Number(row.id),
      rowNumber: row.row_number,
      seatIndex: row.seat_index,
      status: row.status,
      fields: row.normalized,
      issues: row.issues ?? [],
      partyKey: row.party_key ?? '',
      partySize: row.party_size,
      isHead: row.is_head,
      partyBlocked: row.party_blocked,
      existing: row.existing_id ? { id: Number(row.existing_id), name: row.existing_name ?? '' } : null,
      existingAction: row.existing_action,
      registrationId: row.registration_id === null ? null : Number(row.registration_id),
    })),
  };
}

export type BatchListRow = {
  id: number;
  filename: string;
  status: BatchSummary['status'];
  segmentLabel: string;
  createdAt: string;
  staged: number;
  committed: number;
};

/** The concert's staged and committed batches, newest first, for the import page. */
export async function listBatches(concertId: number): Promise<BatchListRow[]> {
  const rows = await getDb().execute<{
    id: string;
    filename: string;
    status: BatchSummary['status'];
    segment_label: string;
    created_at: string;
    staged: number;
    committed: number;
  }>(sql`
    select b.id, b.filename, b.status::text as status, s.name || ' · ' || g.name as segment_label,
           to_json(b.created_at) #>> '{}' as created_at,
           (select count(*)::int from import_rows r where r.batch_id = b.id and r.status = 'STAGED' and r.deleted_at is null) as staged,
           (select count(*)::int from import_rows r where r.batch_id = b.id and r.status = 'COMMITTED') as committed
      from import_batches b
      join show_segments g on g.id = b.segment_id
      join shows s on s.id = b.show_id
     where s.concert_id = ${concertId} and b.status in ('STAGED', 'COMMITTED', 'UNDONE')
       and exists (select 1 from import_rows r where r.batch_id = b.id)
     order by b.created_at desc
     limit 50
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    filename: row.filename,
    status: row.status,
    segmentLabel: row.segment_label,
    createdAt: row.created_at,
    staged: row.staged,
    committed: row.committed,
  }));
}
