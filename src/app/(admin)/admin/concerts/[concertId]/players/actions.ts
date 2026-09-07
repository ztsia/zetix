'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage, pgError } from '@/db/errors';
import { players } from '@/db/schema/people';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/guards';
import { generateInviteToken } from '@/lib/invite-token';
import { planPlayerImport, type PlayerField, type PlayerImportPlan } from '@/lib/players/import';
import type { FormState } from '../../form-state';

/**
 * Players — CRUD, invite tokens and CSV import (spec/admin.md §14.1,
 * spec/domain.md §5.1).
 *
 * **Adding or reactivating a player is one of the three routes the §7.4
 * entitlement guard watches.** Every player in a concert is entitled to the base
 * quota of each player-invited segment in it, so the 81st player can be the one
 * that oversubscribes a segment nobody was looking at. The guard lives in
 * Postgres and fires on `players` directly; nothing here re-implements it, and
 * the sentence it raises — naming the numbers and the ways out — is passed
 * through untouched.
 *
 * A player consumes **zero** seats in the player segment of their own show
 * (decision 3). They are on stage. What they hold is an entitlement to invite
 * guests, which is what the quota counts.
 */

const UNIQUE_VIOLATION = '23505';

const blankToNull = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  return trimmed === '' || trimmed === undefined ? null : trimmed;
};

const optionalText = z.preprocess(blankToNull, z.string().trim().max(200).nullable());

const playerSchema = z.object({
  fullName: z.string().trim().min(1, 'A player needs a name.').max(200),
  email: z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .email('That is not an email address.')
      .max(320)
      .nullable(),
  ),
  instrument: optionalText,
  section: optionalText,
  isActive: z.enum(['true', 'false']),
});

function readPlayerForm(formData: FormData) {
  return playerSchema.safeParse({
    fullName: formData.get('fullName') ?? '',
    email: formData.get('email') ?? '',
    instrument: formData.get('instrument') ?? '',
    section: formData.get('section') ?? '',
    isActive: formData.get('isActive') ?? 'true',
  });
}

/**
 * `players_concert_email_key` is unique on `(concert_id, email)`, and `email` is
 * `citext` — so the clash is case-insensitive and the constraint name is not a
 * sentence anybody should have to read.
 */
function friendlyPlayerError(error: unknown, email: string | null): string {
  if (pgError(error)?.code === UNIQUE_VIOLATION) {
    return email
      ? `Another player in this concert already uses ${email}. Addresses are matched without regard to case.`
      : 'Another player in this concert already has these details.';
  }
  return dbErrorMessage(error);
}

export async function createPlayerAction(
  concertId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const parsed = readPlayerForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  try {
    const [created] = await getDb()
      .insert(players)
      .values({
        concertId,
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        instrument: parsed.data.instrument,
        section: parsed.data.section,
        isActive: parsed.data.isActive === 'true',
        inviteToken: generateInviteToken(),
      })
      .returning({ id: players.id, fullName: players.fullName });

    await writeAuditLog({
      action: 'player.created',
      entityType: 'player',
      entityId: created.id,
      after: { fullName: created.fullName, email: parsed.data.email },
    });

    revalidatePath(`/admin/concerts/${concertId}/players`);
    return { error: null, message: `Added ${created.fullName}.` };
  } catch (error) {
    return { error: friendlyPlayerError(error, parsed.data.email) };
  }
}

export async function updatePlayerAction(
  concertId: number,
  playerId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const parsed = readPlayerForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  try {
    const db = getDb();
    const [before] = await db
      .select({
        fullName: players.fullName,
        email: players.email,
        isActive: players.isActive,
      })
      .from(players)
      .where(
        and(
          eq(players.id, playerId),
          eq(players.concertId, concertId),
          isNull(players.deletedAt),
        ),
      );
    if (!before) return { error: 'That player no longer exists.' };

    await db
      .update(players)
      .set({
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        instrument: parsed.data.instrument,
        section: parsed.data.section,
        // Reactivating is guard route 2: it adds an entitlement back to every
        // player segment in the concert.
        isActive: parsed.data.isActive === 'true',
        updatedAt: new Date(),
      })
      .where(eq(players.id, playerId));

    await writeAuditLog({
      action: 'player.updated',
      entityType: 'player',
      entityId: playerId,
      before,
      after: {
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        isActive: parsed.data.isActive === 'true',
      },
    });

    revalidatePath(`/admin/concerts/${concertId}/players`);
    return { error: null, message: `Saved ${parsed.data.fullName}.` };
  } catch (error) {
    return { error: friendlyPlayerError(error, parsed.data.email) };
  }
}

