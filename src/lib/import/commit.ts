import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { claimSeats, type ClaimOutcome, type Executor } from '@/db/allocation';
import { liveParties, type ImportPlan, type PlannedParty } from './plan';
import { loadExistingParties, type SegmentTarget } from './context';

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
      // Without this the batch record cannot say which parties it wrote (§9.1).
      skipped: p.skipped,
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
      // Every party the run would not write, not only the blocked ones (§9.2).
      skipped: input.plan.parties.length - liveParties(input.plan.parties).length,
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

  /**
   * **Any blocking finding stops the whole run** (§9.4, §9.6).
   *
   * Not just a file-level one. Committing "the rest of it" is the silent
   * under-issue decision 33 set out to remove: an unmatched player is a party
   * that quietly does not get tickets, and there is no rollback to notice it
   * with afterwards (decision 26). The admin resolves it in the sheet — remove
   * the rows, or fix the mapping — and dry runs again.
   */
  if (plan.counts.blocking > 0) {
    const first = plan.findings.find((f) => f.level === 'BLOCKING');
    throw new Error(
      `This import has ${plan.counts.blocking} blocking ${plan.counts.blocking === 1 ? 'issue' : 'issues'} and cannot be committed. Resolve them and dry run again. First: ${first?.message ?? ''}`,
    );
  }

  // The planner's own filter, not a second spelling of it: a party it counted
  // and predicted against but the commit wrote anyway (or the reverse) is the
  // one way the dry run and the commit can disagree (decision 26).
  const raced = liveParties(plan.parties);

  try {
    return await getDb().transaction(async (tx) => {
      /**
       * Take the show lock before deciding anything, then re-read what is
       * already imported through it (§9.2).
       *
       * The planner read `existingParties` outside this transaction, so two
       * commits of the same file started at once would both see nothing and
       * both write — the duplication this whole change exists to prevent,
       * re-entered through a door the planner cannot see. This is the same row
       * `claim_seats()` locks (allocation.md §7.8), so the second commit waits
       * for the first and then sees its registrations.
       *
       * It can only ever *remove* parties from the run, never add one, so the
       * dry run still cannot under-report what a commit writes (decision 26).
       */
      await tx.execute(sql`select id from shows where id = ${target.showId} for update`);
      const committedSince = await loadExistingParties(target.segmentId, tx);

      const live = raced.filter((p) => p.dedupKey == null || !committedSince.has(p.dedupKey));

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
        skipped: plan.parties.length - live.length,
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
        skippedParties: plan.parties.length - live.length,
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
