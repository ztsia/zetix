import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { ActivityRow } from '@/lib/activity/labels';
import type { Flag, Stage } from './filter';
import type { SeatCounters } from './queries';

/**
 * The party record (spec/v3.md §22.4): every step for one party, on one page.
 *
 * Five sections, each read here in one query: the header (from
 * `party_pipeline`, so the stage and flags are the ones the table shows), the
 * seats, the conversation, the responses and the activity. The record is where
 * the work is done, so it carries everything a person needs to decide without
 * opening another screen.
 */

export type RecordParty = {
  id: number;
  concertId: number;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  showId: number;
  showName: string;
  segmentId: number;
  segmentName: string;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  playerId: number | null;
  playerName: string | null;
  source: 'FORM' | 'IMPORT' | 'ADMIN';
  roundLabel: string | null;
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  requestedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  emailVerifiedAt: string | null;
  needsVerification: boolean;
  emailIssue: string | null;
  emailCheckedAt: string | null;
  emailIssueAcceptedAt: string | null;
  createdAt: string;
  stage: Stage | null;
  flags: Flag[];
  seats: SeatCounters;
  /** Where the party came from, in words: "Form “Round 2”", "Import sheet.xlsx", "Entered by an admin". */
  provenance: string;
  formResponseId: number | null;
  importBatchId: number | null;
};

export type RecordSeat = {
  id: number;
  fullName: string;
  placeholder: boolean;
  email: string | null;
  allocationType: 'BASE' | 'EXTRA' | 'HELD' | 'COMP';
  status: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
  ticketCode: string | null;
  issued: boolean;
  templateName: string | null;
  templateVersion: number | null;
  sentAt: string | null;
  sentSource: 'EMAIL' | 'MANUAL' | null;
  needsReissue: boolean;
  overCapacity: boolean;
  requestedAt: string;
  checkIn: { id: number; at: string; source: string } | null;
};

export type RecordMessage = {
  /** `outbox:12` or `inbox:40`, so one list can hold both. */
  key: string;
  direction: 'OUTBOUND' | 'INBOUND';
  outboxId: number | null;
  purpose: string | null;
  templateKey: string | null;
  status: string | null;
  toEmail: string | null;
  fromEmail: string | null;
  subject: string | null;
  text: string | null;
  at: string;
  sentAt: string | null;
  attempts: number | null;
  lastError: string | null;
  bounce: string | null;
  isBounce: boolean;
  handledAt: string | null;
};

export type RecordResponse = {
  id: number;
  formTitle: string;
  submittedAt: string;
  raw: unknown;
  /** True for every entry but the one the party points at: edits replaced them. */
  superseded: boolean;
};

/**
 * A stored duplicate pair naming this party (spec/v3.md §25.5): open ones to
 * decide, and merges into this party that can still be undone.
 */
export type RecordDuplicate = {
  candidateId: number;
  status: 'OPEN' | 'MERGED';
  reasons: string[];
  similarity: number | null;
  /** This party is the pair's `a` side — which side *Merge* keeps is named by it. */
  thisIsA: boolean;
  decidedAt: string | null;
  other: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    segmentName: string;
    playerName: string | null;
    liveSeats: number;
    requestedAt: string;
    deleted: boolean;
  };
};

export type RecordImport = {
  batchId: number;
  filename: string;
  importedAt: string;
  /** The rows as they were in the file, when the V3 staging grid kept them (§25.7). */
  rows: { rowNumber: number; seatIndex: number; raw: unknown }[];
};

export type PartyRecord = {
  party: RecordParty;
  seats: RecordSeat[];
  messages: RecordMessage[];
  responses: RecordResponse[];
  duplicates: RecordDuplicate[];
  import: RecordImport | null;
  custom: Record<string, unknown> | null;
  activity: ActivityRow[];
};

/** How much history the record draws. A render limit, not an operational value. */
const ACTIVITY_SHOWN = 200;

