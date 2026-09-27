/**
 * QA phase 4 — module `F` (outbox, Gmail SMTP, blast), against the real zetix_qa
 * database. Written by the QA reviewer, not the author. No mocks of the
 * database, and the concurrency checks use two genuine connections.
 *
 * Criteria under test: AC-11, AC-12, AC-14, AC-16, AC-19, AC-21, AC-23, AC-24,
 * AC-25, AC-28, AC-32, AC-33, AC-35, AC-36, AC-43, AC-45, AC-49, AC-52.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql, newConnection } from '../../tests/helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  setSystemSetting,
  withDirectAttendeeWrites,
} from '../../tests/helpers/fixtures';
import { queueBlast, blastSplit } from '@/lib/email/queue';
import { dispatchBatch } from '@/lib/email/dispatch';
import { editTemplateAndRerender, markDelivered } from '@/lib/email/mutations';
import { issueTickets } from '@/lib/tickets/issue';
import type { MailTransport, OutgoingMessage, SendResult } from '@/lib/mail/transport';

process.env.APP_URL ??= 'https://zetix.vercel.app';

const TEMPLATE = 'public_ticket';

type Recorder = MailTransport & { messages: OutgoingMessage[] };

function recorder(behaviour?: (m: OutgoingMessage) => Partial<SendResult> | void): Recorder {
  const messages: OutgoingMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
      const override = behaviour?.(message) ?? {};
      return {
        accepted: [message.to],
        rejected: [],
        response: '250 ok',
        messageId: '<qa>',
        raw: null,
        ...override,
      };
    },
    async close() {},
  };
}

async function seedTemplate() {
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (${TEMPLATE}, 'Public ticket',
            'Tickets for {{ concert.name }}',
            'Hi {{ registration.contact_name }} — {{ attendee_count }} ticket(s).')
    on conflict (key) do update set subject = excluded.subject, body_md = excluded.body_md
  `;
}

async function seedWorld(opts: { parties: number; seatsEach: number }) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  const registrationIds: number[] = [];
  for (let i = 0; i < opts.parties; i++) {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      contactName: `Party ${i + 1}`,
    });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: opts.seatsEach,
      allocationType: 'BASE',
    });
    registrationIds.push(registrationId);
  }
  await issueTickets({ concertId, showId });
  return { concertId, showId, segmentId, registrationIds };
}

beforeEach(async () => {
  await resetDb();
  await seedTemplate();
  await setSystemSetting('email.max_per_dispatch', 25);
  await setSystemSetting('email.max_per_day', 450);
  await setSystemSetting('email.inter_message_delay_ms', 0);
  await setSystemSetting('email.max_attempts', 3);
  await setSystemSetting('email.merge_attachments_above', 8);
  await setSystemSetting('email.max_attachment_mb', 20);
});

/* ------------------------------------------------------------------ AC-24 */
describe('AC-24 two dispatchers contending for the same queue', () => {
  /**
   * The claim is `for update skip locked`. Sequential calls prove nothing about
   * it — this opens two real connections and holds the first claim's lock open
   * while the second runs, which is the only shape in which the clause matters.
   */
  it('never hands the same row to two claimers', async () => {
    const { segmentId } = await seedWorld({ parties: 4, seatsEach: 1 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;

    const a = newConnection();
    const b = newConnection();
    const CLAIM = `
      with claimed as (
        select id from email_outbox
         where status = 'QUEUED' and (scheduled_for is null or scheduled_for <= now())
         order by created_at, id
         for update skip locked
         limit 2
      )
      update email_outbox o set status = 'SENDING', updated_at = now()
        from claimed where o.id = claimed.id
      returning o.id
    `;
    try {
      const [ra, rb] = await Promise.all([
        a.begin(async (tx) => {
          const rows = (await tx.unsafe(CLAIM)) as unknown as { id: string }[];
          // Hold the lock while B runs; without SKIP LOCKED B would block here.
          await tx.unsafe(`select pg_sleep(0.5)`);
          return rows.map((r) => Number(r.id));
        }),
        (async () => {
          await new Promise((r) => setTimeout(r, 100));
          return b.begin(async (tx) => {
            const rows = (await tx.unsafe(CLAIM)) as unknown as { id: string }[];
            return rows.map((r) => Number(r.id));
          });
        })(),
      ]);
      const overlap = (ra as number[]).filter((id) => (rb as number[]).includes(id));
      expect(overlap).toEqual([]);
      expect([...(ra as number[]), ...(rb as number[])].length).toBe(4);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

/* ------------------------------------------------------------------ AC-32 */
describe('AC-32 a dispatch that dies mid-batch', () => {
  /**
   * `claimBatch()` flips a whole batch to `SENDING` in one statement, then sends
   * them one at a time. A Vercel function that hits `maxDuration` leaves every
   * unsent row of that batch in `SENDING`. Nothing in the module moves them
   * back, and the partial unique index covers `SENDING` — so the registration
   * can never be re-queued either.
   */
  it('leaves rows stranded in SENDING with no path back', async () => {
    const { segmentId } = await seedWorld({ parties: 3, seatsEach: 1 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;

    // Exactly what a timed-out invocation leaves behind.
    await sql`update email_outbox set status = 'SENDING'`;

    const after = await dispatchBatch({ transport: recorder() });
    expect(after.sent).toBe(0);
    expect(after.remaining).toBe(0);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where status = 'SENDING'
    `;
    expect(n).toBe(3);

    // And the blast cannot be re-prepared for them either.
    const requeued = await queueBlast({ segmentId, templateKey: TEMPLATE });
    expect(requeued.queued).toBe(0);

    // The split still calls them pending, so the screen tells the admin there
    // is work the system has no way to do.
    const split = await blastSplit({ segmentId, templateKey: TEMPLATE });
    expect(split.pendingRegistrations).toBe(3);
  });
});

/* ------------------------------------------------- AC-11, AC-33, AC-35, AC-36 */
describe('addressing and stamping', () => {
  it('AC-11 sends one message per party carrying every seat', async () => {
    const { segmentId } = await seedWorld({ parties: 1, seatsEach: 4 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;

    const transport = recorder();
    await dispatchBatch({ transport });

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0].attachments).toHaveLength(4);
  });

  it('AC-36 queueing stamps nobody', async () => {
    const { segmentId } = await seedWorld({ parties: 2, seatsEach: 2 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees where ticket_sent_at is not null
    `;
    expect(n).toBe(0);
  });

  it('AC-33 a successful send stamps every seat it carried, source EMAIL', async () => {
    const { segmentId } = await seedWorld({ parties: 1, seatsEach: 3 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;
    await dispatchBatch({ transport: recorder() });

    const rows = await sql<{ ticket_sent_source: string | null }[]>`
      select ticket_sent_source from attendees where ticket_sent_at is not null
    `;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ticket_sent_source === 'EMAIL')).toBe(true);
  });

  /**
   * §11.4 point 4: "exactly the attendees whose PDFs were attached". A seat
   * added between render and dispatch must not be stamped by a message that
   * never carried it.
   */
  /**
   * **Rewritten after the finding it recorded was fixed.**
   *
   * As first written this asserted the defect: the party grew after review, so
   * the dispatcher attached three PDFs and stamped three seats while sending a
   * body still saying "2 ticket(s)". §11.5 forbids re-rendering at send time, so
   * the draft is simply stale, and the dispatcher now refuses it and asks for
   * the batch to be prepared again.
   *
   * Left here asserting the corrected behaviour rather than deleted, so the
   * shape of the original finding is still legible.
   */
  it('AC-35 refuses a draft whose party grew after it was reviewed', async () => {
    const { concertId, showId, segmentId, registrationIds } = await seedWorld({
      parties: 1,
      seatsEach: 2,
    });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;

    // A guest joins the party after the admin reviewed the message.
    await seedAttendees({
      registrationId: registrationIds[0],
      showId,
      segmentId,
      count: 1,
      allocationType: 'EXTRA',
    });
    await issueTickets({ concertId, showId });

    const transport = recorder();
    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(transport.messages).toHaveLength(0);

    // Nothing stamped, so the party stays pending rather than being lost.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees where ticket_sent_at is not null
    `;
    expect(n).toBe(0);

    const [row] = await sql<{ last_error: string }[]>`select last_error from email_outbox`;
    expect(row.last_error).toContain('2 seat(s) when the message was drafted');
  });
});

/* ------------------------------------------------------------ AC-12, AC-14 */
describe('AC-12 / AC-14 two rounds, no double-send', () => {
  it('the second blast reaches only the new party', async () => {
    const { concertId, showId, segmentId } = await seedWorld({ parties: 2, seatsEach: 2 });

    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;
    const round1 = recorder();
    await dispatchBatch({ transport: round1 });
    expect(round1.messages).toHaveLength(2);

    // Round 2 registration arrives.
    const late = await createRegistration({ showId, segmentId, contactName: 'Round two' });
    await sql`update registrations set contact_email = 'round2@example.test' where id = ${late}`;
    await seedAttendees({
      registrationId: late,
      showId,
      segmentId,
      count: 1,
      allocationType: 'BASE',
    });
    await issueTickets({ concertId, showId });

    // Prepare twice, exactly as an unsure admin would.
    const first = await queueBlast({ segmentId, templateKey: TEMPLATE });
    const second = await queueBlast({ segmentId, templateKey: TEMPLATE });
    expect({ first: first.queued, second: second.queued }).toEqual({ first: 1, second: 0 });

    await sql`update email_outbox set status = 'QUEUED' where status = 'DRAFT'`;
    const round2 = recorder();
    await dispatchBatch({ transport: round2 });

    expect(round2.messages.map((m) => m.to)).toEqual(['round2@example.test']);
  });
});

/* ------------------------------------------------------------------ AC-16 */
describe('AC-16 DRAFT is never dispatched', () => {
  it('sends nothing while the batch is still under review', async () => {
    const { segmentId } = await seedWorld({ parties: 2, seatsEach: 1 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    const transport = recorder();
    const result = await dispatchBatch({ transport });
    expect({ sent: result.sent, composed: transport.messages.length }).toEqual({
      sent: 0,
      composed: 0,
    });
  });
});

/* ------------------------------------------------------------------ AC-19 */
describe('AC-19 a template edit cannot reach a reviewed message', () => {
  it('leaves QUEUED and SENT rows byte-identical', async () => {
    const { segmentId } = await seedWorld({ parties: 2, seatsEach: 1 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;
    const before = await sql<{ id: string; subject: string; body_md: string }[]>`
      select id, subject, body_md from email_outbox order by id
    `;

    await editTemplateAndRerender({
      templateKey: TEMPLATE,
      subject: 'COMPLETELY DIFFERENT',
      bodyMd: 'Rewritten wording.',
      actorId: null,
    });

    const after = await sql<{ id: string; subject: string; body_md: string }[]>`
      select id, subject, body_md from email_outbox order by id
    `;
    expect(after).toEqual(before);
  });
});

/* ------------------------------------------------------------------ AC-23 */
describe('AC-23 the batch size comes from settings', () => {
  it('claims no more than email.max_per_dispatch and reports the rest', async () => {
    const { segmentId } = await seedWorld({ parties: 5, seatsEach: 1 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;
    await setSystemSetting('email.max_per_dispatch', 2);

    const result = await dispatchBatch({ transport: recorder() });
    expect({ sent: result.sent, remaining: result.remaining }).toEqual({ sent: 2, remaining: 3 });
  });
});

/* ------------------------------------------------------------------ AC-28 */
describe('AC-28 the daily cap defers rather than fails', () => {
  it('stops mid-queue once the day budget is spent, leaving rows QUEUED', async () => {
    const { segmentId } = await seedWorld({ parties: 4, seatsEach: 1 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;
    await setSystemSetting('email.max_per_day', 2);

    const first = await dispatchBatch({ transport: recorder() });
    const second = await dispatchBatch({ transport: recorder() });

    const statuses = await sql<{ status: string; n: number }[]>`
      select status, count(*)::int as n from email_outbox group by status order by status
    `;
    expect({
      firstSent: first.sent,
      secondSent: second.sent,
      secondCapped: second.dailyCapReached,
      statuses: statuses.map((s) => `${s.status}:${s.n}`),
    }).toEqual({
      firstSent: 2,
      secondSent: 0,
      secondCapped: true,
      statuses: ['QUEUED:2', 'SENT:2'],
    });
  });
});

/* ------------------------------------------------------------------ AC-25 */
describe('AC-25 progress is committed per message', () => {
  it('keeps the messages that got through when a later one fails', async () => {
    const { segmentId } = await seedWorld({ parties: 3, seatsEach: 1 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;

    let n = 0;
    const transport = recorder(() => {
      n += 1;
      if (n === 2) throw new Error('smtp died mid-batch');
    });
    const result = await dispatchBatch({ transport });

    const rows = await sql<{ status: string; n: number }[]>`
      select status, count(*)::int as n from email_outbox group by status order by status
    `;
    expect({
      sent: result.sent,
      failed: result.failed,
      rows: rows.map((r) => `${r.status}:${r.n}`),
    }).toEqual({ sent: 2, failed: 1, rows: ['QUEUED:1', 'SENT:2'] });
  });
});

/* ------------------------------------------------------------------ AC-49 */
describe('AC-49 attachments merge past email.merge_attachments_above', () => {
  it('a party of 9 with the setting at 8 sends one PDF', async () => {
    const { segmentId } = await seedWorld({ parties: 1, seatsEach: 9 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;

    const transport = recorder();
    await dispatchBatch({ transport });
    expect(transport.messages[0].attachments).toHaveLength(1);
  });

  it('a party of 8 with the setting at 8 sends eight PDFs', async () => {
    const { segmentId } = await seedWorld({ parties: 1, seatsEach: 8 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;

    const transport = recorder();
    await dispatchBatch({ transport });
    expect(transport.messages[0].attachments).toHaveLength(8);
  });
});

/* ------------------------------------------------------------------ AC-52 */
describe('AC-52 an unnamed attendee is not an error', () => {
  it('tickets and mails a placeholder seat', async () => {
    const { concertId, showId, segmentId, registrationIds } = await seedWorld({
      parties: 1,
      seatsEach: 1,
    });
    await withDirectAttendeeWrites(async (tx) => {
      await tx`
        insert into attendees (registration_id, show_id, segment_id, full_name, name_source,
                               allocation_type, status)
        values (${registrationIds[0]}, ${showId}, ${segmentId}, 'Guest of Party 1',
                'PLACEHOLDER', 'BASE', 'CONFIRMED')
      `;
    });
    await issueTickets({ concertId, showId });

    const queued = await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;
    const transport = recorder();
    const result = await dispatchBatch({ transport });

    expect({
      queued: queued.queued,
      sent: result.sent,
      attachments: transport.messages[0]?.attachments?.length,
    }).toEqual({ queued: 1, sent: 1, attachments: 2 });
  });
});

/* ------------------------------------------------------------ AC-43, AC-45 */
describe('AC-43 / AC-45 mark as delivered', () => {
  it('stamps MANUAL, writes audit, sends nothing, and clears the pending bucket', async () => {
    const { segmentId, registrationIds } = await seedWorld({ parties: 1, seatsEach: 2 });
    const ids = await sql<{ id: string }[]>`
      select id from attendees where registration_id = ${registrationIds[0]} order by id
    `;

    const result = await markDelivered({
      attendeeIds: ids.map((r) => Number(r.id)),
      reason: 'Handed over at the rehearsal',
      actorId: null,
    });

    const [{ outbox }] = await sql<{ outbox: number }[]>`
      select count(*)::int as outbox from email_outbox
    `;
    const [{ audit }] = await sql<{ audit: number }[]>`
      select count(*)::int as audit from audit_log where action = 'attendee.marked_delivered'
    `;
    const split = await blastSplit({ segmentId, templateKey: TEMPLATE });
    const sources = await sql<{ ticket_sent_source: string }[]>`
      select ticket_sent_source from attendees where ticket_sent_at is not null
    `;

    expect({
      marked: result.marked,
      outbox,
      audit,
      pending: split.pendingRegistrations,
      sources: sources.map((s) => s.ticket_sent_source),
    }).toEqual({ marked: 2, outbox: 0, audit: 1, pending: 0, sources: ['MANUAL', 'MANUAL'] });
  });
});

/* ------------------------------------------------------------------ AC-50 */
describe('AC-50 a message over email.max_attachment_mb', () => {
  /**
   * Untested by the branch: `email.max_attachment_mb` is set in the dispatch
   * suite's `beforeEach` but never driven. Gmail refuses the whole message, so
   * the failure has to name the size rather than surface as a bare SMTP error.
   */
  it('fails the row with a readable last_error and stamps nobody', async () => {
    const { segmentId, registrationIds } = await seedWorld({ parties: 1, seatsEach: 2 });
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;
    // Anything at all is over a zero-byte cap.
    await setSystemSetting('email.max_attachment_mb', 0);

    const transport = recorder();
    const result = await dispatchBatch({ transport });

    const [row] = await sql<{ status: string; last_error: string }[]>`
      select status, last_error from email_outbox
    `;
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from attendees
       where registration_id = ${registrationIds[0]} and ticket_sent_at is not null
    `;
    expect({
      sent: result.sent,
      failed: result.failed,
      composed: transport.messages.length,
      mentionsSize: /MB/.test(row.last_error),
      stamped: n,
    }).toEqual({ sent: 0, failed: 1, composed: 0, mentionsSize: true, stamped: 0 });
  });
});
