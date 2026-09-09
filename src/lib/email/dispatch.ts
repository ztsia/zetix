import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requireSetting } from '@/db/settings';
import { buildPartyAttachments, encodedSizeBytes, UnissuedTicketError } from './attachments';
import { createConfiguredTransport } from './config';
import { markdownToHtml, markdownToPlainText } from './render';
import { carriesTickets } from './templates';
import type { MailTransport } from './transport';

/**
 * The dispatcher (spec/email.md §11.2).
 *
 * No always-on worker: the UI calls `/api/outbox/dispatch` repeatedly and each
 * call claims a batch, sends it, and reports progress. **Progress is committed
 * per message**, which is what makes the whole thing survive a function
 * timeout — a run that dies halfway has still delivered, and stamped, every
 * message it got through.
 *
 * `DRAFT` rows are never touched. Only a human moves a row out of `DRAFT`
 * (§11.2, decision 23).
 */

export type DispatchResult = {
  sent: number;
  failed: number;
  /** `QUEUED` rows still waiting, so the UI knows whether to call again. */
  remaining: number;
  dailyCapReached: boolean;
  /** Render warnings, surfaced rather than swallowed (module `D`). */
  warnings: string[];
};

type ClaimedRow = {
  id: number;
  registrationId: number;
  toEmail: string;
  toName: string | null;
  subject: string;
  bodyMd: string;
  attempts: number;
  templateKey: string;
};

/**
 * How many messages have already gone out today, in `concert.timezone`.
 *
 * §11.1: the outbox enforces `email.max_per_day` regardless of the provider, so
 * exceeding a cap defers the remainder to the next day rather than failing. The
 * day boundary is the venue's, not UTC's and not the viewer's
 * (spec/domain.md §6.1).
 */
async function sentToday(timezone: string): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n
      from email_outbox
     where status = 'SENT'
       and sent_at >= date_trunc('day', now() at time zone ${timezone}) at time zone ${timezone}
  `);
  return rows[0]?.n ?? 0;
}

async function concertTimezone(): Promise<string> {
  const rows = await getDb().execute<{ timezone: string }>(sql`
    select timezone from concerts where deleted_at is null order by id limit 1
  `);
  return rows[0]?.timezone ?? 'UTC';
}

/**
 * Claims up to `limit` queued rows and marks them `SENDING`, in one statement.
 *
 * **`for update skip locked`** is what lets a cron firing while the admin is
 * clicking Send take a *different* batch instead of blocking on the same rows
 * or, worse, sending them twice.
 */
async function claimBatch(limit: number): Promise<ClaimedRow[]> {
  const rows = await getDb().execute<{
    id: string;
    registration_id: string;
    to_email: string;
    to_name: string | null;
    subject: string;
    body_md: string;
    attempts: number;
    template_key: string;
  }>(sql`
    with claimed as (
      select id
        from email_outbox
       where status = 'QUEUED'
         and (scheduled_for is null or scheduled_for <= now())
       order by created_at, id
       for update skip locked
       limit ${limit}
    )
    update email_outbox o
       set status = 'SENDING', updated_at = now()
      from claimed
     where o.id = claimed.id
    returning o.id, o.registration_id, o.to_email, o.to_name, o.subject, o.body_md,
              o.attempts, o.template_key
  `);

  return rows.map((r) => ({
    id: Number(r.id),
    registrationId: Number(r.registration_id),
    toEmail: r.to_email,
    toName: r.to_name,
    subject: r.subject,
    bodyMd: r.body_md,
    attempts: r.attempts,
    templateKey: r.template_key,
  }));
}

/**
 * Marks one message sent **and stamps every attendee whose PDF it carried, in
 * the same transaction** (§11.4 mechanism 4).
 *
 * One transaction is the whole point: "partial delivery does not exist —
 * either the message sent and all its tickets are delivered, or it failed and
 * none are." A stamp written on a separate connection could survive a rollback
 * of the row that says the message went, and those attendees would then be
 * excluded from every future blast having never received anything.
 */
async function markSent(rowId: number, attendeeIds: number[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      update email_outbox
         set status = 'SENT', sent_at = now(), last_error = null, updated_at = now()
       where id = ${rowId}
    `);
    if (attendeeIds.length > 0) {
      /**
       * `in ($1, $2, $3)` built with `sql.join`, not `= any(${'${array}'})`.
       *
       * Drizzle expands a JS array in a template into *separate* parameters, so
       * `any(${'${ids}'}::bigint[])` becomes `any(($1, $2, $3)::bigint[])` — a row
       * constructor where an array belongs, and the statement fails. That is
       * module `C`'s Blocker in a different costume, and the reason it was
       * caught here is that the test stamps a party of three: a party of one
       * would have exercised neither shape.
       */
      const ids = sql.join(attendeeIds.map((id) => sql`${id}`), sql`, `);
      await tx.execute(sql`
        update attendees
           set ticket_sent_at = now(), ticket_sent_source = 'EMAIL', updated_at = now()
         where id in (${ids})
      `);
    }
  });
}

