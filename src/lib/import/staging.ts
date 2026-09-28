import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { resolveSetting } from '@/db/settings';
import type { Tx } from '@/lib/commands/define';
import { addressShapeIssue } from '@/lib/email/address';
import { matchPlayers, type SegmentTarget } from './context';
import { parseRequestedAt, resolveAllocationType, type PlayerMatch, type SheetRow } from './plan';
import { serialiseMappingProfile, type AllocationChoice, type MappingProfile } from './profile';

/**
 * The import staging grid (spec/v3.md §25.7, decision 49).
 *
 * Upload → choose the segment → map columns → **the rows land in
 * `import_rows`**, one per seat, where they can be edited before anything is
 * written to a party:
 *
 * - **Issues are on the cell** — each row carries `{ field, code, level,
 *   message }`, and editing a cell re-validates the batch at once.
 * - **Ready rows commit; blocked rows stay.** A party is ready when none of its
 *   rows has a blocking issue. One bad row never holds up another party.
 * - **The timestamp is optional.** Without one, file order is the first-come
 *   order, stamped from the moment the batch was staged.
 * - **Grouping is by contact email within the batch** (a mapped group column
 *   overrides), and a party whose email already holds a party in the segment
 *   is matched to it: *add seats to it* (the default), *skip*, or *keep
 *   separate*. A seat whose name the existing party already has is recognised
 *   as already imported — which is what makes re-uploading the cumulative
 *   sheet each round safe without timestamps.
 * - **Wide sheets** map their repeating guest columns as seat groups; every
 *   derived row is visible, and editable, before it is written.
 *
 * Nothing here claims a seat: that is *Commit staged rows*
 * (`staging-commands.ts`), through `claim_seats()` like every other grant.
 */

export type IssueLevel = 'BLOCKING' | 'WARNING' | 'INFO';

export const STAGED_FIELDS = [
  'contactName',
  'contactEmail',
  'requestedAt',
  'attendeeName',
  'attendeeEmail',
  'allocationType',
  'player',
  'groupKey',
] as const;
export type StagedField = (typeof STAGED_FIELDS)[number];

export type RowIssue = { field: StagedField | null; code: string; level: IssueLevel; message: string };

/** The editable, normalised half of a staged row (`import_rows.normalized`). */
export type StagedFields = {
  contactName: string | null;
  contactEmail: string | null;
  /** ISO instant, or null — file order decides then. */
  requestedAt: string | null;
  /** The cell as written, kept when it could not be read as a time. */
  requestedAtRaw: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
  allocationType: AllocationChoice | null;
  /** The type cell as written, kept when it maps to nothing. */
  allocationRaw: string | null;
  groupKey: string | null;
  /** The cell matched against the roster, and what it matched. */
  playerNeedle: string | null;
  playerId: number | null;
  playerName: string | null;
  /** False for a close match below `import.fuzzy_match_threshold`, until someone confirms it. */
  playerConfirmed: boolean;
  playerConfidence: number | null;
};

/** What `import_batches.report` holds for a staged batch. */
export type StagedReport = {
  profile: ReturnType<typeof serialiseMappingProfile>;
  /** File lines that produced no seat at all (a wide sheet with nothing filled). */
  emptyLines: number;
};

function clean(value: string | undefined, transforms: MappingProfile['transforms'], kind: 'text' | 'email' | 'name' = 'text') {
  if (value == null) return null;
  let v = transforms.trimWhitespace ? value.trim() : value;
  if (v.trim() === '') return null;
  if (kind === 'email') v = v.replace(/\s+/g, '');
  if (kind === 'email' && transforms.lowercaseEmails) v = v.toLowerCase();
  if (kind === 'name' && transforms.titlecaseNames) {
    v = v.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  }
  return v;
}

const col = (row: SheetRow, column: string | null) => (column ? row.cells[column] : undefined);

/**
 * One file line as the seats it holds: one on a long sheet; on a wide sheet,
 * the contact (when they are a seat) and every seat group with anything in it.
 */
