import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { mappingProfiles } from '@/db/schema/imports';
import { getSessionUser } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit';
import { parseMappingProfile, serialiseMappingProfile } from '@/lib/import/profile';

/**
 * Saved mapping profiles (spec/import.md §9.3).
 *
 * "Profiles are saved and reusable, since each concert's form differs slightly."
 * The point is round two: the second import of a concert should be a profile
 * chosen from a list, not the same mapping exercise done again from memory — and
 * a re-done mapping is a chance to map a column differently from the first run,
 * which is how two rounds of one form end up in the database disagreeing.
 *
 * `show_id` null makes a profile reusable across shows, which is the common case:
 * the form's shape belongs to the organisation's habits, not to one evening.
 */
export const runtime = 'nodejs';

const saveSchema = z.object({
  name: z.string().min(1).max(120),
  showId: z.number().int().positive().nullable().optional(),
  audience: z.enum(['PUBLIC', 'PLAYER_INVITED']).nullable().optional(),
  config: z.unknown(),
});

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  const showId = Number(new URL(request.url).searchParams.get('showId'));
  const scope = Number.isInteger(showId) && showId > 0 ? showId : null;

  const rows = await getDb()
    .select({
      id: mappingProfiles.id,
      name: mappingProfiles.name,
      showId: mappingProfiles.showId,
      audience: mappingProfiles.audience,
      config: mappingProfiles.config,
      updatedAt: mappingProfiles.updatedAt,
    })
    .from(mappingProfiles)
    .where(
      and(
        isNull(mappingProfiles.deletedAt),
        // This show's own profiles, plus the ones saved for any show.
        scope
          ? or(eq(mappingProfiles.showId, scope), isNull(mappingProfiles.showId))
          : isNull(mappingProfiles.showId),
      ),
    )
    .orderBy(desc(mappingProfiles.updatedAt))
    .limit(50);

  return NextResponse.json({ profiles: rows });
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (user.role !== 'ADMIN') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Malformed profile request.' }, { status: 400 });
  }

  // Validated through the same schema the importer reads it back with, so a
  // profile that cannot be used can never be stored.
  let config;
  try {
    config = serialiseMappingProfile(parseMappingProfile(parsed.data.config));
  } catch (error) {
    return NextResponse.json(
      {
        error: `That mapping is not valid: ${error instanceof Error ? error.message : 'unknown'}`,
      },
      { status: 400 },
    );
  }

  const [row] = await getDb()
    .insert(mappingProfiles)
    .values({
      name: parsed.data.name,
      showId: parsed.data.showId ?? null,
      audience: parsed.data.audience ?? null,
      config,
    })
    .returning({ id: mappingProfiles.id });

  await writeAuditLog({
    action: 'import.profile_saved',
    entityType: 'mapping_profile',
    entityId: row.id,
    after: { name: parsed.data.name, showId: parsed.data.showId ?? null },
  });

  return NextResponse.json({ id: row.id });
}