/**
 * Activate or deactivate, without opening the form.
 *
 * Deactivating is the honest lever §7.4 offers when a segment is
 * oversubscribed — "or deactivate 32 players" — so it is worth one click rather
 * than a dialog and a dropdown.
 */
export async function setPlayerActiveAction(
  concertId: number,
  playerId: number,
  isActive: boolean,
): Promise<FormState> {
  await requireAdmin();

  const parsed = z
    .object({ playerId: z.number().int().positive(), isActive: z.boolean() })
    .safeParse({ playerId, isActive });
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    const db = getDb();
    const [before] = await db
      .select({ fullName: players.fullName, isActive: players.isActive })
      .from(players)
      .where(
        and(
          eq(players.id, playerId),
          eq(players.concertId, concertId),
          isNull(players.deletedAt),
        ),
      );
    if (!before) return { error: 'That player no longer exists.' };

    await db
      .update(players)
      .set({ isActive: parsed.data.isActive, updatedAt: new Date() })
      .where(eq(players.id, playerId));

    await writeAuditLog({
      action: parsed.data.isActive ? 'player.reactivated' : 'player.deactivated',
      entityType: 'player',
      entityId: playerId,
      before: { isActive: before.isActive },
      after: { isActive: parsed.data.isActive },
    });

    revalidatePath(`/admin/concerts/${concertId}/players`);
    return {
      error: null,
      message: `${before.fullName} is now ${parsed.data.isActive ? 'active' : 'inactive'}.`,
    };
  } catch (error) {
    // Reactivating can breach base entitlement, and the §7.4 sentence is what
    // tells the admin which segment and by how much.
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Issue a fresh invite token, invalidating the old link.
 *
 * Unlike `qr_token`, an invite token is **not** immutable: it is a credential
 * with no account behind it, so rotating it is the only way to revoke a link
 * that has been forwarded to the wrong person (spec/domain.md §5.1). Anyone
 * holding the previous URL stops being able to use it, which is the point and
 * is why the UI confirms first.
 */
export async function rotateInviteTokenAction(
  concertId: number,
  playerId: number,
): Promise<FormState> {
  await requireAdmin();

  try {
    const db = getDb();
    const [before] = await db
      .select({ fullName: players.fullName })
      .from(players)
      .where(
        and(
          eq(players.id, playerId),
          eq(players.concertId, concertId),
          isNull(players.deletedAt),
        ),
      );
    if (!before) return { error: 'That player no longer exists.' };

    await db
      .update(players)
      .set({ inviteToken: generateInviteToken(), updatedAt: new Date() })
      .where(eq(players.id, playerId));

    // The token itself is not logged: the log is readable by anyone who can
    // read the console, and writing a live credential into it turns an audit
    // trail into a second copy of the thing being protected.
    await writeAuditLog({
      action: 'player.invite_rotated',
      entityType: 'player',
      entityId: playerId,
      after: { fullName: before.fullName },
    });

    revalidatePath(`/admin/concerts/${concertId}/players`);
    return {
      error: null,
      message: `${before.fullName} has a new invite link. The previous one no longer works.`,
    };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

export async function deletePlayerAction(
  concertId: number,
  playerId: number,
): Promise<FormState> {
  await requireAdmin();

  try {
    const db = getDb();
    const [before] = await db
      .select({ fullName: players.fullName })
      .from(players)
      .where(
        and(
          eq(players.id, playerId),
          eq(players.concertId, concertId),
          isNull(players.deletedAt),
        ),
      );
    if (!before) return { error: 'That player no longer exists.' };

    await db
      .update(players)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(players.id, playerId));

    await writeAuditLog({
      action: 'player.deleted',
      entityType: 'player',
      entityId: playerId,
      before: { fullName: before.fullName },
    });

    revalidatePath(`/admin/concerts/${concertId}/players`);
    return { error: null, message: `Removed ${before.fullName}.` };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

const MAPPING_FIELDS: readonly PlayerField[] = ['fullName', 'email', 'instrument', 'section'];

function readOverrides(formData: FormData): Partial<Record<PlayerField, string | null>> {
  const overrides: Partial<Record<PlayerField, string | null>> = {};
  for (const field of MAPPING_FIELDS) {
    const value = formData.get(`map-${field}`);
    if (typeof value === 'string') overrides[field] = value === '' ? null : value;
  }
  return overrides;
}

async function readUpload(formData: FormData): Promise<{ bytes: Buffer; name: string } | null> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return null;
  return { bytes: Buffer.from(await file.arrayBuffer()), name: file.name };
}

async function existingPlayers(concertId: number) {
  return getDb()
    .select({ id: players.id, email: players.email })
    .from(players)
    .where(and(eq(players.concertId, concertId), isNull(players.deletedAt)));
}

export type PlanResult =
  | { ok: true; plan: PlayerImportPlan }
  | { ok: false; error: string };

/**
 * Reads the file and reports what committing it would do. Writes nothing.
 */
export async function planPlayerImportAction(
  concertId: number,
  formData: FormData,
): Promise<PlanResult> {
  await requireAdmin();

  try {
    const upload = await readUpload(formData);
    if (!upload) return { ok: false, error: 'Choose a CSV or spreadsheet first.' };

    const plan = await planPlayerImport(
      upload.bytes,
      upload.name,
      await existingPlayers(concertId),
      readOverrides(formData),
    );

    if (plan.rows.length === 0) {
      return { ok: false, error: 'That file has a header row but no players under it.' };
    }
    if (!plan.mapping.fullName) {
      return {
        ok: false,
        error:
          'No column in that file looks like a name. Pick which column holds the player’s name.',
      };
    }
    return { ok: true, plan };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not read that file.' };
  }
}

/**
 * Commits the import.
 *
 * **The file is re-read here rather than a plan being posted back.** A plan that
 * has been through the browser is user input, and trusting it would let a
 * crafted request write rows the preview never showed. Parsing twice costs
 * milliseconds on a file of eighty rows.
 *
 * **The whole import is one transaction.** Adding players is entitlement-guard
 * route 2, and the guard is deferred to `COMMIT`: it judges the concert's
 * players as a set. Committing row by row would let an import stop halfway with
 * forty players loaded and the segment already oversubscribed — and nothing to
 * say which forty. All or nothing is both simpler to explain and the only
 * behaviour the guard can actually give.
 */
export async function commitPlayerImportAction(
  concertId: number,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  let created = 0;
  let updated = 0;

  try {
    const upload = await readUpload(formData);
    if (!upload) return { error: 'Choose a CSV or spreadsheet first.' };

    const plan = await planPlayerImport(
      upload.bytes,
      upload.name,
      await existingPlayers(concertId),
      readOverrides(formData),
    );

    const db = getDb();
    await db.transaction(async (tx) => {
      for (const row of plan.rows) {
        if (row.action === 'skip') continue;

        if (row.action === 'update' && row.email) {
          await tx
            .update(players)
            .set({
              fullName: row.fullName,
              instrument: row.instrument,
              section: row.section,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(players.concertId, concertId),
                eq(players.email, row.email),
                isNull(players.deletedAt),
              ),
            );
          updated += 1;
          continue;
        }

        await tx.insert(players).values({
          concertId,
          fullName: row.fullName,
          email: row.email,
          instrument: row.instrument,
          section: row.section,
          isActive: true,
          inviteToken: generateInviteToken(),
        });
        created += 1;
      }

      await writeAuditLog(
        {
          action: 'player.imported',
          entityType: 'concert',
          entityId: concertId,
          after: {
            filename: upload.name,
            created,
            updated,
            skipped: plan.counts.skip,
          },
        },
        tx,
      );
    });

    revalidatePath(`/admin/concerts/${concertId}/players`);
    return {
      error: null,
      message:
        `Imported ${created} player${created === 1 ? '' : 's'}` +
        (updated > 0 ? `, updated ${updated}` : '') +
        (plan.counts.skip > 0 ? `, skipped ${plan.counts.skip}` : '') +
        '.',
    };
  } catch (error) {
    // Nothing was written: the guard rejects at COMMIT and takes the whole
    // import with it. The §7.4 sentence says which segment and by how much.
    return { error: dbErrorMessage(error) };
  }
}