export function expandLine(
  line: SheetRow,
  profile: MappingProfile,
): { seatIndex: number; fields: Omit<StagedFields, 'playerId' | 'playerName' | 'playerConfirmed' | 'playerConfidence'> }[] {
  const t = profile.transforms;
  const contactName = clean(col(line, profile.columns.contactName), t, 'name');
  const contactEmail = clean(col(line, profile.columns.contactEmail), t, 'email');
  const requestedAtRaw = clean(col(line, profile.columns.requestedAt), t);
  const requestedAt = parseRequestedAt(requestedAtRaw)?.toISOString() ?? null;
  const groupKey = clean(col(line, profile.columns.groupKey), t);
  const playerNeedle = profile.playerMatch ? clean(col(line, profile.playerMatch.column), t) : null;
  const allocationRaw = clean(col(line, profile.columns.allocationType), t);
  const lineType = resolveAllocationType(allocationRaw, profile) ?? null;

  const party = { contactName, contactEmail, requestedAt, requestedAtRaw, groupKey, playerNeedle };
  const seat = (name: string | null, email: string | null, type: AllocationChoice | null, raw: string | null) => ({
    ...party,
    attendeeName: name,
    attendeeEmail: email,
    allocationType: type,
    allocationRaw: raw,
  });

  if (profile.seatGroups.length === 0) {
    return [
      {
        seatIndex: 0,
        fields: seat(
          clean(col(line, profile.columns.attendeeName), t, 'name'),
          clean(col(line, profile.columns.attendeeEmail), t, 'email'),
          lineType,
          allocationRaw,
        ),
      },
    ];
  }

  const seats: ReturnType<typeof expandLine> = [];
  if (profile.registrantSeat) {
    seats.push({ seatIndex: 0, fields: seat(contactName, contactEmail, lineType, allocationRaw) });
  }
  profile.seatGroups.forEach((group, index) => {
    const name = clean(col(line, group.attendeeName), t, 'name');
    const email = clean(col(line, group.attendeeEmail), t, 'email');
    if (name === null && email === null) return;
    seats.push({
      seatIndex: index + 1,
      fields: seat(name, email, group.allocationType ?? lineType, group.allocationType ? null : allocationRaw),
    });
  });
  return seats;
}

/**
 * Stage a file: one batch, one row per seat, validated. Returns the batch id
 * the grid opens.
 */
export async function stageBatch(input: {
  target: SegmentTarget;
  filename: string;
  profile: MappingProfile;
  rows: readonly SheetRow[];
  uploadedBy: string | null;
  queueReceipts: boolean;
}): Promise<{ batchId: number; rows: number; emptyLines: number }> {
  const { target, profile } = input;

  const expanded = input.rows.flatMap((line) =>
    expandLine(line, profile).map((seat) => ({ rowNumber: line.rowNumber, raw: line.cells, ...seat })),
  );
  const emptyLines = input.rows.filter((line) => !expanded.some((row) => row.rowNumber === line.rowNumber)).length;

  // Players matched once, per distinct cell, outside the transaction: the
  // matcher reads the roster on its own connection.
  let matches = new Map<string, PlayerMatch>();
  if (target.audienceMode === 'PLAYER_INVITED' && profile.playerMatch) {
    const threshold =
      (await resolveSetting<number>('import.fuzzy_match_threshold', {
        segmentId: target.segmentId,
        showId: target.showId,
        concertId: target.concertId,
      })) ?? 1;
    const needles = [...new Set(expanded.map((row) => row.fields.playerNeedle).filter((v): v is string => !!v))];
    matches = await matchPlayers(target.concertId, needles, profile.playerMatch.strategy, threshold);
  }

  return getDb().transaction(async (tx) => {
    const report: StagedReport = { profile: serialiseMappingProfile(profile), emptyLines };
    const [batch] = await tx.execute<{ id: string }>(sql`
      insert into import_batches (
        show_id, segment_id, filename, uploaded_by, row_count, status, report, queue_receipts
      ) values (
        ${target.showId}, ${target.segmentId}, ${input.filename}, ${input.uploadedBy},
        ${input.rows.length}, 'STAGED', ${JSON.stringify(report)}::jsonb, ${input.queueReceipts}
      )
      returning id
    `);
    const batchId = Number(batch.id);

    const CHUNK = 200;
    for (let i = 0; i < expanded.length; i += CHUNK) {
      const values = expanded.slice(i, i + CHUNK).map((row) => {
        const match = row.fields.playerNeedle ? (matches.get(row.fields.playerNeedle) ?? null) : null;
        const fields: StagedFields = {
          ...row.fields,
          playerId: match?.playerId ?? null,
          playerName: match?.fullName ?? null,
          playerConfirmed: match ? !match.needsConfirmation : false,
          playerConfidence: match?.confidence ?? null,
        };
        return sql`(${batchId}, ${row.rowNumber}, ${row.seatIndex}, ${JSON.stringify(row.raw)}::jsonb,
                    ${JSON.stringify(fields)}::jsonb, '[]'::jsonb, 'STAGED')`;
      });
      await tx.execute(sql`
        insert into import_rows (batch_id, row_number, seat_index, raw, normalized, issues, status)
        values ${sql.join(values, sql`, `)}
      `);
    }

    await validateBatch(tx, batchId);
    return { batchId, rows: expanded.length, emptyLines };
  });
}

