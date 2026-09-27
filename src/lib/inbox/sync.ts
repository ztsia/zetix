import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import type { FolderRole, MailInbox, RawMessage } from '@/lib/mail/inbox';
import { parseMessage, type ParsedMessage } from '@/lib/mail/parse';
import type { Addressee } from '@/lib/mail/tagging';
import { findByMessageId, matchByHeaders, matchInbound } from './match';
import { appendMessage, ensureThread, markThreadHandled } from './threads';

/**
 * The inbox sync (spec/v3.md §26.3–§26.5).
 *
 * Reads **INBOX** and **Sent Mail** above each folder's stored UID cursor,
 * inside a deadline, one message at a time: parse, match, store, advance the
 * cursor. Everything it writes is idempotent — `email_messages.message_id` is
 * unique and a bounce is recorded once — so two syncs that overlap (a tick
 * and an open console) repeat work but never duplicate a row.
 *
 * - **INBOX**: a delivery-status notification that failed marks the outbox
 *   row it names `BOUNCED`, and joins the thread; a reply joins its thread and
 *   raises `REPLY_WAITING`. Anything unmatched is skipped and never stored
 *   (§26.1). A *delayed* notice is not a bounce and is skipped too.
 * - **Sent Mail**: our own messages are already in the outbox and are skipped;
 *   a reply someone wrote in Gmail itself, threading under one of ours, joins
 *   the thread and answers the questions before it.
 */

export type FolderReport = {
  role: FolderRole;
  path: string;
  read: number;
  stored: number;
  bounces: number;
  replies: number;
  skipped: number;
  /** The cursor was void (`UIDVALIDITY` changed, or there was none) and the folder was re-read from the window. */
  reset: boolean;
  /** Every listed message was read. False when the deadline stopped it. */
  complete: boolean;
  error: string | null;
};

export type SyncReport = { folders: FolderReport[] };

export type SyncOptions = {
  inbox: MailInbox;
  /** Our own address: what plus tags are read against and Sent mail is recognised by. */
  mailbox: string;
  /** Epoch ms. No message is started after it. */
  deadline: number;
  /** `inbox.match_fallback_days`: the sender-match window, and how far back a first sync reads. */
  fallbackDays: number;
  /** Test seam for "now". */
  now?: () => Date;
};

/** How many messages to fetch per IMAP round trip. A transport detail, not an operational value. */
const FETCH_CHUNK = 10;

type Cursor = { uidValidity: number | null; lastUid: number | null };

async function readCursor(path: string): Promise<Cursor> {
  const [row] = await getDb().execute<{ uid_validity: string | null; last_uid: string | null }>(sql`
    select uid_validity, last_uid from mail_sync_state where folder = ${path}`);
  return {
    uidValidity: row?.uid_validity == null ? null : Number(row.uid_validity),
    lastUid: row?.last_uid == null ? null : Number(row.last_uid),
  };
}

/**
 * Moves a folder's cursor. Under the same `uidValidity` it only ever moves
 * forward — an overlapping sync that finishes later with a smaller UID must not
 * drag it back — and a new `uidValidity` replaces it outright.
 */
async function writeCursor(path: string, uidValidity: number, lastUid: number, error: string | null): Promise<void> {
  await getDb().execute(sql`
    insert into mail_sync_state (folder, uid_validity, last_uid, last_synced_at, last_error)
    values (${path}, ${uidValidity}, ${lastUid}, now(), ${error})
    on conflict (folder) do update
       set last_uid = case when mail_sync_state.uid_validity = excluded.uid_validity
                           then greatest(coalesce(mail_sync_state.last_uid, 0), excluded.last_uid)
                           else excluded.last_uid end,
           uid_validity = excluded.uid_validity,
           last_synced_at = now(),
           last_error = excluded.last_error,
           updated_at = now()`);
}

async function recordError(path: string, error: string): Promise<void> {
  await getDb().execute(sql`
    insert into mail_sync_state (folder, last_error, last_synced_at) values (${path}, ${error}, now())
    on conflict (folder) do update set last_error = excluded.last_error, last_synced_at = now(), updated_at = now()`);
}

/**
 * A stable id for a message that carries none, so it is still stored once.
 * Rare — every mainstream client sets `Message-ID` — but a sync must not store
 * the same message on every tick because of it.
 */
function syntheticId(raw: Buffer): string {
  return `<sync.${createHash('sha256').update(raw).digest('hex').slice(0, 40)}@message-id.invalid>`;
}

function entityOf(addressee: Addressee): { entityType: string; entityId: number } {
  // `registration`, so a bounce or a reply appears in the party's Activity (U handoff).
  return { entityType: addressee.kind === 'player' ? 'player' : 'registration', entityId: addressee.id };
}

