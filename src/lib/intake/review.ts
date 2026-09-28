import 'server-only';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/lib/commands/define';
import { writeAuditLog } from '@/lib/audit';

/**
 * The review gate at intake (spec/v3.md §25.4, §25.5).
 *
 * **Seats are claimed on submit; the ticket waits for approval.** A party that
 * arrives by a public or player form, or by import, carries
 * `approved_at = null` and sits in `NEEDS_REVIEW`, which Send tickets skips.
 * Two things happen here, in the caller's transaction, once the party's seats
 * exist:
 *
 * 1. **Duplicate detection** — `refresh_duplicate_candidates()` stores every
 *    pair this party now makes with another live party in the show, which
 *    raises `POSSIBLE_DUPLICATE`.
 * 2. **Auto-approval** — when `review.auto_approve_clean` resolves true for the
 *    segment and `party_pipeline` shows the party with no flags at all, it is
 *    approved at once. A flag of any kind leaves it for a person.
 *
 * Duplicates run first so a possible duplicate is never auto-approved.
 */

export type ReviewOutcome = {
  /** Candidate pairs stored or refreshed for this party. */
  duplicates: number;
  /** Whether the party is approved now. */
  approved: boolean;
  flags: string[];
};

export async function reviewAtIntake(
  tx: Tx,
  registrationId: number,
  options: {
    /**
     * Seats were just added to a party that already existed. Its earlier
     * approval covered the earlier seats, not these — a new submission is a
     * new claim to review (§25.4), so approval is taken back first.
     */
    resetApproval?: boolean;
  } = {},
): Promise<ReviewOutcome> {
  if (options.resetApproval) {
    await tx.execute(sql`
      update registrations set approved_at = null, approved_by = null
       where id = ${registrationId} and approved_at is not null
    `);
  }

  const [found] = await tx.execute<{ n: number }>(sql`
    select refresh_duplicate_candidates(${registrationId}::bigint) as n
  `);

  const [party] = await tx.execute<{ flags: string[] | null; approved: boolean; auto: unknown }>(sql`
    select p.flags, p.approved_at is not null as approved,
           resolve_setting('review.auto_approve_clean', p.segment_id) as auto
      from party_pipeline p
     where p.registration_id = ${registrationId}
  `);
  if (!party) return { duplicates: Number(found?.n ?? 0), approved: false, flags: [] };

  const flags = party.flags ?? [];
  let approved = party.approved;
  if (!approved && party.auto === true && flags.length === 0) {
    const rows = await tx.execute(sql`
      update registrations set approved_at = now(), approved_by = null
       where id = ${registrationId} and approved_at is null
      returning id
    `);
    approved = rows.length > 0;
    if (approved) {
      await writeAuditLog(
        {
          action: 'registration.auto_approved',
          entityType: 'registration',
          entityId: registrationId,
          after: { setting: 'review.auto_approve_clean' },
          actorId: null,
        },
        tx,
      );
    }
  }

  return { duplicates: Number(found?.n ?? 0), approved, flags };
}