type RowRecord = { id: number; rowNumber: number; seatIndex: number; fields: StagedFields; existingAction: string | null; existingId: number | null };

const partyKeyOf = (row: RowRecord) =>
  row.fields.groupKey
    ? `g:${row.fields.groupKey.toLowerCase()}`
    : row.fields.contactEmail
      ? `e:${row.fields.contactEmail.toLowerCase()}`
      : `r:${row.rowNumber}`;

/**
 * Re-derive every staged row's issues, its party, and the existing party it
 * matches — the whole batch, because an edit to one row can change another's
 * party (a corrected email joins it to a group).
 */
export async function validateBatch(tx: Tx, batchId: number): Promise<void> {
  const [batch] = await tx.execute<{
    segment_id: string;
    show_id: string;
    audience_mode: 'PUBLIC' | 'PLAYER_INVITED';
    player_match: boolean;
    cap: unknown;
  }>(sql`
    select b.segment_id, b.show_id, g.audience_mode::text as audience_mode,
           (b.report #> '{profile,player_match}') is not null
             and jsonb_typeof(b.report #> '{profile,player_match}') = 'object' as player_match,
           resolve_setting('form.max_tickets_per_response', b.segment_id) as cap
      from import_batches b join show_segments g on g.id = b.segment_id
     where b.id = ${batchId}
  `);
  if (!batch) return;
  const segmentId = Number(batch.segment_id);
  const cap = typeof batch.cap === 'number' ? batch.cap : null;

  const records: RowRecord[] = (
    await tx.execute<{
      id: string;
      row_number: number;
      seat_index: number;
      normalized: StagedFields;
      existing_action: string | null;
      existing_registration_id: string | null;
    }>(sql`
      select id, row_number, seat_index, normalized, existing_action::text as existing_action,
             existing_registration_id
        from import_rows
       where batch_id = ${batchId} and status = 'STAGED' and deleted_at is null
       order by row_number, seat_index
       for update
    `)
  ).map((row) => ({
    id: Number(row.id),
    rowNumber: row.row_number,
    seatIndex: row.seat_index,
    fields: row.normalized,
    existingAction: row.existing_action,
    existingId: row.existing_registration_id === null ? null : Number(row.existing_registration_id),
  }));
  if (records.length === 0) return;

  const issues = new Map<number, RowIssue[]>(records.map((row) => [row.id, []]));
  const add = (row: RowRecord, issue: RowIssue) => issues.get(row.id)!.push(issue);

  // Row by row.
  for (const row of records) {
    const f = row.fields;
    if (!f.contactName) {
      add(row, {
        field: 'contactName',
        code: 'CONTACT_NAME_MISSING',
        level: 'BLOCKING',
        message: 'No contact name. It names the party, and every unnamed seat tickets under it.',
      });
    }
    if (f.requestedAtRaw && !f.requestedAt) {
      add(row, {
        field: 'requestedAt',
        code: 'REQUESTED_AT_UNREADABLE',
        level: 'BLOCKING',
        message: `Could not read "${f.requestedAtRaw}" as a date and time. Correct it, or clear it to use the file order.`,
      });
    }
    if (f.contactEmail) {
      const problem = addressShapeIssue(f.contactEmail);
      if (problem) {
        add(row, { field: 'contactEmail', code: 'CONTACT_EMAIL_MALFORMED', level: 'WARNING', message: `${problem} The party is flagged Suspicious address.` });
      }
    } else if (!f.groupKey) {
      add(row, {
        field: 'contactEmail',
        code: 'NO_GROUPING_KEY',
        level: 'WARNING',
        message: 'No contact email, so this row is a party of its own and no email can reach it.',
      });
    }
    if (f.attendeeEmail && addressShapeIssue(f.attendeeEmail)) {
      add(row, { field: 'attendeeEmail', code: 'ATTENDEE_EMAIL_MALFORMED', level: 'WARNING', message: addressShapeIssue(f.attendeeEmail)! });
    }
    if (!f.attendeeName) {
      add(row, {
        field: 'attendeeName',
        code: 'PLACEHOLDER_NAME',
        level: 'INFO',
        message: `No guest name — tickets as "Guest of ${f.contactName ?? 'the contact'}", and the party can name them from its update link.`,
      });
    }
    if (!f.allocationType) {
      add(row, {
        field: 'allocationType',
        code: 'ALLOCATION_TYPE_UNMAPPED',
        level: 'BLOCKING',
        message: `"${f.allocationRaw ?? ''}" is not mapped to Base or Extra. Choose one.`,
      });
    } else if (batch.audience_mode === 'PUBLIC' && f.allocationType === 'BASE') {
      add(row, {
        field: 'allocationType',
        code: 'BASE_IN_PUBLIC_SEGMENT',
        level: 'BLOCKING',
        message: 'Base seats exist only in a player-invited segment; here the engine would waitlist it. Make it Extra.',
      });
    }
  }

  // Parties.
  const parties = new Map<string, RowRecord[]>();
  for (const row of records) {
    const key = partyKeyOf(row);
    parties.set(key, [...(parties.get(key) ?? []), row]);
  }

  // Existing parties in the segment, by contact email.
  const emails = [...new Set(records.map((row) => row.fields.contactEmail?.toLowerCase()).filter((e): e is string => !!e))];
  const existing = new Map<string, { id: number; name: string; cancelled: boolean; seats: string[] }>();
  if (emails.length > 0) {
    const found = await tx.execute<{ id: string; email: string; contact_name: string; cancelled: boolean; seats: string[] | null }>(sql`
      select distinct on (lower(r.contact_email::text))
             r.id, lower(r.contact_email::text) as email, r.contact_name, r.status = 'CANCELLED' as cancelled,
             (select array_agg(case when a.name_source = 'PLACEHOLDER' then '' else lower(btrim(a.full_name)) end)
                from attendees a
               where a.registration_id = r.id and a.deleted_at is null and a.status <> 'CANCELLED') as seats
        from registrations r
       where r.segment_id = ${segmentId}
         and r.deleted_at is null
         and lower(r.contact_email::text) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})
       order by lower(r.contact_email::text), (r.status = 'CANCELLED'), r.requested_at, r.id
    `);
    for (const row of found) {
      existing.set(row.email, { id: Number(row.id), name: row.contact_name, cancelled: row.cancelled, seats: row.seats ?? [] });
    }
  }

  const updates: { row: RowRecord; key: string; existingId: number | null; action: string | null }[] = [];
  for (const [key, rows] of parties) {
    const head = rows[0];
    const email = head.fields.contactEmail?.toLowerCase() ?? null;

    for (const row of rows.slice(1)) {
      if (row.fields.contactName && head.fields.contactName && row.fields.contactName !== head.fields.contactName) {
        add(row, {
          field: 'contactName',
          code: 'PARTY_CONTACT_DISAGREEMENT',
          level: 'WARNING',
          message: `The party's first row gives the contact as "${head.fields.contactName}". The first row wins.`,
        });
      }
    }

    // The player is the party's, taken from its first row.
    if (batch.audience_mode === 'PLAYER_INVITED' && batch.player_match) {
      const f = head.fields;
      if (f.playerId === null) {
        add(head, {
          field: 'player',
          code: 'PLAYER_NOT_MATCHED',
          level: 'BLOCKING',
          message: f.playerNeedle
            ? `No player matches "${f.playerNeedle}". Choose one.`
            : 'Nothing to match a player on. Choose the player who invited this party.',
        });
      } else if (!f.playerConfirmed) {
        add(head, {
          field: 'player',
          code: 'PLAYER_MATCH_UNCONFIRMED',
          level: 'BLOCKING',
          message: `"${f.playerNeedle}" looks like ${f.playerName} (${Math.round((f.playerConfidence ?? 0) * 100)}% similar). Confirm or choose another.`,
        });
      }
    }

    if (cap !== null && rows.length > cap) {
      add(head, {
        field: null,
        code: 'PARTY_OVER_CAP',
        level: 'WARNING',
        message: `${rows.length} seats, above the ${cap}-seat party cap. Imported and flagged.`,
      });
    }

    const match = email ? existing.get(email) : undefined;
    let action = match && head.existingId === match.id ? head.existingAction : null;
    if (match) {
      action ??= match.cancelled ? 'SKIP' : 'ADD_SEATS';
      add(head, {
        field: null,
        code: match.cancelled ? 'EXISTING_PARTY_CANCELLED' : 'EXISTING_PARTY',
        level: match.cancelled ? 'WARNING' : 'INFO',
        message: match.cancelled
          ? `${match.name} already registered with this email and was cancelled. Skipped unless you choose otherwise — restoring the existing party is usually right.`
          : `${match.name} already holds a party in this segment with this email. New seats are ${action === 'ADD_SEATS' ? 'added to it' : action === 'SKIP' ? 'skipped' : 'kept as a separate party'}.`,
      });
      // Seats the party already has, by name: re-uploading the cumulative
      // sheet recognises them rather than adding them twice.
      if (action === 'ADD_SEATS') {
        const pool = [...match.seats];
        for (const row of rows) {
          const name = row.fields.attendeeName ? row.fields.attendeeName.trim().toLowerCase() : '';
          const at = pool.indexOf(name);
          if (at === -1) continue;
          pool.splice(at, 1);
          add(row, {
            field: null,
            code: 'ALREADY_IMPORTED',
            level: 'INFO',
            message: `Already a seat of ${match.name}'s party. Skipped at commit.`,
          });
        }
      }
    }
    for (const row of rows) updates.push({ row, key, existingId: match?.id ?? null, action: match ? action : null });
  }

  for (const { row, key, existingId, action } of updates) {
    await tx.execute(sql`
      update import_rows
         set issues = ${JSON.stringify(issues.get(row.id))}::jsonb,
             party_key = ${key},
             existing_registration_id = ${existingId},
             existing_action = ${action}::import_match_action,
             updated_at = now()
       where id = ${row.id}
    `);
  }
}

/** The fields an edit may change, and how a typed value becomes the stored one. */
export function applyEdit(
  fields: StagedFields,
  field: Exclude<StagedField, 'player'>,
  value: string | null,
): StagedFields {
  const text = value?.trim() ? value.trim() : null;
  switch (field) {
    case 'contactName':
      return { ...fields, contactName: text };
    case 'contactEmail':
      return { ...fields, contactEmail: text ? text.replace(/\s+/g, '').toLowerCase() : null };
    case 'attendeeName':
      return { ...fields, attendeeName: text };
    case 'attendeeEmail':
      return { ...fields, attendeeEmail: text ? text.replace(/\s+/g, '').toLowerCase() : null };
    case 'groupKey':
      return { ...fields, groupKey: text };
    case 'requestedAt':
      return { ...fields, requestedAtRaw: text, requestedAt: parseRequestedAt(text)?.toISOString() ?? null };
    case 'allocationType':
      return {
        ...fields,
        allocationType: text === 'BASE' || text === 'EXTRA' ? text : null,
        allocationRaw: text,
      };
  }
}