export async function loadPartyRecord(
  concertId: number,
  registrationId: number,
): Promise<PartyRecord | null> {
  const db = getDb();

  const [row] = await db.execute<{
    registration_id: string;
    concert_id: string;
    contact_name: string;
    contact_email: string | null;
    contact_phone: string | null;
    show_id: string;
    show_name: string;
    segment_id: string;
    segment_name: string;
    audience_mode: RecordParty['audienceMode'];
    player_id: string | null;
    player_name: string | null;
    source: RecordParty['source'];
    round_label: string | null;
    status: RecordParty['status'];
    requested_at: string;
    approved_at: string | null;
    approved_by: string | null;
    email_verified_at: string | null;
    needs_verification: boolean;
    email_issue: string | null;
    email_checked_at: string | null;
    email_issue_accepted_at: string | null;
    created_at: string;
    stage: Stage | null;
    flags: Flag[] | null;
    live_seats: number;
    confirmed_seats: number;
    pending_seats: number;
    waitlisted_seats: number;
    cancelled_seats: number;
    issued_seats: number;
    delivered_seats: number;
    admitted_seats: number;
    form_response_id: string | null;
    form_title: string | null;
    import_batch_id: string | null;
    import_filename: string | null;
    import_at: string | null;
    custom: Record<string, unknown> | null;
  }>(sql`
    select p.registration_id, p.concert_id, p.contact_name, p.contact_email::text as contact_email,
           p.contact_phone, p.show_id, s.name as show_name, p.segment_id, g.name as segment_name,
           p.audience_mode, p.player_id, pl.full_name as player_name, p.source, p.round_label,
           r.status,
           to_json(p.requested_at) #>> '{}' as requested_at,
           to_json(p.approved_at) #>> '{}' as approved_at,
           coalesce(u.display_name, u.email::text) as approved_by,
           to_json(r.email_verified_at) #>> '{}' as email_verified_at,
           (r.verification_token is not null) as needs_verification,
           r.email_issue,
           to_json(r.email_checked_at) #>> '{}' as email_checked_at,
           to_json(r.email_issue_accepted_at) #>> '{}' as email_issue_accepted_at,
           to_json(r.created_at) #>> '{}' as created_at,
           p.stage, p.flags,
           p.live_seats, p.confirmed_seats, p.pending_seats, p.waitlisted_seats,
           p.cancelled_seats, p.issued_seats, p.delivered_seats, p.admitted_seats,
           r.form_response_id, f.title as form_title,
           r.import_batch_id, b.filename as import_filename,
           to_json(b.created_at) #>> '{}' as import_at,
           r.custom
      from party_pipeline p
      join registrations r on r.id = p.registration_id
      join shows s on s.id = p.show_id
      join show_segments g on g.id = p.segment_id
      left join players pl on pl.id = p.player_id
      left join app_users u on u.id = r.approved_by
      left join form_responses fr on fr.id = r.form_response_id
      left join registration_forms f on f.id = fr.form_id
      left join import_batches b on b.id = r.import_batch_id
     where p.registration_id = ${registrationId}
       and p.concert_id = ${concertId}
  `);
  if (!row) return null;

  const provenance =
    row.source === 'FORM'
      ? `Form${row.form_title ? ` “${row.form_title}”` : ''}${row.round_label ? `, ${row.round_label}` : ''}`
      : row.source === 'IMPORT'
        ? `Import ${row.import_filename ?? '(batch deleted)'}${row.round_label ? `, ${row.round_label}` : ''}`
        : `Entered by an admin${row.round_label ? `, ${row.round_label}` : ''}`;

  const party: RecordParty = {
    id: Number(row.registration_id),
    concertId: Number(row.concert_id),
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    showId: Number(row.show_id),
    showName: row.show_name,
    segmentId: Number(row.segment_id),
    segmentName: row.segment_name,
    audienceMode: row.audience_mode,
    playerId: row.player_id === null ? null : Number(row.player_id),
    playerName: row.player_name,
    source: row.source,
    roundLabel: row.round_label,
    status: row.status,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    emailVerifiedAt: row.email_verified_at,
    needsVerification: row.needs_verification,
    emailIssue: row.email_issue,
    emailCheckedAt: row.email_checked_at,
    emailIssueAcceptedAt: row.email_issue_accepted_at,
    createdAt: row.created_at,
    stage: row.stage,
    flags: row.flags ?? [],
    seats: {
      live: row.live_seats,
      confirmed: row.confirmed_seats,
      pending: row.pending_seats,
      waitlisted: row.waitlisted_seats,
      cancelled: row.cancelled_seats,
      issued: row.issued_seats,
      delivered: row.delivered_seats,
      admitted: row.admitted_seats,
    },
    provenance,
    formResponseId: row.form_response_id === null ? null : Number(row.form_response_id),
    importBatchId: row.import_batch_id === null ? null : Number(row.import_batch_id),
  };

  const [seats, messages, responses, importRows, activity, duplicates] = await Promise.all([
    loadSeats(registrationId),
    loadMessages(registrationId),
    loadResponses(registrationId, party.formResponseId),
    party.importBatchId ? loadImportRows(registrationId) : Promise.resolve([]),
    loadActivity(concertId, registrationId),
    loadDuplicates(registrationId),
  ]);

  return {
    party,
    seats,
    messages,
    responses,
    duplicates,
    import:
      party.importBatchId && row.import_at
        ? {
            batchId: party.importBatchId,
            filename: row.import_filename ?? '',
            importedAt: row.import_at,
            rows: importRows,
          }
        : null,
    custom: row.custom,
    activity,
  };
}

