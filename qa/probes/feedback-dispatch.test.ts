import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert, createRegistration, createSegment, createShow,
  issueTickets, seedAttendees, setSystemSetting,
} from '../../tests/helpers/fixtures';
import { dispatchBatch } from '@/lib/email/dispatch';
import type { MailTransport, OutgoingMessage } from '@/lib/email/transport';

/** AC-48: sending a feedback email must not stamp ticket_sent_at, nor touch qr_token. */
function recordingTransport(): MailTransport & { messages: OutgoingMessage[] } {
  const messages: OutgoingMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
      return { accepted: [message.to], rejected: [], response: '250 ok', messageId: '<t>', raw: null };
    },
    async close() {},
  };
}

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';
  await setSystemSetting('email.max_per_dispatch', 25);
  await setSystemSetting('email.max_per_day', 450);
  await setSystemSetting('email.inter_message_delay_ms', 0);
  await setSystemSetting('email.max_attempts', 3);
  await setSystemSetting('email.merge_attachments_above', 8);
  await setSystemSetting('email.max_attachment_mb', 20);
});

describe('dispatching a feedback_request row', () => {
  it('sends it, stamps no ticket, and leaves every qr_token alone', async () => {
    const concertId = await createConcert('Feedback dispatch');
    const showId = await createShow(concertId, 400);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    const registrationId = await createRegistration({ showId, segmentId, contactName: 'Party' });
    await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });
    await issueTickets(concertId, showId);
    const before = await sql<{ id: string; qr_token: string; ticket_sent_at: string | null }[]>`
      select id, qr_token, ticket_sent_at from attendees where registration_id = ${registrationId} order by id`;

    await sql`
      insert into email_outbox (registration_id, template_key, to_email, to_name, subject, body_md, status)
      values (${registrationId}, 'feedback_request', 'party@example.test', 'Party',
              'How was it?', 'Hello **Party**', 'QUEUED')`;

    const transport = recordingTransport();
    const result = await dispatchBatch({ transport, sendWindowMs: 0 });
    console.log('dispatch result:', JSON.stringify(result));
    console.log('attachments:', JSON.stringify(transport.messages.map((m) => m.attachments?.length ?? 0)));

    const after = await sql<{ id: string; qr_token: string; ticket_sent_at: string | null }[]>`
      select id, qr_token, ticket_sent_at from attendees where registration_id = ${registrationId} order by id`;
    console.log('stamps after:', JSON.stringify(after.map((a) => a.ticket_sent_at)));

    expect(result.sent).toBe(1);
    expect(after.every((a) => a.ticket_sent_at === null)).toBe(true);
    expect(after.map((a) => a.qr_token)).toEqual(before.map((a) => a.qr_token));
    expect(transport.messages[0].attachments?.length ?? 0).toBe(0);
    const [row] = await sql`select status from email_outbox`;
    expect(row.status).toBe('SENT');
  });
});
