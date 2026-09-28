'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import { applyEdit, STAGED_FIELDS, validateBatch, type StagedFields } from '@/lib/import/staging';

/**
 * Editing the staging grid (spec/v3.md §25.7): a cell, a party's player, or
 * what to do about the party its email already holds. Every edit re-validates
 * the batch in the same transaction, so the grid redraws with the issues as
 * they now stand.
 */

type Result = { ok: true } | { ok: false; error: string };

const cellSchema = z.object({
  concertId: z.number().int().positive(),
  batchId: z.number().int().positive(),
  rowId: z.number().int().positive(),
  field: z.enum(STAGED_FIELDS),
  value: z.string().max(500).nullable(),
});

/** Fields that came from the file's line rather than from one guest's cells. */
const LINE_FIELDS = new Set(['contactName', 'contactEmail', 'requestedAt', 'groupKey']);

async function stagedRow(concertId: number, batchId: number, rowId: number) {
  const [row] = await getDb().execute<{ party_key: string | null; row_number: number }>(sql`
    select r.party_key, r.row_number
      from import_rows r join import_batches b on b.id = r.batch_id join shows s on s.id = b.show_id
     where r.id = ${rowId} and r.batch_id = ${batchId} and s.concert_id = ${concertId}
       and r.status = 'STAGED' and b.status = 'STAGED' and r.deleted_at is null
  `);
  return row ?? null;
}

export async function updateStagedCellAction(input: z.input<typeof cellSchema>): Promise<Result> {
  const admin = await requireRole('ADMIN');
  const parsed = cellSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That change could not be read.' };
  const { concertId, batchId, rowId, field, value } = parsed.data;

  const row = await stagedRow(concertId, batchId, rowId);
  if (!row) return { ok: false, error: 'That row is no longer staged.' };

  let player: { id: number; name: string } | null = null;
  if (field === 'player') {
    const playerId = Number(value);
    const [found] = await getDb().execute<{ id: string; full_name: string }>(sql`
      select id, full_name from players
       where id = ${Number.isSafeInteger(playerId) ? playerId : 0} and concert_id = ${concertId}
         and is_active and deleted_at is null
    `);
    if (!found) return { ok: false, error: 'Choose a player from this concert.' };
    player = { id: Number(found.id), name: found.full_name };
  }

  /**
   * Which rows an edit reaches. The player is the party's, so it is set on
   * every row of the party; the contact, the timestamp and the group column
   * came from one line of the file, so they change on every seat that line
   * produced (a wide sheet's line is several rows). A guest's own cells are
   * that row's alone.
   */
  const scope =
    field === 'player'
      ? sql`party_key is not distinct from ${row.party_key}`
      : LINE_FIELDS.has(field)
        ? sql`row_number = ${row.row_number}`
        : sql`id = ${rowId}`;

  await getDb().transaction(async (tx) => {
    const targets = await tx.execute<{ id: string; normalized: StagedFields }>(sql`
      select id, normalized from import_rows
       where batch_id = ${batchId} and status = 'STAGED' and deleted_at is null and ${scope}
       for update
    `);
    for (const target of targets) {
      const next: StagedFields = player
        ? { ...target.normalized, playerId: player.id, playerName: player.name, playerConfirmed: true }
        : applyEdit(target.normalized, field as Exclude<typeof field, 'player'>, value);
      await tx.execute(sql`
        update import_rows set normalized = ${JSON.stringify(next)}::jsonb, updated_at = now()
         where id = ${Number(target.id)}
      `);
    }
    await validateBatch(tx, batchId);
    await writeAuditLog(
      {
        action: 'import_row.edited',
        entityType: 'import_batch',
        entityId: batchId,
        after: { row: rowId, field, rows: targets.length },
        actorId: admin.id,
      },
      tx,
    );
  });
  revalidatePath(`/admin/concerts/${concertId}/import/${batchId}`);
  return { ok: true };
}

const actionSchema = z.object({
  concertId: z.number().int().positive(),
  batchId: z.number().int().positive(),
  partyKey: z.string().min(1).max(600),
  action: z.enum(['ADD_SEATS', 'SKIP', 'SEPARATE']),
});

/** Add seats to the matched party, skip, or keep separate — per party (§25.7). */
export async function setExistingActionAction(input: z.input<typeof actionSchema>): Promise<Result> {
  const admin = await requireRole('ADMIN');
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That choice could not be read.' };
  const { concertId, batchId, partyKey, action } = parsed.data;

  const updated = await getDb().transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      update import_rows r set existing_action = ${action}::import_match_action, updated_at = now()
        from import_batches b join shows s on s.id = b.show_id
       where b.id = r.batch_id and s.concert_id = ${concertId} and b.status = 'STAGED'
         and r.batch_id = ${batchId} and r.party_key = ${partyKey} and r.status = 'STAGED'
         and r.existing_registration_id is not null
      returning r.id
    `);
    if (rows.length > 0) {
      await validateBatch(tx, batchId);
      await writeAuditLog(
        {
          action: 'import_row.match_action_set',
          entityType: 'import_batch',
          entityId: batchId,
          after: { partyKey, action },
          actorId: admin.id,
        },
        tx,
      );
    }
    return rows.length;
  });
  if (updated === 0) return { ok: false, error: 'That party has nothing to match any more.' };
  revalidatePath(`/admin/concerts/${concertId}/import/${batchId}`);
  return { ok: true };
}
