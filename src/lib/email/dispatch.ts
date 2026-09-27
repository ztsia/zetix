import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requireSetting } from '@/db/settings';
import { buildPartyAttachments, encodedSizeBytes, UnissuedTicketError } from './attachments';
import { createConfiguredTransport } from './config';
import { markdownToEmailHtml, markdownToPlainText } from './render';
import { carriesTickets, TICKET_FOOTER } from './templates';
import type { MailTransport } from '@/lib/mail/transport';

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

/**
 * The ceiling on how long one dispatch can possibly run, in seconds.
 *
 * It mirrors `export const maxDuration = 60` on the route — Vercel Hobby's
 * limit, which §11.1 sizes `email.max_per_dispatch` against. Next requires that
 * export to be a literal, so it cannot be computed from here;
 * `tests/email/dispatch-route.test.ts` asserts the two agree instead, because a
 * reclaim window shorter than the function's own runtime would take rows back
 * from a dispatch that is still using them.
 *
 * Not an operational value: it describes the runtime rather than the event, and
 * nothing in `context.md` supplies it (spec/domain.md §6).
 */
export const MAX_DISPATCH_SECONDS = 60;

/**
 * How long the send loop may keep *starting* messages, in seconds.
 *
 * **The dispatcher has to stop before the platform stops it.** Sending is
 * serial — one message at a time, and one PDF at a time inside each — so a
 * batch sized for messages that turn out to cost more than expected simply runs
 * past 60s and Vercel returns a 504. Everything already sent stays sent, but the
 * rest of the claimed batch is left `SENDING`, invisible to `claimBatch()`, and
 * not reclaimed for ten minutes: pressing Send again appears to do nothing, and
 * then times out again on the same work.
 *
 * A real blast found this at 244 messages, going out roughly ten at a time —
 * about six seconds each against the one to two §11.1 assumes, which is the
 * difference between a batch of 25 fitting and not fitting.
 *
 * The quarter left over is for the work after the loop: returning the unstarted
 * rows to the queue, closing the transport, and the two counting queries behind
 * the result. That has to finish *inside* the same invocation, or the rows it
 * was releasing stay stranded anyway.
 */
const SEND_WINDOW_MS = MAX_DISPATCH_SECONDS * 1000 * 0.75;

/** Safety factor on {@link MAX_DISPATCH_SECONDS} before a row is called stranded. */
const RECLAIM_FACTOR = 10;

/** How long a row must sit in `SENDING` before {@link reclaimStranded} takes it back. */
const RECLAIM_AFTER_SECONDS = MAX_DISPATCH_SECONDS * RECLAIM_FACTOR;