type Outcome = 'stored-reply' | 'stored-bounce' | 'stored-sent' | 'skipped';

async function processInbound(
  message: RawMessage,
  parsed: ParsedMessage,
  path: string,
  opts: SyncOptions,
): Promise<Outcome> {
  const messageId = parsed.messageId ?? syntheticId(message.raw);
  const messageAt = message.internalDate ?? parsed.date ?? (opts.now?.() ?? new Date());

  if (parsed.from?.address.toLowerCase() === opts.mailbox.toLowerCase()) return 'skipped';

  if (parsed.bounce) {
    if (parsed.bounce.action !== 'failed' || !parsed.bounce.originalMessageId) return 'skipped';
    const original = await findByMessageId(parsed.bounce.originalMessageId);
    if (!original) return 'skipped';

    const code = parsed.bounce.status;
    const detail = parsed.bounce.diagnostic ?? parsed.text?.slice(0, 2000) ?? null;
    return getDb().transaction(async (tx) => {
      const threadId = original.threadId ?? (await ensureThread(tx, original.addressee));
      const stored = await appendMessage(tx, {
        threadId,
        direction: 'INBOUND',
        outboxId: original.outboxId,
        messageId,
        inReplyTo: parsed.inReplyTo,
        referenceIds: parsed.references,
        fromEmail: parsed.from?.address ?? null,
        fromName: parsed.from?.name ?? null,
        toEmail: parsed.to,
        subject: parsed.subject,
        text: parsed.text,
        html: parsed.html,
        isBounce: true,
        messageAt,
        folder: path,
        uid: message.uid,
      });
      if (stored === null) return 'skipped';

      if (original.outboxId !== null) {
        /**
         * `status` and `bounced_at` in one statement (the U handoff): the
         * `party_pipeline` flag reads `bounced_at`, and a `BOUNCED` row without
         * it would be a bounce the party never shows.
         */
        await tx.execute(sql`
          update email_outbox
             set status = 'BOUNCED', bounced_at = ${messageAt.toISOString()}::timestamptz,
                 bounce_code = ${code}, bounce_detail = ${detail?.slice(0, 2000) ?? null}, updated_at = now()
           where id = ${original.outboxId}
             and bounced_at is null
             and status in ('SENT', 'BOUNCED')`);
      }
      await writeAuditLog(
        {
          action: 'email.bounced',
          ...entityOf(original.addressee),
          after: {
            outboxId: original.outboxId,
            messageId: parsed.bounce!.originalMessageId,
            recipient: parsed.bounce!.recipient,
            code,
            detail,
          },
          actorId: null,
        },
        tx,
      );
      return 'stored-bounce';
    });
  }

  const match = await matchInbound(parsed, {
    mailbox: opts.mailbox,
    fallbackDays: opts.fallbackDays,
    receivedAt: messageAt,
  });
  if (!match) return 'skipped';

  return getDb().transaction(async (tx) => {
    const threadId = match.threadId ?? (await ensureThread(tx, match.addressee));
    const stored = await appendMessage(tx, {
      threadId,
      direction: 'INBOUND',
      outboxId: match.outboxId,
      messageId,
      inReplyTo: parsed.inReplyTo,
      referenceIds: parsed.references,
      fromEmail: parsed.from?.address ?? null,
      fromName: parsed.from?.name ?? null,
      toEmail: parsed.to,
      subject: parsed.subject,
      text: parsed.text,
      html: parsed.html,
      messageAt,
      folder: path,
      uid: message.uid,
    });
    if (stored === null) return 'skipped';
    await writeAuditLog(
      {
        action: 'email.reply_received',
        ...entityOf(match.addressee),
        after: { messageId, from: parsed.from?.address ?? null, subject: parsed.subject, matchedBy: match.via },
        actorId: null,
      },
      tx,
    );
    return 'stored-reply';
  });
}

async function processSent(
  message: RawMessage,
  parsed: ParsedMessage,
  path: string,
  opts: SyncOptions,
): Promise<Outcome> {
  // Ours: the outbox already has it, and the record reads it from there.
  if (parsed.messageId) {
    const [ours] = await getDb().execute<{ id: string }>(sql`
      select id from email_outbox where message_id = ${parsed.messageId}`);
    if (ours) return 'skipped';
  }
  // Only a reply joins a thread: a fresh message written in Gmail is outside the system (§26.1).
  const match = await matchByHeaders(parsed);
  if (!match) return 'skipped';

  const messageAt = message.internalDate ?? parsed.date ?? (opts.now?.() ?? new Date());
  return getDb().transaction(async (tx) => {
    const threadId = match.threadId ?? (await ensureThread(tx, match.addressee));
    const stored = await appendMessage(tx, {
      threadId,
      direction: 'OUTBOUND',
      messageId: parsed.messageId ?? syntheticId(message.raw),
      inReplyTo: parsed.inReplyTo,
      referenceIds: parsed.references,
      fromEmail: parsed.from?.address ?? opts.mailbox,
      fromName: parsed.from?.name ?? null,
      toEmail: parsed.to,
      subject: parsed.subject,
      text: parsed.text,
      html: parsed.html,
      messageAt,
      folder: path,
      uid: message.uid,
    });
    if (stored === null) return 'skipped';
    // Someone answered in Gmail: the questions before it are handled (§26.5).
    await markThreadHandled(tx, threadId, null, messageAt);
    return 'stored-sent';
  });
}