async function loadSeats(registrationId: number): Promise<RecordSeat[]> {
  const rows = await getDb().execute<{
    id: string;
    full_name: string;
    name_source: string;
    email: string | null;
    allocation_type: RecordSeat['allocationType'];
    status: RecordSeat['status'];
    ticket_code: string | null;
    issued: boolean;
    template_name: string | null;
    ticket_template_version: number | null;
    sent_at: string | null;
    ticket_sent_source: RecordSeat['sentSource'];
    needs_reissue: boolean;
    over_capacity: boolean;
    requested_at: string;
    check_in_id: string | null;
    check_in_at: string | null;
    check_in_source: string | null;
  }>(sql`
    select a.id, a.full_name, a.name_source, a.email::text as email, a.allocation_type, a.status,
           a.ticket_code,
           (a.qr_token is not null and a.ticket_template_id is not null) as issued,
           t.name as template_name, a.ticket_template_version,
           to_json(a.ticket_sent_at) #>> '{}' as sent_at, a.ticket_sent_source,
           a.needs_reissue, (a.over_capacity_at is not null) as over_capacity,
           to_json(a.requested_at) #>> '{}' as requested_at,
           c.id as check_in_id, to_json(c.scanned_at) #>> '{}' as check_in_at,
           c.source as check_in_source
      from attendees a
      left join ticket_templates t on t.id = a.ticket_template_id
      left join lateral (
        select id, scanned_at, source from check_ins
         where attendee_id = a.id and reverted_at is null
         order by scanned_at desc limit 1) c on true
     where a.registration_id = ${registrationId}
       and a.deleted_at is null
     order by case when a.status = 'CANCELLED' then 1 else 0 end, a.requested_at, a.id
  `);
  return rows.map((r) => ({
    id: Number(r.id),
    fullName: r.full_name,
    placeholder: r.name_source === 'PLACEHOLDER',
    email: r.email,
    allocationType: r.allocation_type,
    status: r.status,
    ticketCode: r.ticket_code,
    issued: r.issued,
    templateName: r.template_name,
    templateVersion: r.ticket_template_version,
    sentAt: r.sent_at,
    sentSource: r.ticket_sent_source,
    needsReissue: r.needs_reissue,
    overCapacity: r.over_capacity,
    requestedAt: r.requested_at,
    checkIn: r.check_in_id
      ? { id: Number(r.check_in_id), at: r.check_in_at!, source: r.check_in_source! }
      : null,
  }));
}

/**
 * The conversation (§22.4): what we sent and what came back, in order.
 *
 * Outbound rows are the outbox; inbound replies and bounces are
 * `email_messages` that module `U` stores. An outbox row that `U` also mirrored
 * as a sent message is shown once, as the outbox row.
 */