export type DispatchResult = {
  sent: number;
  failed: number;
  /**
   * Rows claimed by this call but handed back unsent, because the dispatch
   * window ran out. They are `QUEUED` again by the time this is returned, and
   * are counted in {@link DispatchResult.remaining}.
   */
  deferred: number;
  /** `QUEUED` rows still waiting, so the UI knows whether to call again. */
  remaining: number;
  dailyCapReached: boolean;
  /** Render warnings, surfaced rather than swallowed (module `D`). */
  warnings: string[];
  /** Rows recovered from a dispatch that died mid-batch. See {@link reclaimStranded}. */
  reclaimed: number;
  /**
   * The queue as it stands once this call is done, for the shell's banner
   * (§11.2.1). Reported separately from {@link DispatchResult.remaining}, which
   * drives the loop and counts every `QUEUED` row whether it is due or not:
   * the loop wants to know whether to call again, the banner wants to know what
   * it may honestly offer to do.
   */
  backlog: OutboxBacklog;
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
  context: Record<string, string> | null;
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
    context: Record<string, string> | null;
  }>(sql`
    with claimed as (
      select id
        from email_outbox
       where status = 'QUEUED'
         and (scheduled_for is null or scheduled_for <= now())
         -- A message in the Trash is not sent (spec/v3.md §23.6). Deleting one
         -- cancels it first (Messages › Delete), so this is the second door,
         -- for a row that reached the Trash some other way.
         and deleted_at is null
       order by created_at, id
       for update skip locked
       limit ${limit}
    )
    update email_outbox o
       set status = 'SENDING', updated_at = now()
      from claimed
     where o.id = claimed.id
       -- Re-checked rather than trusted from the CTE. FOR UPDATE SKIP LOCKED
       -- is what makes two dispatchers take different rows; if that clause were
       -- ever weakened, this is what still stops one row being claimed twice,
       -- and a double claim is a double send.
       and o.status = 'QUEUED'
    returning o.id, o.registration_id, o.to_email, o.to_name, o.subject, o.body_md,
              o.attempts, o.template_key, o.context
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
    context: r.context,
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
/**
 * An address that cannot be delivered as written, and never will be.
 *
 * Retrying it is not a recovery, it is three more attempts at the same wrong
 * thing, so {@link markFailed} takes it straight to `FAILED` where an admin can
 * see it and fix the address.
 */
export class UndeliverableAddressError extends Error {
  constructor(readonly address: string) {
    super(
      `"${address}" is not a deliverable address: an address cannot contain a space. ` +
        'Fix it on the registration and resend — nothing was sent.',
    );
    this.name = 'UndeliverableAddressError';
  }
}

/**
 * The shape an address must have before this will hand it to a mailer.
 *
 * **The point is the whitespace.** `may _zxample@yahoo.com` was stored, composed
 * into a `To:` header, and delivered — to `_zxample@yahoo.com`, because an
 * address parser splits on the space and keeps the last token, and that token
 * was a real address belonging to somebody else. The mailer did nothing wrong;
 * it was asked to send to something that means two different things depending on
 * who reads it, and the only safe answer is to refuse.
 */
const DELIVERABLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function markFailed(row: ClaimedRow, maxAttempts: number, error: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = attempts >= maxAttempts || error instanceof UndeliverableAddressError;

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

/**
 * Returns rows this call claimed but never started to the queue.
 *
 * The deliberate counterpart to {@link reclaimStranded}: that one cleans up
 * after a dispatch that died, this one after a dispatch that stopped on
 * purpose. Only ids the caller holds, and only rows still `SENDING` — a row
 * that reached `SENT` between the decision and this statement must not be
 * dragged back into the queue and sent twice.
 */
async function releaseClaimed(ids: number[]): Promise<void> {
  // Placeholders, not an interpolated list: these ids came from a query rather
  // than from a user, and building SQL by string concatenation is a habit that
  // is wrong the first time it meets something that did.
  const list = sql.join(
    ids.map((id) => sql`${id}::bigint`),
    sql`, `,
  );
  await getDb().execute(sql`
    update email_outbox
       set status = 'QUEUED', updated_at = now()
     where status = 'SENDING'
       and id in (${list})
  `);
}

/**
 * Returns rows stranded in `SENDING` to the queue.
 *
 * **Without this a dispatch that dies mid-batch loses its rows for ever.**
 * `claimBatch()` flips the whole batch to `SENDING` up front and then sends
 * serially, so a function timeout, a deploy, or a crash leaves every unsent row
 * of that batch in a state nothing writes again. The partial unique index
 * covers `SENDING`, so `queueBlast()` then refuses to re-prepare those
 * registrations while `blastSplit()` still counts them pending — §11.4's
 * "nobody must be silently skipped", broken with no way out from the UI.
 *
 * A row is only stranded once it has been `SENDING` for longer than a dispatch
 * can possibly last, so this can never take work from a run still using it.
 *
 * It does **not** stamp or unstamp anything: `ticket_sent_at` is written only
 * in the same transaction that marks a row `SENT`, so a row that dies before
 * that point delivered nothing and is safe to send again.
 */
async function reclaimStranded(): Promise<number> {
  const rows = await getDb().execute<{ id: string }>(sql`
    update email_outbox
       set status = 'QUEUED', updated_at = now()
     where status = 'SENDING'
       and updated_at < now() - (interval '1 second' * ${RECLAIM_AFTER_SECONDS})
    returning id
  `);
  return rows.length;
}

async function remainingQueued(): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n from email_outbox where status = 'QUEUED' and deleted_at is null
  `);
  return rows[0]?.n ?? 0;
}