async function syncFolder(role: FolderRole, path: string, opts: SyncOptions): Promise<FolderReport> {
  const now = opts.now?.() ?? new Date();
  const report: FolderReport = {
    role,
    path,
    read: 0,
    stored: 0,
    bounces: 0,
    replies: 0,
    skipped: 0,
    reset: false,
    complete: false,
    error: null,
  };
  const since = new Date(now.getTime() - opts.fallbackDays * 24 * 60 * 60 * 1000);

  const cursor = await readCursor(path);
  let listing =
    cursor.lastUid !== null && cursor.uidValidity !== null
      ? await opts.inbox.list(path, { afterUid: cursor.lastUid })
      : null;
  if (!listing || listing.uidValidity !== cursor.uidValidity) {
    // No cursor, or one the server has voided: re-read the window. Idempotent, so safe.
    listing = await opts.inbox.list(path, { since });
    report.reset = true;
  }
  const { uidValidity, uids } = listing;

  let lastDone: number | null = null;
  let parseErrors = 0;
  for (let start = 0; start < uids.length; start += FETCH_CHUNK) {
    if (Date.now() >= opts.deadline) break;
    const messages = await opts.inbox.fetch(path, uids.slice(start, start + FETCH_CHUNK));
    for (const message of messages) {
      if (Date.now() >= opts.deadline) break;
      report.read += 1;
      let parsed: ParsedMessage | null = null;
      try {
        parsed = await parseMessage(message.raw);
      } catch {
        // A message that cannot be parsed never will be; stepping past it keeps it from blocking the folder.
        parseErrors += 1;
      }
      if (parsed) {
        const outcome =
          role === 'inbox'
            ? await processInbound(message, parsed, path, opts)
            : await processSent(message, parsed, path, opts);
        if (outcome === 'skipped') report.skipped += 1;
        else {
          report.stored += 1;
          if (outcome === 'stored-bounce') report.bounces += 1;
          if (outcome === 'stored-reply') report.replies += 1;
        }
      } else {
        report.skipped += 1;
      }
      lastDone = message.uid;
      // Advanced per message, so a sync cut short resumes exactly here.
      await writeCursor(path, uidValidity, lastDone, null);
    }
    // A UID listed but gone by the time it was fetched (expunged) is simply past.
    const chunkEnd = uids[Math.min(start + FETCH_CHUNK, uids.length) - 1];
    if (Date.now() < opts.deadline && chunkEnd !== undefined && (lastDone ?? 0) < chunkEnd) {
      lastDone = chunkEnd;
      await writeCursor(path, uidValidity, lastDone, null);
    }
  }

  report.complete = uids.length === 0 || (lastDone !== null && lastDone >= uids[uids.length - 1]);
  if (report.complete) {
    // Everything listed is read: the cursor may stand at the folder's top.
    await writeCursor(
      path,
      uidValidity,
      Math.max(lastDone ?? 0, listing.highestUid),
      parseErrors > 0 ? `${parseErrors} message(s) could not be parsed and were skipped.` : null,
    );
  }
  return report;
}

/**
 * One sync pass. Never throws for a folder's failure: the error is recorded on
 * the folder's cursor row and in the report, and the other folder still runs.
 */
export async function syncMailbox(opts: SyncOptions): Promise<SyncReport> {
  const folders: FolderReport[] = [];
  for (const role of ['inbox', 'sent'] as const) {
    if (Date.now() >= opts.deadline) break;
    let path: string | null = null;
    try {
      path = await opts.inbox.resolve(role);
      if (!path) continue;
      folders.push(await syncFolder(role, path, opts));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (path) await recordError(path, message.slice(0, 2000));
      folders.push({
        role,
        path: path ?? role,
        read: 0,
        stored: 0,
        bounces: 0,
        replies: 0,
        skipped: 0,
        reset: false,
        complete: false,
        error: message,
      });
    }
  }
  return { folders };
}
