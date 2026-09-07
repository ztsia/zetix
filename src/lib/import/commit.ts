import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { claimSeats, type ClaimOutcome, type Executor } from '@/db/allocation';
import type { ImportPlan, PlannedParty } from './plan';
import type { SegmentTarget } from './context';

/**
 * The commit (spec/import.md §9.1, §9.4).
 *
 * **One transaction, and after it this database is the source of truth** — there
 * is no rollback and no re-sync (decision 26). Every seat goes through
 * `claim_seats()`, including these: a path that inserted `attendees` directly
 * would make the §7.2 counters meaningless, and the database refuses it outright
 * so such a path fails loudly rather than quietly.
 */

export type ImportOutcome = {
  batchId: number;
  createdRegistrations: number;
  createdAttendees: number;
  skippedParties: number;
  granted: { base: number; extra: number; pending: number; waitlisted: number };
};

/**
 * The registration's own status, derived from what the engine did with its
 * seats.
 *
 * A registration is not a seat, so it has no status of its own to grant — it
 * reflects its party. Confirmed if any seat confirmed; otherwise pending if any
 * seat is held for review; otherwise waitlisted. A party whose extras are all
 * held under `REVIEW` is `PENDING_REVIEW`, which is what the §7.5 review screen
 * filters on.
 */
export function registrationStatus(
  outcome: ClaimOutcome,
): 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' {
  if (outcome.granted_base + outcome.granted_extra + outcome.granted_other > 0) return 'CONFIRMED';
  if (outcome.pending > 0) return 'PENDING_REVIEW';
  return 'WAITLIST';
}

/**
 * Writes an `import_batches` row. Both a dry run and a commit produce one, which
 * is why `import_status` has two values: the report is how a run stays
 * explainable afterwards, and a dry run is the only record of what an admin was
 * shown before they decided.
 */
async function writeBatch(
  tx: Executor,
  input: {
    target: SegmentTarget;
    filename: string;
    mappingProfileId: number | null;
    uploadedBy: string | null;
    status: 'DRY_RUN' | 'COMMITTED';
    plan: ImportPlan;
    created: number;
    skipped: number;
  },
): Promise<number> {
  const report = {
    counts: input.plan.counts,
    largestParty: input.plan.largestParty,
    findings: input.plan.findings,
    parties: input.plan.parties.map((p) => ({
      key: p.key,
      rows: p.rowNumbers,
      contactName: p.contactName,
      contactEmail: p.contactEmail,
      requestedAt: p.requestedAt.toISOString(),
      playerId: p.playerId,
      seats: p.seats.length,
      blocked: p.blocked,
    })),
  };

  const rows = await tx.execute<{ id: string }>(sql`
    insert into import_batches (
      show_id, segment_id, filename, mapping_profile_id, uploaded_by,
      row_count, created_count, skipped_count, error_count, report, status
    ) values (
      ${input.target.showId}, ${input.target.segmentId}, ${input.filename},
      ${input.mappingProfileId}, ${input.uploadedBy ?? null},
      ${input.plan.counts.rows}, ${input.created}, ${input.skipped},
      ${input.plan.counts.blocking},
      ${JSON.stringify(report)}::text::jsonb,
      ${input.status}::import_status
    )
    returning id
  `);
  return Number(rows[0].id);
}