export type OutboxBacklog = {
  /**
   * Messages a Resume would send **right now**: `QUEUED` rows that are due,
   * plus `SENDING` rows old enough that the next dispatch call reclaims them
   * (§11.2's recovery path) before it claims anything.
   *
   * Due-ness is not a detail. `claimBatch()` skips a row whose `scheduled_for`
   * is in the future, so counting one here would offer a Resume that cannot
   * send it — and a control that does nothing reads as a broken one.
   */
  resumable: number;
  /**
   * Rows waiting out the retry backoff `markFailed()` gave them. Unfinished
   * work, so the banner keeps reporting them, but the dispatcher will not take
   * them until they are due and no button can hurry that along.
   */
  retrying: number;
  /**
   * `SENDING` rows too recent to reclaim — either a dispatch is using them, or
   * one just died and the reclaim window has not elapsed. Resume cannot help
   * these yet, so the banner must not offer it for them.
   */
  inFlight: number;
  /**
   * Rows that exhausted `email.max_attempts`. Nothing retries them and Resume
   * cannot reach them, but they are tickets nobody received: going silent over
   * them is the failure §11.2.1 exists to prevent. They clear by an explicit
   * resend or by §11.6's mark-as-delivered, never on their own.
   */
  failed: number;
};

/**
 * What the queue banner renders (spec/email.md §11.2.1).
 *
 * **The banner's source of truth is `email_outbox`, not client state**, which
 * is what lets "is there an unfinished blast?" survive a route change, a
 * reload, a closed tab and a dead laptop.
 *
 * `SENDING` is counted as well as `QUEUED` because a dispatch that dies
 * mid-batch leaves up to `email.max_per_dispatch` rows there, invisible to a
 * `QUEUED`-only count. Reporting only `QUEUED` would clear the banner while
 * those messages were still undelivered — the exact silence §11.2.1 exists to
 * end. The split by reclaim age is what keeps Resume honest: it is offered only
 * for rows a dispatch could actually pick up.
 */