async function loadMessages(registrationId: number): Promise<RecordMessage[]> {
  const db = getDb();
  const [outbox, inbound] = await Promise.all([
    db.execute<{
      id: string;
      purpose: string;
      template_key: string | null;
      status: string;
      to_email: string;
      subject: string;
      at: string;
      sent_at: string | null;
      attempts: number;
      last_error: string | null;
      bounce: string | null;
    }>(sql`
      select o.id, o.purpose, o.template_key, o.status, o.to_email::text as to_email, o.subject,
             to_json(o.created_at) #>> '{}' as at,
             to_json(o.sent_at) #>> '{}' as sent_at,
             o.attempts, o.last_error,
             case when o.bounced_at is not null
                  then concat_ws(' ', o.bounce_code, o.bounce_detail) end as bounce
        from email_outbox o
       where o.registration_id = ${registrationId}
         and o.deleted_at is null
    `),
    db.execute<{
      id: string;
      from_email: string | null;
      to_email: string | null;
      subject: string | null;
      text: string | null;
      at: string;
      is_bounce: boolean;
      handled_at: string | null;
    }>(sql`
      select m.id, m.from_email::text as from_email, m.to_email::text as to_email, m.subject, m.text,
             to_json(m.message_at) #>> '{}' as at, m.is_bounce,
             to_json(m.handled_at) #>> '{}' as handled_at
        from email_threads t
        join email_messages m on m.thread_id = t.id and m.deleted_at is null
       where t.registration_id = ${registrationId}
         and t.deleted_at is null
         and (m.direction = 'INBOUND' or m.outbox_id is null)
    `),
  ]);

  const messages: RecordMessage[] = [
    ...outbox.map((o) => ({
      key: `outbox:${o.id}`,
      direction: 'OUTBOUND' as const,
      outboxId: Number(o.id),
      purpose: o.purpose,
      templateKey: o.template_key,
      status: o.status,
      toEmail: o.to_email,
      fromEmail: null,
      subject: o.subject,
      text: null,
      at: o.sent_at ?? o.at,
      sentAt: o.sent_at,
      attempts: o.attempts,
      lastError: o.last_error,
      bounce: o.bounce,
      isBounce: false,
      handledAt: null,
    })),
    ...inbound.map((m) => ({
      key: `inbox:${m.id}`,
      direction: 'INBOUND' as const,
      outboxId: null,
      purpose: null,
      templateKey: null,
      status: null,
      toEmail: m.to_email,
      fromEmail: m.from_email,
      subject: m.subject,
      text: m.text,
      at: m.at,
      sentAt: null,
      attempts: null,
      lastError: null,
      bounce: null,
      isBounce: m.is_bounce,
      handledAt: m.handled_at,
    })),
  ];
  return messages.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Every response of the party: the one it points at and the edits it replaced
 * (`v2.md` §8.3.1), and any later submission merged into it by email
 * (spec/v3.md §25.5), which carries `registration_id` but is not in the chain.
 * Newest first.
 */
async function loadResponses(registrationId: number, responseId: number | null): Promise<RecordResponse[]> {
  const rows = await getDb().execute<{
    id: string;
    form_title: string;
    submitted_at: string;
    raw: unknown;
    superseded: boolean;
  }>(sql`
    with recursive chain(id, depth) as (
      select ${responseId}::bigint, 0 where ${responseId}::bigint is not null
      union all
      select fr.supersedes_id, c.depth + 1
        from form_responses fr join chain c on c.id = fr.id
       where fr.supersedes_id is not null and c.depth < 100
    ),
    mine as (
      select id from chain
      union
      select id from form_responses where registration_id = ${registrationId}
    )
    select fr.id, f.title as form_title, to_json(fr.submitted_at) #>> '{}' as submitted_at,
           fr.raw,
           exists (select 1 from form_responses later where later.supersedes_id = fr.id) as superseded
      from mine m
      join form_responses fr on fr.id = m.id
      join registration_forms f on f.id = fr.form_id
     order by fr.submitted_at desc, fr.id desc
  `);
  return rows.map((r) => ({
    id: Number(r.id),
    formTitle: r.form_title,
    submittedAt: r.submitted_at,
    raw: r.raw,
    superseded: r.superseded,
  }));
}

async function loadDuplicates(registrationId: number): Promise<RecordDuplicate[]> {
  const rows = await getDb().execute<{
    id: string;
    status: 'OPEN' | 'MERGED';
    reasons: string[];
    name_similarity: number | null;
    this_is_a: boolean;
    decided_at: string | null;
    other_id: string;
    name: string;
    email: string | null;
    phone: string | null;
    segment_name: string;
    player_name: string | null;
    live_seats: number;
    requested_at: string;
    deleted: boolean;
  }>(sql`
    select d.id, d.status::text as status, d.reasons, d.name_similarity,
           d.registration_a_id = ${registrationId} as this_is_a,
           to_json(d.decided_at) #>> '{}' as decided_at,
           o.id as other_id, o.contact_name as name, o.contact_email::text as email,
           o.contact_phone as phone, g.name as segment_name, pl.full_name as player_name,
           (select count(*)::int from attendees a
             where a.registration_id = o.id and a.deleted_at is null and a.status <> 'CANCELLED') as live_seats,
           to_json(o.requested_at) #>> '{}' as requested_at,
           o.deleted_at is not null as deleted
      from duplicate_candidates d
      join registrations o
        on o.id = case when d.registration_a_id = ${registrationId}
                       then d.registration_b_id else d.registration_a_id end
      join show_segments g on g.id = o.segment_id
      left join players pl on pl.id = o.player_id
     where ${registrationId} in (d.registration_a_id, d.registration_b_id)
       and d.deleted_at is null
       and (
         (d.status = 'OPEN' and o.deleted_at is null)
         -- A merge into this party, while the absorbed party is still merged.
         or (d.status = 'MERGED' and o.merged_into_id = ${registrationId})
       )
     order by d.status, d.id
  `);
  return rows.map((r) => ({
    candidateId: Number(r.id),
    status: r.status,
    reasons: r.reasons,
    similarity: r.name_similarity === null ? null : Number(r.name_similarity),
    thisIsA: r.this_is_a,
    decidedAt: r.decided_at,
    other: {
      id: Number(r.other_id),
      name: r.name,
      email: r.email,
      phone: r.phone,
      segmentName: r.segment_name,
      playerName: r.player_name,
      liveSeats: r.live_seats,
      requestedAt: r.requested_at,
      deleted: r.deleted,
    },
  }));
}

async function loadImportRows(registrationId: number): Promise<RecordImport['rows']> {
  const rows = await getDb().execute<{ row_number: number; seat_index: number; raw: unknown }>(sql`
    select row_number, seat_index, raw from import_rows
     where registration_id = ${registrationId} and deleted_at is null
     order by row_number, seat_index
  `);
  return rows.map((r) => ({ rowNumber: r.row_number, seatIndex: r.seat_index, raw: r.raw }));
}

/**
 * This party's `audit_log`, newest first (§22.4) — its own rows and its
 * seats', so a rename or a check-in shows beside the approval that preceded it.
 */
async function loadActivity(concertId: number, registrationId: number): Promise<ActivityRow[]> {
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
  }>(sql`
    select l.id, to_json(l.created_at) #>> '{}' as at,
           coalesce(u.display_name, u.email::text) as actor,
           l.action, l.entity_type, l.entity_id, l.reason, l.command_run_id, l.before, l.after
      from audit_log l
      left join app_users u on u.id = l.actor_id
     where l.concert_id = ${concertId}
       and ((l.entity_type = 'registration' and l.entity_id = ${String(registrationId)})
            or (l.entity_type = 'attendee' and l.entity_id in (
                  select a.id::text from attendees a where a.registration_id = ${registrationId})))
     order by l.created_at desc, l.id desc
     limit ${ACTIVITY_SHOWN}
  `);
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    reason: r.reason,
    commandRunId: r.command_run_id === null ? null : Number(r.command_run_id),
    before: r.before,
    after: r.after,
  }));
}