/**
 * A failed message goes back in the queue until `email.max_attempts`, then
 * surfaces in admin with `last_error` (§11.2).
 *
 * **Nothing is stamped on this path.** An attendee whose message failed keeps
 * `ticket_sent_at = null` and is picked up by the next blast, which is the
 * behaviour that makes the pending count on the blast screen a real number.
 */
async function markFailed(row: ClaimedRow, maxAttempts: number, error: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = attempts >= maxAttempts;

  await getDb().execute(sql`
    update email_outbox
       set status = ${exhausted ? 'FAILED' : 'QUEUED'},
           attempts = ${attempts},
           last_error = ${message.slice(0, 2000)},
           scheduled_for = ${exhausted ? null : sql`now() + (interval '1 minute' * ${attempts})`},
           updated_at = now()
     where id = ${row.id}
  `);
}

async function remainingQueued(): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n from email_outbox where status = 'QUEUED'
  `);
  return rows[0]?.n ?? 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type DispatchOptions = {
  /** Injected by tests; production builds one from the environment. */
  transport?: MailTransport;
};

export async function dispatchBatch(options: DispatchOptions = {}): Promise<DispatchResult> {
  /**
   * Every one of these is an operational value resolved through the cascade —
   * none has a default in code (`CLAUDE.md`, spec/domain.md §6). They are
   * system-level, so they resolve with no segment context.
   */
  const [maxPerDispatch, maxPerDay, delayMs, maxAttempts, mergeAbove, maxAttachmentMb] =
    await Promise.all([
      requireSetting<number>('email.max_per_dispatch'),
      requireSetting<number>('email.max_per_day'),
      requireSetting<number>('email.inter_message_delay_ms'),
      requireSetting<number>('email.max_attempts'),
      requireSetting<number>('email.merge_attachments_above'),
      requireSetting<number>('email.max_attachment_mb'),
    ]);

  const timezone = await concertTimezone();
  const alreadySentToday = await sentToday(timezone);
  const budget = Math.max(0, maxPerDay - alreadySentToday);
  if (budget === 0) {
    return {
      sent: 0,
      failed: 0,
      remaining: await remainingQueued(),
      dailyCapReached: true,
      warnings: [],
    };
  }

  const batch = await claimBatch(Math.min(maxPerDispatch, budget));
  if (batch.length === 0) {
    return { sent: 0, failed: 0, remaining: 0, dailyCapReached: false, warnings: [] };
  }

  /**
   * One transport for the batch: §11.1's "open, send the batch, close". The
   * pool inside it reuses a single connection, so the batch costs one TLS
   * handshake rather than one per message.
   */
  const transport = options.transport ?? createConfiguredTransport();
  const warnings: string[] = [];
  let sent = 0;
  let failed = 0;

  try {
    for (const [index, row] of batch.entries()) {
      try {
        /**
         * **Only a ticket-bearing template renders PDFs** (§11.3). A
         * cancellation or a decline attaches nothing, and — the half that
         * matters — stamps nothing, because `ticket_sent_at` means the ticket
         * was delivered. Stamping it from a decline would quietly remove that
         * seat from every future blast.
         */
        const party = carriesTickets(row.templateKey)
          ? await buildPartyAttachments({ registrationId: row.registrationId, mergeAbove })
          : { attendeeIds: [], attachments: [], truncated: [], skipped: [] };

        const encoded = encodedSizeBytes(party.attachments);
        if (encoded > maxAttachmentMb * 1024 * 1024) {
          throw new Error(
            `Attachments are ${(encoded / 1024 / 1024).toFixed(1)}MB once encoded, over the ` +
              `${maxAttachmentMb}MB limit. Base64 inflates by about a third, and Gmail's own ` +
              'ceiling of 25MB applies to the encoded message.',
          );
        }

        for (const warning of party.truncated) warnings.push(`truncated: ${warning}`);
        for (const warning of party.skipped) warnings.push(`not drawn: ${warning}`);

        /**
         * `subject` and `body_md` go out verbatim — what a human reviewed is
         * what is sent (§11.5). Only the HTML and plain-text renderings are
         * derived, and both come from the stored Markdown.
         */
        const result = await transport.send({
          to: row.toEmail,
          toName: row.toName,
          subject: row.subject,
          html: markdownToHtml(row.bodyMd),
          text: markdownToPlainText(row.bodyMd),
          attachments: party.attachments,
        });

        /**
         * A server that accepted nothing has not delivered, whatever else it
         * said. Treating that as success would stamp `ticket_sent_at` on mail
         * nobody received, and those seats would never appear in a blast again.
         */
        if (result.accepted.length === 0) {
          throw new Error(result.response ?? 'The server accepted no recipients.');
        }

        await markSent(row.id, party.attendeeIds);
        sent += 1;
      } catch (error) {
        if (error instanceof UnissuedTicketError) {
          warnings.push(`registration ${row.registrationId}: ${error.message}`);
        }
        await markFailed(row, maxAttempts, error);
        failed += 1;
      }

      if (index < batch.length - 1 && delayMs > 0) await sleep(delayMs);
    }
  } finally {
    await transport.close();
  }

  return { sent, failed, remaining: await remainingQueued(), dailyCapReached: false, warnings };
}
