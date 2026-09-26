import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createRegistration, createSegment, createShow } from '../helpers/fixtures';
import { getDb } from '@/db/client';
import { draftSuperseding, MessageInFlightError, type NewMessage } from '@/lib/email/supersede';

/**
 * spec/v3.md §24.2: one pending message per party per **purpose**, and
 * drafting again supersedes. What a guest would notice if this broke is two
 * ticket emails worded two ways — so each case asserts what is left to send.
 */

let registrationId: number;

beforeEach(async () => {
  await resetDb();
  const concertId = await createConcert('Supersede');
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
  registrationId = await createRegistration({ showId, segmentId, contactName: 'Party' });
});

const message = (over: Partial<NewMessage> = {}): NewMessage => ({
  addressee: { registrationId },
  purpose: 'TICKETS',
  templateKey: 'public_ticket',
  toEmail: 'party@example.test',
  toName: 'Party',
  subject: 'Your tickets',
  bodyMd: 'Hello',
  context: { attendee_count: '1' },
  status: 'QUEUED',
  ...over,
});

const draft = (over: Partial<NewMessage> = {}) =>
  getDb().transaction((tx) => draftSuperseding(tx, message(over)));

async function rows() {
  return sql<{ id: string; status: string; template_key: string; superseded_by_id: string | null }[]>`
    select id, status, template_key, superseded_by_id from email_outbox
     where registration_id = ${registrationId} order by id
  `;
}

describe('draftSuperseding', () => {
  it('cancels the pending draft under another template and points it at the new one', async () => {
    const first = await draft({ templateKey: 'player_confirmation', status: 'DRAFT' });
    const second = await draft({ templateKey: 'public_ticket' });

    expect(second.superseded).toEqual([first.id]);
    const [old, current] = await rows();
    expect(old).toMatchObject({ status: 'CANCELLED', superseded_by_id: String(second.id) });
    expect(current).toMatchObject({ status: 'QUEUED', template_key: 'public_ticket', superseded_by_id: null });
  });

  it('leaves exactly one pending message however many times it is pressed', async () => {
    for (let i = 0; i < 3; i += 1) await draft();
    const pending = (await rows()).filter((r) => ['DRAFT', 'QUEUED', 'SENDING'].includes(r.status));
    expect(pending).toHaveLength(1);
  });

  it('refuses while a message of the purpose is being sent, and changes nothing', async () => {
    const first = await draft();
    await sql`update email_outbox set status = 'SENDING' where id = ${first.id}`;

    await expect(draft()).rejects.toBeInstanceOf(MessageInFlightError);
    expect(await rows()).toHaveLength(1);
  });

  it('never touches a message of another purpose, or one already sent', async () => {
    const sent = await draft();
    await sql`update email_outbox set status = 'SENT', sent_at = now() where id = ${sent.id}`;
    await draft({ purpose: 'REMINDER', templateKey: 'reminder' });
    await draft();

    const statuses = (await rows()).map((r) => [r.template_key, r.status]);
    expect(statuses).toEqual([
      ['public_ticket', 'SENT'],
      ['reminder', 'QUEUED'],
      ['public_ticket', 'QUEUED'],
    ]);
  });
});