/** Records a dry run without writing a single registration. */
export async function recordDryRun(input: {
  target: SegmentTarget;
  filename: string;
  mappingProfileId?: number | null;
  uploadedBy?: string | null;
  plan: ImportPlan;
}): Promise<number> {
  try {
    return await writeBatch(getDb(), {
      target: input.target,
      filename: input.filename,
      mappingProfileId: input.mappingProfileId ?? null,
      uploadedBy: input.uploadedBy ?? null,
      status: 'DRY_RUN',
      plan: input.plan,
      created: 0,
      skipped: input.plan.parties.filter((p) => p.blocked).length,
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

export async function commitImport(input: {
  target: SegmentTarget;
  filename: string;
  mappingProfileId?: number | null;
  uploadedBy?: string | null;
  plan: ImportPlan;
}): Promise<ImportOutcome> {
  const { plan, target } = input;

  // A blocking finding stops the whole run, not just its own party. §9.4 makes
  // capacity overflow blocking at file level, and committing "the rest of it"
  // would spend seats in an order nobody previewed.
  if (plan.counts.blocking > 0 && plan.findings.some((f) => f.rowNumber === undefined)) {
    throw new Error(
      'This import has a blocking finding that applies to the whole file. Resolve it and run the dry run again.',
    );
  }

  const live = plan.parties.filter((p) => !p.blocked);
  const skipped = plan.parties.length - live.length;

  try {
    return await getDb().transaction(async (tx) => {
      let createdAttendees = 0;
      const createdIds: number[] = [];
      const totals = { base: 0, extra: 0, pending: 0, waitlisted: 0 };

      // In requested_at order, because that is the order the pool is spent in
      // (§7.4) and the order the planner promoted base surplus in. Committing
      // in file order would grant a later request a seat an earlier one is owed.
      for (const party of live) {
        const registrationId = await insertRegistration(tx, target, party);
        createdIds.push(registrationId);
        // On the transaction, not the pool. `claimSeats` defaults to the
        // pooled client, and with `max: 1` that would deadlock against the
        // connection this transaction is holding.
        const outcome = await claimSeats(
          target.segmentId,
          registrationId,
          party.seats.map((s) => ({
            fullName: s.fullName,
            email: s.email,
            allocationType: s.allocationType,
          })),
          { executor: tx },
        );

        await tx.execute(sql`
          update registrations
             set status = ${registrationStatus(outcome)}::booking_status
           where id = ${registrationId}
        `);

        createdAttendees += party.seats.length;
        totals.base += outcome.granted_base;
        totals.extra += outcome.granted_extra;
        totals.pending += outcome.pending;
        totals.waitlisted += outcome.waitlisted;
      }

      const batchId = await writeBatch(tx, {
        target,
        filename: input.filename,
        mappingProfileId: input.mappingProfileId ?? null,
        uploadedBy: input.uploadedBy ?? null,
        status: 'COMMITTED',
        plan,
        created: live.length,
        skipped,
      });

      // Stamped by id, never by a predicate over the segment. An earlier run
      // that left a null `import_batch_id` for any reason would be silently
      // adopted by this batch, and the report of a committed run is the only
      // account of what it did (§9.1).
      if (createdIds.length > 0) {
        await tx.execute(sql`
          update registrations
             set import_batch_id = ${batchId}
           where id in (${sql.join(
             createdIds.map((id) => sql`${id}`),
             sql`, `,
           )})
        `);
      }

      return {
        batchId,
        createdRegistrations: live.length,
        createdAttendees,
        skippedParties: skipped,
        granted: totals,
      };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * Inserts the registration a party's seats hang off.
 *
 * `requested_at` is the **form response timestamp**, never now: it is the FCFS
 * ordering key, and an import run a week later must preserve the order people
 * actually asked in (§7.4, §9.3).
 *
 * The initial status is `WAITLIST` and is corrected from the engine's outcome a
 * moment later, inside the same transaction. `claim_seats()` refuses a
 * `CANCELLED` registration, so the placeholder has to be one of the other three;
 * `WAITLIST` is the one that is wrong in the safe direction if this transaction
 * were ever to be split — a party holding nothing rather than a party recorded
 * as confirmed with no seats.
 */
async function insertRegistration(
  tx: Executor,
  target: SegmentTarget,
  party: PlannedParty,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into registrations (
      show_id, segment_id, player_id, source, contact_name, contact_email,
      status, requested_at
    ) values (
      ${target.showId}, ${target.segmentId}, ${party.playerId},
      'IMPORT', ${party.contactName}, ${party.contactEmail},
      'WAITLIST', ${party.requestedAt.toISOString()}::timestamptz
    )
    returning id
  `);
  return Number(rows[0].id);
}
