'use server';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import { mintUpdateToken, updateUrl } from '@/lib/intake/update-link';

/**
 * The party's own update link (spec/v3.md §25.6), for an admin to pass on by
 * hand — to a party entered in the console, or one whose receipt went astray.
 * A party that has never had one is given one here; an existing one is
 * returned unchanged, so a link already sent keeps working.
 */
export async function partyUpdateLinkAction(
  concertId: number,
  registrationId: number,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const admin = await requireRole('ADMIN');
  if (!Number.isSafeInteger(concertId) || !Number.isSafeInteger(registrationId)) {
    return { ok: false, error: 'That party no longer exists.' };
  }
  const minted = mintUpdateToken();
  const [row] = await getDb().execute<{ update_token: string; minted: boolean }>(sql`
    update registrations r
       set update_token = coalesce(r.update_token, ${minted})
      from shows s
     where s.id = r.show_id and s.concert_id = ${concertId}
       and r.id = ${registrationId} and r.deleted_at is null
    returning r.update_token, r.update_token = ${minted} as minted
  `);
  if (!row) return { ok: false, error: 'That party no longer exists.' };
  if (row.minted) {
    await writeAuditLog({
      action: 'registration.update_link_created',
      entityType: 'registration',
      entityId: registrationId,
      actorId: admin.id,
    });
  }
  return { ok: true, url: updateUrl(row.update_token) };
}
