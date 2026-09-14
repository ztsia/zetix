'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/guards';
import type { FormState } from '../../../form-state';
import { registrationInConcert } from '../queries';

/**
 * The admin override of spec/v2.md §8.1.4 — *"until it verifies **or an admin
 * overrides**"*.
 *
 * Someone has to be able to say "I know this person, send their tickets", or a
 * registrant whose mail client silently ate the link has no route to a seat they
 * already hold. It exists for the same reason every automatic step in this
 * system keeps a manual twin (decision 42).
 */

const ok = (message: string): FormState => ({ error: null, message });
const fail = (error: string): FormState => ({ error });

/**
 * Release one party into the blast without them having clicked anything.
 *
 * **It stamps `email_verified_at` rather than clearing the token**, and the
 * difference is the record. A null token means "was never asked to verify" —
 * an import, a player form — so clearing it here would make an overridden party
 * indistinguishable from one that never needed the gate, and this screen would
 * lose the row it is meant to be showing. The token stays; the timestamp is the
 * fact, and the `audit_log` entry says a person decided it rather than a click.
 */
export async function overrideVerificationAction(
  concertId: number,
  registrationId: number,
): Promise<FormState> {
  const admin = await requireAdmin();

  if (!(await registrationInConcert(concertId, registrationId))) {
    return fail('That registration does not belong to this concert.');
  }

  try {
    const rows = await getDb().execute<{ contact_email: string }>(sql`
      update registrations
         set email_verified_at = now()
       where id = ${registrationId}::bigint
         and email_verified_at is null
         and deleted_at is null
      returning contact_email
    `);

    const row = rows[0];
    // Already released — by a click that landed between the page render and
    // this press, or by another admin. Not an error, and not worth a second
    // audit entry saying the same thing.
    if (!row) return ok('That registration was already verified.');

    await writeAuditLog({
      actorId: admin.id,
      action: 'registration.verification_overridden',
      entityType: 'registration',
      entityId: registrationId,
      after: { contact_email: row.contact_email, overridden: true },
    });

    revalidatePath(`/admin/concerts/${concertId}/registrations/unverified`);
    revalidatePath(`/admin/concerts/${concertId}/registrations`);
    return ok(`${row.contact_email} released — their tickets will be included in the next blast.`);
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
}
