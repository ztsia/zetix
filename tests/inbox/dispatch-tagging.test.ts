import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  setSystemSetting,
} from '../helpers/fixtures';
import { dispatchBatch } from '@/lib/email/dispatch';
import { parseMessage } from '@/lib/mail/parse';
import { createStreamTransport, type MailTransport, type SendResult } from '@/lib/mail/transport';

/**
 * Every message the dispatcher sends is tagged so what comes back can find it
 * (spec/v3.md §26.2), and a reply threads under what it answers (§26.6).
 * Asserted on the composed bytes — what Gmail would receive — not on the
 * options handed to nodemailer.
 */

const MAILBOX = 'events@example.org';

/** The stream transport, keeping every composed message. */
function capturing(): MailTransport & { sent: SendResult[] } {
  const inner = createStreamTransport('Lakeside Community Orchestra', MAILBOX);
  const sent: SendResult[] = [];
  return {
    sender: inner.sender,
    sent,
    async send(message) {
      const result = await inner.send(message);
      sent.push(result);
      return result;
    },
    close: () => inner.close(),
  };
}

async function party() {
  // One concert per test: `createConcert()` derives a slug from the name.
  const concertId = await createConcert();
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
  const registrationId = await createRegistration({ showId, segmentId, contactName: 'Ada Guest' });
  return { concertId, registrationId };
}

async function queue(opts: { registrationId?: number; playerId?: number; purpose?: string; templateKey?: string | null; inReplyTo?: number }) {
  const [row] = await sql<{ id: string }[]>`
    insert into email_outbox (registration_id, player_id, purpose, template_key, to_email, to_name,
                              subject, body_md, status, in_reply_to_message_id)
    values (${opts.registrationId ?? null}, ${opts.playerId ?? null},
            ${opts.purpose ?? 'CANCELLATION'}::message_purpose,
            ${opts.templateKey === undefined ? 'registration_cancelled' : opts.templateKey},
            'guest@guest.example', 'Ada Guest', 'Your booking', 'Hello **Ada**', 'QUEUED',
            ${opts.inReplyTo ?? null})
    returning id`;
  return Number(row.id);
}

beforeEach(async () => {
  await resetDb();
  await setSystemSetting('email.max_per_dispatch', 25);
  await setSystemSetting('email.max_per_day', 450);
  await setSystemSetting('email.inter_message_delay_ms', 0);
  await setSystemSetting('email.max_attempts', 3);
  await setSystemSetting('email.merge_attachments_above', 8);
  await setSystemSetting('email.max_attachment_mb', 20);
});

describe('outgoing tags', () => {
  it('stores the Message-ID it sent, and plus-tags Reply-To with the registration', async () => {
    const { registrationId } = await party();
    const id = await queue({ registrationId });
    const transport = capturing();
    const result = await dispatchBatch({ transport });
    expect(result.sent).toBe(1);

    const [row] = await sql<{ message_id: string | null }[]>`select message_id from email_outbox where id = ${id}`;
    expect(row.message_id).toMatch(new RegExp(`^<${id}\\.[0-9a-f]{16}@example\\.org>$`));

    const raw = transport.sent[0].raw!.toString();
    const back = await parseMessage(raw);
    expect(back.messageId).toBe(row.message_id);
    expect(raw).toMatch(new RegExp(`^Reply-To: events\\+p${registrationId}@example\\.org\\r?$`, 'm'));
  });

  it('tags a player-addressed message with pl', async () => {
    const concertId = await createConcert();
    const [playerId] = await createPlayers(concertId, 1);
    await queue({ playerId, purpose: 'NOTES_DIGEST', templateKey: 'player_notes_digest' });
    const transport = capturing();
    await dispatchBatch({ transport });
    expect(transport.sent[0].raw!.toString()).toMatch(new RegExp(`^Reply-To: events\\+pl${playerId}@example\\.org`, 'm'));
  });

  it('mints a new Message-ID for a retry: the id names the message that went', async () => {
    const { registrationId } = await party();
    const id = await queue({ registrationId });
    let fail = true;
    const inner = capturing();
    const flaky: MailTransport = {
      sender: inner.sender,
      async send(message) {
        if (fail) {
          fail = false;
          throw new Error('421 try again');
        }
        return inner.send(message);
      },
      close: () => inner.close(),
    };
    await dispatchBatch({ transport: flaky });
    const [failed] = await sql<{ message_id: string | null }[]>`select message_id from email_outbox where id = ${id}`;
    // Nothing went, so nothing is stored for a reply to find.
    expect(failed.message_id).toBeNull();

    await sql`update email_outbox set scheduled_for = null where id = ${id}`;
    await dispatchBatch({ transport: flaky });
    const [sent] = await sql<{ message_id: string | null }[]>`select message_id from email_outbox where id = ${id}`;
    expect(sent.message_id).not.toBeNull();
  });

  it('sends only the rows it is asked to when given onlyIds', async () => {
    const { registrationId } = await party();
    const first = await queue({ registrationId });
    // A second purpose for the same party: the pending index allows one per purpose.
    const second = await queue({ registrationId, purpose: 'REMINDER', templateKey: 'reminder' });
    const transport = capturing();
    const result = await dispatchBatch({ transport, onlyIds: [second] });
    expect(result.sent).toBe(1);
    const rows = await sql<{ id: string; status: string }[]>`select id, status from email_outbox order by id`;
    expect(rows.map((r) => [Number(r.id), r.status])).toEqual([
      [first, 'QUEUED'],
      [second, 'SENT'],
    ]);
  });
});

