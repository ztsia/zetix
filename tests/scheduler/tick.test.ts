import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createRegistration, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';
import { MemoryInbox } from '@/lib/mail/memory-inbox';
import { createStreamTransport } from '@/lib/mail/transport';
import { runTick } from '@/lib/scheduler/tick';

/**
 * One real tick against the real schema (spec/v3.md §27.1): nothing mocked but
 * the two ends — the SMTP hop and the mailbox.
 */

const MAILBOX = 'events@example.org';

beforeEach(async () => {
  await resetDb();
  for (const [key, value] of Object.entries({
    'email.max_per_dispatch': 25,
    'email.max_per_day': 450,
    'email.inter_message_delay_ms': 0,
    'email.max_attempts': 3,
    'email.merge_attachments_above': 8,
    'email.max_attachment_mb': 20,
    'inbox.sync_budget_seconds': 5,
    'inbox.match_fallback_days': 30,
    'scheduler.history_days': 7,
  })) {
    await setSystemSetting(key, value);
  }
});

describe('a tick', () => {
  it('sends what is due, leaves what is not, and reads the reply to it', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 100);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
    const registrationId = await createRegistration({ showId, segmentId, contactName: 'Ada Guest' });

    const [due] = await sql<{ id: string }[]>`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
      values (${registrationId}, 'CANCELLATION', 'registration_cancelled', 'reg@example.test', 'Cancelled', 'Sorry', 'QUEUED')
      returning id`;
    const [later] = await sql<{ id: string }[]>`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, scheduled_for)
      values (${registrationId}, 'REMINDER', 'reminder', 'reg@example.test', 'Soon', 'See you', 'QUEUED', now() + interval '1 hour')
      returning id`;

    // The reply arrives while the tick runs: the inbox is read after sending.
    const transport = createStreamTransport('LCO', MAILBOX);
    const inbox = new MemoryInbox();
    const sending = transport.send.bind(transport);
    transport.send = async (message) => {
      const result = await sending(message);
      inbox.deliver(
        'inbox',
        [
          'From: reg@example.test',
          `To: ${MAILBOX}`,
          'Subject: Re: Cancelled',
          'Message-ID: <reply-in-tick@example.test>',
          `In-Reply-To: ${message.threading?.messageId}`,
          '',
          'Why?',
        ].join('\r\n'),
      );
      return result;
    };

    const report = await runTick({ source: 'manual', transport, inbox, mailbox: MAILBOX, budgetMs: 20_000 });
    expect(report.dispatch).toMatchObject({ ok: true, result: { sent: 1 } });
    expect(report.inbox).toMatchObject({ ok: true, result: { status: 'synced' } });

    const statuses = await sql<{ id: string; status: string }[]>`select id, status from email_outbox order by id`;
    expect(statuses).toEqual([
      { id: due.id, status: 'SENT' },
      { id: later.id, status: 'QUEUED' },
    ]);
    const [flag] = await sql<{ flag_reply_waiting: boolean }[]>`
      select flag_reply_waiting from party_pipeline where registration_id = ${registrationId}`;
    expect(flag.flag_reply_waiting).toBe(true);

    const [beat] = await sql<{ error: string | null; finished_at: string | null }[]>`
      select error, finished_at from scheduler_heartbeat`;
    expect(beat).toMatchObject({ error: null });
    expect(beat.finished_at).not.toBeNull();
  });
});