export async function outboxBacklog(concertId?: number): Promise<OutboxBacklog> {
  /**
   * **For the concert in view** (spec/v3.md §24.5, `local.md` §14.1). The
   * banner once said "34 messages ran out of attempts" on a concert that had
   * none: the count was real, the concert it was shown against was not. A
   * message belongs to a concert through its party's show, or its player.
   * Without a concert the count is table-wide, which is what the dispatcher
   * itself works through.
   */
  const scope =
    concertId === undefined
      ? sql``
      : sql`and exists (
          select 1 from registrations r join shows s on s.id = r.show_id
           where r.id = o.registration_id and s.concert_id = ${concertId}
          union all
          select 1 from players p where p.id = o.player_id and p.concert_id = ${concertId})`;
  const rows = await getDb().execute<{
    resumable: number;
    retrying: number;
    in_flight: number;
    failed: number;
  }>(sql`
    select
      count(*) filter (
        where (status = 'QUEUED' and (scheduled_for is null or scheduled_for <= now()))
           or (status = 'SENDING'
               and updated_at < now() - (interval '1 second' * ${RECLAIM_AFTER_SECONDS}))
      )::int as resumable,
      count(*) filter (
        where status = 'QUEUED' and scheduled_for > now()
      )::int as retrying,
      count(*) filter (
        where status = 'SENDING'
          and updated_at >= now() - (interval '1 second' * ${RECLAIM_AFTER_SECONDS})
      )::int as in_flight,
      count(*) filter (where status = 'FAILED')::int as failed
      from email_outbox o
     where status in ('QUEUED', 'SENDING', 'FAILED')
       and deleted_at is null
       ${scope}
  `);
  const row = rows[0];
  return {
    resumable: row?.resumable ?? 0,
    retrying: row?.retrying ?? 0,
    inFlight: row?.in_flight ?? 0,
    failed: row?.failed ?? 0,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type DispatchOptions = {
  /** Injected by tests; production builds one from the environment. */
  transport?: MailTransport;
  /**
   * Which concert's backlog to report back (the banner's, §24.5). The
   * dispatcher itself always works the whole queue: a message is due whatever
   * concert the admin happens to be looking at.
   */
  backlogConcertId?: number;
  /**
   * Overrides {@link SEND_WINDOW_MS}. Injected by tests, which cannot spend
   * forty-five seconds proving that the loop stops after forty-five seconds.
   */
  sendWindowMs?: number;
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

  /**
   * Before anything else, because a stranded row is invisible to every other
   * query here: it is neither queued nor sent, and it blocks its registration
   * from being prepared again.
   */
  const reclaimed = await reclaimStranded();

  const timezone = await concertTimezone();
  const alreadySentToday = await sentToday(timezone);
  const budget = Math.max(0, maxPerDay - alreadySentToday);
  if (budget === 0) {
    return {
      sent: 0,
      failed: 0,
      deferred: 0,
      remaining: await remainingQueued(),
      dailyCapReached: true,
      warnings: [],
      reclaimed,
      backlog: await outboxBacklog(options.backlogConcertId),
    };
  }

  const batch = await claimBatch(Math.min(maxPerDispatch, budget));
  if (batch.length === 0) {
    return {
      sent: 0,
      failed: 0,
      deferred: 0,
      remaining: 0,
      dailyCapReached: false,
      warnings: [],
      reclaimed,
      backlog: await outboxBacklog(options.backlogConcertId),
    };
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

  const startedAt = Date.now();
  let deferred: number[] = [];

  try {
    for (const [index, row] of batch.entries()) {
      /**
       * Checked *before* starting a message rather than after finishing one:
       * the question is whether there is room for another send, and a message
       * that has begun cannot be handed back without risking a double send.
       */
      if (index > 0 && Date.now() - startedAt > (options.sendWindowMs ?? SEND_WINDOW_MS)) {
        deferred = batch.slice(index).map((r) => r.id);
        warnings.push(
          `stopped after ${index} of ${batch.length} to stay inside the dispatch window; ` +
            `${deferred.length} returned to the queue for the next call`,
        );
        break;
      }

      try {
        /**
         * Checked before the PDFs are built, not after: rendering a party's
         * tickets for a message that cannot be addressed is wasted work, and
         * this is the one failure where *not* sending is the whole point.
         */
        if (!DELIVERABLE.test(row.toEmail)) throw new UndeliverableAddressError(row.toEmail);

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

        /**
         * **The message a person reviewed must not disagree with what is
         * attached to it.**
         *
         * The body is rendered when the batch is prepared; the PDFs are built
         * now. A seat added in between leaves a message that says "2 ticket(s)"
         * carrying three — and §11.4's added-guest case makes that a normal
         * event rather than a freak one.
         *
         * Re-rendering here is not the fix: §11.5 requires the dispatcher to
         * send what was reviewed, verbatim. So the draft is stale, and the
         * honest move is to refuse it and tell the admin to prepare again —
         * which costs one click, where sending costs a guest turning up with a
         * ticket the email did not mention.
         */
        const statedCount = Number(row.context?.attendee_count ?? NaN);
        if (
          carriesTickets(row.templateKey) &&
          Number.isInteger(statedCount) &&
          statedCount !== party.attendeeIds.length
        ) {
          throw new Error(
            `This party had ${statedCount} seat(s) when the message was drafted and has ` +
              `${party.attendeeIds.length} now, so the reviewed wording no longer matches what ` +
              'would be attached. Discard the drafts and prepare the blast again.',
          );
        }

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
          html: markdownToEmailHtml(row.bodyMd, {
            preheader: markdownToPlainText(row.bodyMd).split('\n')[0],
            /**
             * Only a message that actually carries a PDF may tell the reader
             * to bring one — the same predicate that decides whether the
             * attachments were built at all, so the two cannot disagree.
             */
            footer: carriesTickets(row.templateKey)
              ? TICKET_FOOTER
              : undefined,
          }),
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
    /**
     * Straight back to `QUEUED`, rather than left for {@link reclaimStranded}.
     * These rows were claimed and never touched, so nothing was delivered from
     * them and nothing is stamped — and waiting out the ten-minute reclaim
     * window would make the next Send look broken for no reason.
     */
    if (deferred.length > 0) await releaseClaimed(deferred);
  }

  return {
    sent,
    failed,
    deferred: deferred.length,
    remaining: await remainingQueued(),
    dailyCapReached: false,
    warnings,
    reclaimed,
    backlog: await outboxBacklog(options.backlogConcertId),
  };
}