describe('a reply', () => {
  it('threads under the message it answers, joins the thread, and answers the waiting question', async () => {
    const { registrationId } = await party();
    const [thread] = await sql<{ id: string }[]>`
      insert into email_threads (registration_id) values (${registrationId}) returning id`;
    const [inbound] = await sql<{ id: string }[]>`
      insert into email_messages (thread_id, direction, message_id, reference_ids, from_email, subject, text, message_at)
      values (${thread.id}, 'INBOUND', '<q-1@guest.example>', array['<7.aaaa@example.org>'], 'guest@guest.example',
              'Re: Your tickets', 'Can I bring my daughter?', now() - interval '1 hour')
      returning id`;
    const [before] = await sql<{ flag_reply_waiting: boolean }[]>`
      select flag_reply_waiting from party_pipeline where registration_id = ${registrationId}`;
    expect(before.flag_reply_waiting).toBe(true);

    const replyId = await queue({ registrationId, purpose: 'REPLY', templateKey: null, inReplyTo: Number(inbound.id) });
    const transport = capturing();
    await dispatchBatch({ transport, onlyIds: [replyId] });

    const back = await parseMessage(transport.sent[0].raw!);
    expect(back.inReplyTo).toBe('<q-1@guest.example>');
    expect(back.references).toEqual(['<7.aaaa@example.org>', '<q-1@guest.example>']);

    const messages = await sql<{ direction: string; outbox_id: string | null; message_id: string; handled_at: string | null }[]>`
      select direction, outbox_id, message_id, handled_at from email_messages
       where thread_id = ${thread.id} order by message_at, id`;
    expect(messages).toHaveLength(2);
    expect(messages[0].handled_at).not.toBeNull();
    expect(messages[1]).toMatchObject({ direction: 'OUTBOUND', outbox_id: String(replyId), message_id: back.messageId });

    const [after] = await sql<{ flag_reply_waiting: boolean }[]>`
      select flag_reply_waiting from party_pipeline where registration_id = ${registrationId}`;
    expect(after.flag_reply_waiting).toBe(false);
  });

  it('does not copy a ticket or cancellation into the thread: only an answer clears a question', async () => {
    const { registrationId } = await party();
    const [thread] = await sql<{ id: string }[]>`
      insert into email_threads (registration_id) values (${registrationId}) returning id`;
    await sql`
      insert into email_messages (thread_id, direction, message_id, from_email, subject, message_at)
      values (${thread.id}, 'INBOUND', '<q-2@guest.example>', 'guest@guest.example', 'A question', now() - interval '1 hour')`;
    await queue({ registrationId });
    await dispatchBatch({ transport: capturing() });

    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from email_messages where thread_id = ${thread.id}`;
    expect(count.n).toBe(1);
    const [flag] = await sql<{ flag_reply_waiting: boolean }[]>`
      select flag_reply_waiting from party_pipeline where registration_id = ${registrationId}`;
    expect(flag.flag_reply_waiting).toBe(true);
  });
});
