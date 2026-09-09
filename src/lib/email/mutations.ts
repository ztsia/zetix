import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { writeAuditLog } from '@/lib/audit';
import { escapeMergeValues, renderTemplate, type MergeContext } from './render';

/**
 * Everything a human does to the outbox between queueing and sending
 * (spec/email.md §11.5, §11.6).
 *
 * The dispatcher is deliberately dumb — it sends `subject` and `body_md`
 * verbatim — so every judgement lives here, in front of it.
 */

/** §11.5: confirm moves the reviewed batch on. Only then can the dispatcher touch it. */
export async function confirmBatch(opts: {
  segmentId: number;
  templateKey: string;
  actorId: string | null;
}): Promise<{ queued: number }> {
  try {
    return await getDb().transaction(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        update email_outbox o
           set status = 'QUEUED', updated_at = now()
          from registrations r
         where r.id = o.registration_id
           and r.segment_id = ${opts.segmentId}
           and o.template_key = ${opts.templateKey}
           and o.status = 'DRAFT'
        returning o.id
      `);

      await writeAuditLog(
        {
          action: 'email.batch_confirmed',
          entityType: 'show_segment',
          entityId: opts.segmentId,
          after: { templateKey: opts.templateKey, queued: rows.length },
          actorId: opts.actorId,
        },
        tx,
      );

      return { queued: rows.length };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * §11.5: overwrite one message, "for the one recipient who needs a note about
 * wheelchair access".
 *
 * Only a `DRAFT` row. Once a batch is `QUEUED` the dispatcher owns it, and
 * editing underneath it would mean a message going out that differs from the
 * one confirmed.
 */
export async function editMessage(opts: {
  outboxId: number;
  subject: string;
  bodyMd: string;
  actorId: string | null;
}): Promise<{ updated: boolean }> {
  try {
    return await getDb().transaction(async (tx) => {
      const before = await tx.execute<{ subject: string; body_md: string }>(sql`
        select subject, body_md from email_outbox where id = ${opts.outboxId} and status = 'DRAFT'
      `);
      if (before.length === 0) return { updated: false };

      await tx.execute(sql`
        update email_outbox
           set subject = ${opts.subject}, body_md = ${opts.bodyMd}, updated_at = now()
         where id = ${opts.outboxId} and status = 'DRAFT'
      `);

      await writeAuditLog(
        {
          action: 'email.message_edited',
          entityType: 'email_outbox',
          entityId: opts.outboxId,
          before: before[0],
          after: { subject: opts.subject, body_md: opts.bodyMd },
          actorId: opts.actorId,
        },
        tx,
      );

      return { updated: true };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * §11.5's normal path: fix the wording once and watch all eighty messages
 * update — **except the ones a human has already hand-edited**, which "survive
 * a subsequent template re-render".
 *
 * **How an edit is detected, with no column to store it in.** Each `DRAFT` row
 * keeps the merge `context` it was rendered from, so re-rendering the *old*
 * template against that context reproduces exactly what the row held when it
 * was created. A row still equal to that was never touched and is safe to
 * replace; a row that differs was edited and is left alone. The old template is
 * read inside the same transaction that overwrites it, which is the only moment
 * both versions exist.
 *
 * The one imprecision, stated rather than hidden: a hand-edit that happens to
 * reproduce the original rendering character for character is indistinguishable
 * from no edit, and will be re-rendered. It is not worth a column.
 */
export async function editTemplateAndRerender(opts: {
  templateKey: string;
  subject: string;
  bodyMd: string;
  actorId: string | null;
}): Promise<{ rerendered: number; preserved: number }> {
  try {
    return await getDb().transaction(async (tx) => {
      const old = await tx.execute<{ subject: string; body_md: string }>(sql`
        select subject, body_md from email_templates where key = ${opts.templateKey} for update
      `);
      if (old.length === 0) return { rerendered: 0, preserved: 0 };

      const drafts = await tx.execute<{
        id: string;
        subject: string;
        body_md: string;
        context: MergeContext | null;
      }>(sql`
        select id, subject, body_md, context
          from email_outbox
         where template_key = ${opts.templateKey} and status = 'DRAFT'
      `);

      let rerendered = 0;
      let preserved = 0;

      for (const draft of drafts) {
        const context = escapeMergeValues(draft.context ?? {});
        const asItWas = {
          subject: renderTemplate(old[0].subject, context).text,
          bodyMd: renderTemplate(old[0].body_md, context).text,
        };
        const untouched = draft.subject === asItWas.subject && draft.body_md === asItWas.bodyMd;
        if (!untouched) {
          preserved += 1;
          continue;
        }

        await tx.execute(sql`
          update email_outbox
             set subject = ${renderTemplate(opts.subject, context).text},
                 body_md = ${renderTemplate(opts.bodyMd, context).text},
                 updated_at = now()
           where id = ${Number(draft.id)}
        `);
        rerendered += 1;
      }

      await tx.execute(sql`
        update email_templates
           set subject = ${opts.subject}, body_md = ${opts.bodyMd},
               updated_at = now(), updated_by = ${opts.actorId}
         where key = ${opts.templateKey}
      `);

      await writeAuditLog(
        {
          action: 'email.template_edited',
          entityType: 'email_template',
          entityId: opts.templateKey,
          before: old[0],
          after: { subject: opts.subject, body_md: opts.bodyMd, rerendered, preserved },
          actorId: opts.actorId,
        },
        tx,
      );

      return { rerendered, preserved };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

export class ReasonRequiredError extends Error {
  constructor() {
    super('Marking a ticket delivered by hand needs a short reason — it is recorded in the audit log.');
    this.name = 'ReasonRequiredError';
  }
}

/**
 * §11.6 "Mark as delivered". **It sends nothing.**
 *
 * Delivery happens outside the system — a PDF forwarded from someone's own
 * mailbox, a printout handed over at a rehearsal. Without this those attendees
 * keep `ticket_sent_at = null` and reappear in the pending bucket of every
 * future blast for ever, which is what makes the blast screen's numbers stop
 * meaning anything.
 */
export async function markDelivered(opts: {
  attendeeIds: number[];
  reason: string;
  actorId: string | null;
}): Promise<{ marked: number }> {
  if (opts.reason.trim().length === 0) throw new ReasonRequiredError();
  if (opts.attendeeIds.length === 0) return { marked: 0 };

  try {
    return await getDb().transaction(async (tx) => {
      const ids = sql.join(opts.attendeeIds.map((id) => sql`${id}`), sql`, `);
      const rows = await tx.execute<{ id: string }>(sql`
        update attendees
           set ticket_sent_at = now(), ticket_sent_source = 'MANUAL', updated_at = now()
         where id in (${ids})
           and deleted_at is null
           and ticket_sent_at is null
        returning id
      `);

      await writeAuditLog(
        {
          action: 'attendee.marked_delivered',
          entityType: 'attendee',
          entityId: null,
          after: { attendeeIds: rows.map((r) => Number(r.id)), source: 'MANUAL' },
          reason: opts.reason,
          actorId: opts.actorId,
        },
        tx,
      );

      return { marked: rows.length };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * §11.4's explicit resend — the exact inverse of {@link markDelivered}.
 *
 * Clears `ticket_sent_at` for exactly the rows named, so the next blast selects
 * their registration again. Used when someone deletes their email. **Never the
 * default path**, and the caller is responsible for the typed confirmation the
 * spec requires before this touches a whole segment.
 */
export async function clearDeliveryForResend(opts: {
  attendeeIds: number[];
  reason: string;
  actorId: string | null;
}): Promise<{ cleared: number }> {
  if (opts.attendeeIds.length === 0) return { cleared: 0 };

  try {
    return await getDb().transaction(async (tx) => {
      const ids = sql.join(opts.attendeeIds.map((id) => sql`${id}`), sql`, `);
      const rows = await tx.execute<{ id: string }>(sql`
        update attendees
           set ticket_sent_at = null, ticket_sent_source = null, updated_at = now()
         where id in (${ids}) and deleted_at is null
        returning id
      `);

      await writeAuditLog(
        {
          action: 'attendee.ticket_resend_requested',
          entityType: 'attendee',
          entityId: null,
          after: { attendeeIds: rows.map((r) => Number(r.id)) },
          reason: opts.reason,
          actorId: opts.actorId,
        },
        tx,
      );

      return { cleared: rows.length };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/** Withdraws a reviewed batch that should not go out after all. */
export async function discardDrafts(opts: {
  segmentId: number;
  templateKey: string;
  actorId: string | null;
}): Promise<{ discarded: number }> {
  try {
    return await getDb().transaction(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        update email_outbox o
           set status = 'CANCELLED', updated_at = now()
          from registrations r
         where r.id = o.registration_id
           and r.segment_id = ${opts.segmentId}
           and o.template_key = ${opts.templateKey}
           and o.status = 'DRAFT'
        returning o.id
      `);

      await writeAuditLog(
        {
          action: 'email.batch_discarded',
          entityType: 'show_segment',
          entityId: opts.segmentId,
          after: { templateKey: opts.templateKey, discarded: rows.length },
          actorId: opts.actorId,
        },
        tx,
      );

      return { discarded: rows.length };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}
