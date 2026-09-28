import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';
import { previewCommand, startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { getDb } from '@/db/client';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { dispatchBatch } from '@/lib/email/dispatch';
import type { MailTransport, OutgoingMessage } from '@/lib/mail/transport';
import { listMessages } from '@/lib/delivery/messages';
import { createRegistration } from '@/lib/registrations/mutations';

/**
 * Messages — spec/v3.md §24.4: every message has an exit, and `SENDING` has
 * none. Asserted as what the dispatcher would then send, and to whom.
 */

let concertId: number;
let segmentId: number;

const far = () => Date.now() + 60_000;

async function run(name: string, selection: unknown, params: unknown = {}) {
  return startCommand(getCommand(name)!, { concertId, selection, params }, { actorId: null, deadline: far() });
}

const preview = (name: string, selection: unknown, params: unknown = {}) =>
  previewCommand(getCommand(name)!, { concertId, selection, params }, null);

async function party(name = 'Party', email = 'party@example.test') {
  const { registrationId } = await createRegistration({
    segmentId,
    contactName: name,
    contactEmail: email,
    seats: [{ fullName: `${name} 1`, allocationType: 'EXTRA' }],
  });
  return registrationId;
}

async function message(registrationId: number, status: string, over: { purpose?: string; template?: string; to?: string } = {}) {
  const [row] = await sql<{ id: string }[]>`
    insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, attempts, last_error, sent_at)
    values (${registrationId}, ${over.purpose ?? 'REMINDER'}::message_purpose, ${over.template ?? 'reminder'},
            ${over.to ?? 'party@example.test'}, 'Soon', 'See you **soon**', ${status}::outbox_status,
            ${status === 'FAILED' ? 3 : 0}, ${status === 'FAILED' ? 'Mailbox full' : null},
            case when ${status} = 'SENT' then now() end)
    returning id`;
  return Number(row.id);
}

async function row(id: number) {
  const [r] = await sql<{ status: string; attempts: number; to_email: string; subject: string; deleted_at: Date | null }[]>`
    select status, attempts, to_email, subject, deleted_at from email_outbox where id = ${id}`;
  return r;
}

function transport(): MailTransport & { sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
      return { accepted: [m.to], rejected: [], response: '250 ok', messageId: '<t>', raw: null };
    },
    async close() {},
  };
}

beforeEach(async () => {
  await resetDb();
  await seedDefaultTemplates();
  concertId = await createConcert('Messages');
  const showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: 40,
    extrasPolicy: 'AUTO_FCFS',
    allowPartialGrant: false,
  });
  await setSystemSetting('admin.typed_confirm_above', 20);
  for (const [key, value] of Object.entries({
    'email.max_per_dispatch': 25,
    'email.max_per_day': 450,
    'email.inter_message_delay_ms': 0,
    'email.max_attempts': 3,
    'email.merge_attachments_above': 8,
    'email.max_attachment_mb': 20,
  })) {
    await setSystemSetting(key, value);
  }
});

describe('Retry', () => {
  it('puts a failed message back in the queue with fresh attempts, to the party’s address today', async () => {
    const id = await party();
    const failed = await message(id, 'FAILED');
    await sql`update registrations set contact_email = 'fixed@example.test' where id = ${id}`;

    const report = await run('messages.retry', { ids: [failed] });
    expect(report.done).toBe(1);
    expect(await row(failed)).toMatchObject({ status: 'QUEUED', attempts: 0, to_email: 'fixed@example.test' });

    const mail = transport();
    await dispatchBatch({ transport: mail });
    expect(mail.sent.map((m) => m.to)).toEqual(['fixed@example.test']);
  });

  it('skips a message that did not fail, and one a newer message already replaces', async () => {
    const id = await party();
    const failed = await message(id, 'FAILED');
    const sent = await message(id, 'SENT');
    await message(id, 'QUEUED');
    const p = await preview('messages.retry', { ids: [failed, sent] });
    expect(p.runnable).toBe(0);
    const reasons = Object.fromEntries(p.rows.map((r) => [r.id, r.skip]));
    expect(reasons[failed]).toMatch(/already waiting/);
    expect(reasons[sent]).toMatch(/Only a failed message/);
  });

  it('refuses a ticket email whose party changed since it was written', async () => {
    const id = await party();
    const failed = await message(id, 'FAILED', { purpose: 'TICKETS', template: 'public_ticket' });
    await sql`update email_outbox set context = '{"attendee_count":"3"}' where id = ${failed}`;
    const p = await preview('messages.retry', { ids: [failed] });
    expect(p.rows[0].skip).toMatch(/Send tickets again/);
  });
});

describe('Cancel', () => {
  it('withdraws a queued message, and leaves one being sent alone', async () => {
    const a = await party('A');
    const b = await party('B');
    const queued = await message(a, 'QUEUED');
    const sending = await message(b, 'SENDING');

    const report = await run('messages.cancel', { ids: [queued, sending] });
    expect(report.done).toBe(1);
    expect((await row(queued)).status).toBe('CANCELLED');
    expect((await row(sending)).status).toBe('SENDING');
  });
});

