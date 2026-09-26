import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import { addressIssue } from '@/lib/email/address';
import { updateRegistrationDetails } from '@/lib/registrations/mutations';

/**
 * Change only a party's contact email — the "fix address" half of a failed or
 * bounced message's exit (spec/v3.md §24.4).
 *
 * Through `updateRegistrationDetails()`, the record's own edit, so the same
 * three things happen as when the address is edited there: pending messages
 * are re-addressed in the same transaction (§24.3), the §24.6 verdict is
 * stored with the new address, and the change is in the party's Activity. The
 * other details are passed back unchanged, since that function writes them all.
 */
export async function changeContactEmail(
  concertId: number,
  registrationId: number,
  email: string,
  actorId: string | null,
): Promise<{ issue: string | null; readdressed: number } | null> {
  const [current] = await getDb().execute<{
    contact_name: string;
    contact_email: string | null;
    contact_phone: string | null;
    player_id: string | null;
    round_label: string | null;
  }>(sql`
    select r.contact_name, r.contact_email::text as contact_email, r.contact_phone, r.player_id, r.round_label
      from registrations r join shows s on s.id = r.show_id
     where r.id = ${registrationId} and s.concert_id = ${concertId} and r.deleted_at is null
  `);
  if (!current) return null;

  // The MX lookup is a network call: before the transaction, never inside it.
  const issue = await addressIssue(email);
  const result = await updateRegistrationDetails(registrationId, {
    contactName: current.contact_name,
    contactEmail: email,
    contactPhone: current.contact_phone,
    playerId: current.player_id ? Number(current.player_id) : null,
    roundLabel: current.round_label,
    requestedAt: null,
    emailIssue: issue,
  });
  if (result.emailChanged) {
    await writeAuditLog({
      action: 'registration.updated',
      entityType: 'registration',
      entityId: registrationId,
      before: result.before,
      after: { contactEmail: email, emailIssue: issue, readdressed: result.readdressed },
      actorId,
    });
  }
  return { issue, readdressed: result.readdressed };
}