describe('Edit', () => {
  it('rewrites a queued message, and is what the dispatcher then sends', async () => {
    const id = await party();
    const queued = await message(id, 'QUEUED');
    await run('messages.edit', { ids: [queued] }, { subject: 'Changed', bodyMd: 'New words' });

    const mail = transport();
    await dispatchBatch({ transport: mail });
    expect(mail.sent[0].subject).toBe('Changed');
  });

  it('refuses a sent message, and more than one at a time', async () => {
    const id = await party();
    const sent = await message(id, 'SENT');
    const other = await message(await party('B'), 'QUEUED');
    expect((await preview('messages.edit', { ids: [sent] }, { subject: 'x', bodyMd: 'y' })).rows[0].skip).toMatch(/not yet sent/);
    await expect(preview('messages.edit', { ids: [sent, other] }, { subject: 'x', bodyMd: 'y' })).rejects.toThrow(/one message at a time/);
    await expect(
      preview('messages.edit', { filter: {}, excludedIds: [] }, { subject: 'x', bodyMd: 'y' }),
    ).rejects.toThrow(/one message at a time/);
  });
});

describe('Delete', () => {
  it('cancels a queued message before it goes to the Trash, so it can never be sent', async () => {
    const id = await party();
    const queued = await message(id, 'QUEUED');
    await run('messages.delete', { ids: [queued] });
    expect(await row(queued)).toMatchObject({ status: 'CANCELLED' });
    expect((await row(queued)).deleted_at).not.toBeNull();

    // Out of the Trash, it is still cancelled.
    await sql`update email_outbox set deleted_at = null where id = ${queued}`;
    const mail = transport();
    await dispatchBatch({ transport: mail });
    expect(mail.sent).toHaveLength(0);
  });

  it('removes a sent message from the view and clears the flag it raised', async () => {
    const id = await party();
    const failed = await message(id, 'FAILED', { purpose: 'TICKETS', template: 'public_ticket' });
    const [before] = await sql<{ flags: string[] }[]>`select flags from party_pipeline where registration_id = ${id}`;
    expect(before.flags).toContain('SEND_FAILED');

    await run('messages.delete', { ids: [failed] });
    const [after] = await sql<{ flags: string[] }[]>`select flags from party_pipeline where registration_id = ${id}`;
    expect(after.flags).not.toContain('SEND_FAILED');
    const listed = await listMessages(getDb(), concertId, {}, { offset: 0, limit: 50, searchAddresses: true });
    expect(listed.rows.map((r) => r.id)).not.toContain(failed);
  });
});

describe('Resend', () => {
  it('queues a copy of a sent message to the current address', async () => {
    const id = await party();
    const sent = await message(id, 'SENT');
    await sql`update registrations set contact_email = 'moved@example.test' where id = ${id}`;
    const report = await run('messages.resend', { ids: [sent] });
    expect(report.done).toBe(1);
    const copies = await sql<{ status: string; to_email: string; subject: string }[]>`
      select status, to_email, subject from email_outbox where registration_id = ${id} and id <> ${sent}`;
    expect(copies).toEqual([{ status: 'QUEUED', to_email: 'moved@example.test', subject: 'Soon' }]);
    expect((await row(sent)).status).toBe('SENT');
  });
});

describe('The Messages view', () => {
  it('lists only this concert’s messages, counts each status, and a viewer’s search never matches an address', async () => {
    const id = await party('Alice', 'alice@secret.test');
    await message(id, 'QUEUED', { to: 'alice@secret.test' });
    await message(id, 'FAILED', { to: 'alice@secret.test' });
    const otherConcert = await createConcert('Elsewhere');
    const otherShow = await createShow(otherConcert, 10);
    const otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 5, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false });
    const { registrationId: other } = await createRegistration({
      segmentId: otherSeg,
      contactName: 'Else',
      contactEmail: 'else@example.test',
      seats: [{ fullName: 'Else 1', allocationType: 'EXTRA' }],
    });
    await message(other, 'QUEUED', { to: 'else@example.test' });

    const all = await listMessages(getDb(), concertId, {}, { offset: 0, limit: 50, searchAddresses: true });
    expect(all.total).toBe(2);
    expect(all.counts).toMatchObject({ QUEUED: 1, FAILED: 1, SENT: 0 });

    const admin = await listMessages(getDb(), concertId, { search: 'secret' }, { offset: 0, limit: 50, searchAddresses: true });
    const viewer = await listMessages(getDb(), concertId, { search: 'secret' }, { offset: 0, limit: 50, searchAddresses: false });
    expect(admin.total).toBe(2);
    expect(viewer.total).toBe(0);
  });
});
