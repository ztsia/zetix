import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  setSystemSetting,
} from '../helpers/fixtures';
import { dispatchBatch } from '@/lib/email/dispatch';
import { issueTickets } from '@/lib/tickets/issue';
import type { MailTransport, OutgoingMessage, SendResult } from '@/lib/email/transport';

/**
 * The dispatcher (spec/email.md §11.2, §11.4 mechanism 4).
 *
 * The property that matters most here is **"partial delivery does not exist"**:
 * either the message sent and all its tickets are stamped, or it failed and
 * none are. A stamp on an undelivered ticket is unrecoverable in the way that
 * matters — that seat never appears in a blast again, and the guest finds out
 * at the door.
 *
 * A recording transport stands in for Gmail. It composes through the same
 * nodemailer path the real one does (`tests/email/transport.test.ts` proves the
 * bytes are identical), and SMTP is blocked from any container anyway
 * (`local.md` §7).
 */

type Recorder = MailTransport & { messages: OutgoingMessage[]; closed: number };

function recordingTransport(behaviour?: (m: OutgoingMessage) => Partial<SendResult> | void): Recorder {
  const messages: OutgoingMessage[] = [];
  const state = { closed: 0 };
  return {
    messages,
    get closed() {
      return state.closed;
    },
    async send(message) {
      messages.push(message);
      const override = behaviour?.(message) ?? {};
      return {
        accepted: [message.to],
        rejected: [],
        response: '250 ok',
        messageId: '<test>',
        raw: null,
        ...override,
      };
    },
    async close() {
      state.closed += 1;
    },
  };
}

/**
 * A party with **issued** tickets, because `public_ticket` is ticket-bearing
 * (§11.3) and the dispatcher renders a PDF per seat. `issueTickets()` is module
 * `D`'s, and pinning the template at issue time is what makes `loadTicket()`
 * return anything at all.
 */
async function seedParty(opts: { seats: number; subject?: string; templateKey?: string }) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  const registrationId = await createRegistration({ showId, segmentId, contactName: 'Party' });
  await seedAttendees({
    registrationId,
    showId,
    segmentId,
    count: opts.seats,
    allocationType: 'BASE',
  });
  await issueTickets({ concertId, showId });
  await sql`
    insert into email_outbox (registration_id, template_key, to_email, to_name, subject, body_md, status)
    values (${registrationId}, ${opts.templateKey ?? 'public_ticket'}, 'party@example.test', 'Party',
            ${opts.subject ?? 'Your tickets'}, 'Hello **Party**', 'QUEUED')
  `;
  return { concertId, showId, segmentId, registrationId };
}

async function attendeeStamps(registrationId: number) {
  return sql<{ ticket_sent_at: string | null; ticket_sent_source: string | null }[]>`
    select ticket_sent_at, ticket_sent_source from attendees
     where registration_id = ${registrationId} order by id
  `;
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

describe('a successful send', () => {
  it('marks the row SENT and stamps every seat it carried', async () => {
    const { registrationId } = await seedParty({ seats: 3 });
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    const [row] = await sql<{ status: string; sent_at: string | null }[]>`
      select status, sent_at from email_outbox
    `;
    expect(row.status).toBe('SENT');
    expect(row.sent_at).not.toBeNull();

    const stamps = await attendeeStamps(registrationId);
    expect(stamps).toHaveLength(3);
    for (const stamp of stamps) {
      expect(stamp.ticket_sent_at).not.toBeNull();
      expect(stamp.ticket_sent_source).toBe('EMAIL');
    }
  });

  it('sends the reviewed subject and body verbatim', async () => {
    await seedParty({ seats: 1, subject: 'Edited by the admin' });
    const transport = recordingTransport();

    await dispatchBatch({ transport });

    // §11.5: what was reviewed is what goes out. Only the HTML and plain-text
    // renderings are derived, and both from the stored Markdown.
    expect(transport.messages[0].subject).toBe('Edited by the admin');
    expect(transport.messages[0].html).toContain('<strong>Party</strong>');
    expect(transport.messages[0].text).toBe('Hello Party');
  });

  it('closes the transport when the batch is done', async () => {
    await seedParty({ seats: 1 });
    const transport = recordingTransport();
    await dispatchBatch({ transport });
    expect(transport.closed).toBe(1);
  });
});

describe('partial delivery does not exist', () => {
  it('stamps nothing when the send throws', async () => {
    const { registrationId } = await seedParty({ seats: 2 });
    const transport = recordingTransport(() => {
      throw new Error('smtp exploded');
    });

    const result = await dispatchBatch({ transport });

    expect(result.failed).toBe(1);
    for (const stamp of await attendeeStamps(registrationId)) {
      expect(stamp.ticket_sent_at).toBeNull();
      expect(stamp.ticket_sent_source).toBeNull();
    }
  });

  /**
   * The subtle one. A server can answer without refusing outright and still
   * have accepted nobody; reading that as success would stamp tickets nobody
   * received, and those seats would never appear in a blast again.
   */
  it('treats a send that accepted no recipient as a failure', async () => {
    const { registrationId } = await seedParty({ seats: 2 });
    const transport = recordingTransport(() => ({ accepted: [], response: '451 try later' }));

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    for (const stamp of await attendeeStamps(registrationId)) {
      expect(stamp.ticket_sent_at).toBeNull();
    }
    const [row] = await sql<{ last_error: string | null }[]>`select last_error from email_outbox`;
    expect(row.last_error).toContain('451');
  });
});

describe('retry and give-up', () => {
  it('returns a failed message to the queue with a later schedule', async () => {
    await seedParty({ seats: 1 });
    const transport = recordingTransport(() => {
      throw new Error('transient');
    });

    await dispatchBatch({ transport });

    const [row] = await sql<{ status: string; attempts: number; scheduled_for: string | null }[]>`
      select status, attempts, scheduled_for from email_outbox
    `;
    expect(row.status).toBe('QUEUED');
    expect(row.attempts).toBe(1);
    expect(row.scheduled_for).not.toBeNull();
  });

  it('gives up at email.max_attempts and surfaces the error', async () => {
    await seedParty({ seats: 1 });
    await sql`update email_outbox set attempts = 2`;
    const transport = recordingTransport(() => {
      throw new Error('still broken');
    });

    await dispatchBatch({ transport });

    const [row] = await sql<{ status: string; attempts: number; last_error: string }[]>`
      select status, attempts, last_error from email_outbox
    `;
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(3);
    expect(row.last_error).toContain('still broken');
  });

  it('does not pick up a row whose retry is still in the future', async () => {
    await seedParty({ seats: 1 });
    await sql`update email_outbox set scheduled_for = now() + interval '1 hour'`;
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });
    expect(result.sent).toBe(0);
    expect(transport.messages).toHaveLength(0);
  });
});

describe('what the dispatcher will not touch', () => {
  /** §11.2: only a human moves a row out of DRAFT. */
  it('never dispatches a DRAFT row', async () => {
    await seedParty({ seats: 1 });
    await sql`update email_outbox set status = 'DRAFT'`;
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(0);
    expect(transport.messages).toHaveLength(0);
    const [row] = await sql<{ status: string }[]>`select status from email_outbox`;
    expect(row.status).toBe('DRAFT');
  });

  it('never dispatches a cancelled row', async () => {
    await seedParty({ seats: 1 });
    await sql`update email_outbox set status = 'CANCELLED'`;
    const transport = recordingTransport();
    expect((await dispatchBatch({ transport })).sent).toBe(0);
  });
});

describe('the caps', () => {
  it('claims no more than email.max_per_dispatch in one call', async () => {
    const { concertId, showId, segmentId } = await seedParty({ seats: 1 });
    for (let i = 0; i < 4; i++) {
      const registrationId = await createRegistration({ showId, segmentId, contactName: `P${i}` });
      await seedAttendees({ registrationId, showId, segmentId, count: 1, allocationType: 'BASE' });
      await issueTickets({ concertId, showId });
      await sql`
        insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
        values (${registrationId}, 'public_ticket', ${`p${i}@example.test`}, 's', 'b', 'QUEUED')
      `;
    }
    await setSystemSetting('email.max_per_dispatch', 2);
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(2);
    // The UI keeps calling until the queue drains (§11.2).
    expect(result.remaining).toBe(3);
  });

  /**
   * §11.1: exceeding a provider cap defers the remainder to the next day
   * rather than failing. The day is counted in `concert.timezone`.
   */
  it('stops at email.max_per_day and says so', async () => {
    await seedParty({ seats: 1 });
    await setSystemSetting('email.max_per_day', 0);
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(0);
    expect(result.dailyCapReached).toBe(true);
    expect(transport.messages).toHaveLength(0);
  });
});

describe('templates that carry no tickets', () => {
  /**
   * §11.3: `public_verify` is a verification link, `extras_declined` and
   * `registration_cancelled` carry nothing. Attaching a PDF to the message that
   * tells someone they have no seat would be absurd; **stamping
   * `ticket_sent_at` from one would be worse**, because that column means the
   * ticket was delivered, and the seat would silently leave the pending bucket
   * of every future blast.
   */
  it('sends with no attachments and stamps nothing', async () => {
    const { registrationId } = await seedParty({
      seats: 2,
      templateKey: 'registration_cancelled',
    });
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(1);
    expect(transport.messages[0].attachments ?? []).toHaveLength(0);
    for (const stamp of await attendeeStamps(registrationId)) {
      expect(stamp.ticket_sent_at).toBeNull();
    }
  });

  it('still sends when the party has no issued ticket at all', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 400);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    const registrationId = await createRegistration({ showId, segmentId, contactName: 'Nobody' });
    await seedAttendees({ registrationId, showId, segmentId, count: 1, allocationType: 'BASE' });
    await sql`
      insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
      values (${registrationId}, 'extras_declined', 'x@example.test', 's', 'b', 'QUEUED')
    `;
    const transport = recordingTransport();

    expect((await dispatchBatch({ transport })).sent).toBe(1);
  });
});

describe('a ticket-bearing template with nothing to attach', () => {
  /**
   * The inverse, and it must fail loudly rather than send. A party told their
   * tickets are attached, receiving a message with none, arrives at the door
   * with nothing.
   */
  it('fails the message rather than sending a ticket email with no ticket', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 400);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    const registrationId = await createRegistration({ showId, segmentId, contactName: 'Unissued' });
    await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });
    await sql`
      insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
      values (${registrationId}, 'public_ticket', 'x@example.test', 's', 'b', 'QUEUED')
    `;
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(transport.messages).toHaveLength(0);
    const [row] = await sql<{ last_error: string }[]>`select last_error from email_outbox`;
    expect(row.last_error).toContain('no issued ticket');
  });
});

describe('the reviewed message must match what is attached', () => {
  /**
   * The body is rendered when the batch is prepared; the PDFs are built at
   * dispatch. A seat added in between leaves a message that says "2 ticket(s)"
   * carrying three — and §11.4's added-guest case makes that a normal event.
   *
   * Re-rendering at dispatch is not available: §11.5 requires the stored text to
   * go out verbatim. So the draft is stale, and refusing it costs one click
   * where sending costs a guest arriving with a ticket the email never mentioned.
   */
  it('refuses a draft whose party has grown since it was reviewed', async () => {
    const { concertId, showId, segmentId, registrationId } = await seedParty({ seats: 2 });
    await sql`update email_outbox set context = ${'{"attendee_count":"2"}'}::jsonb`;

    await seedAttendees({ registrationId, showId, segmentId, count: 1, allocationType: 'EXTRA' });
    await issueTickets({ concertId, showId });

    const transport = recordingTransport();
    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(transport.messages).toHaveLength(0);
    const [row] = await sql<{ last_error: string }[]>`select last_error from email_outbox`;
    expect(row.last_error).toContain('2 seat(s) when the message was drafted');

    // And nothing was stamped, so the party is still pending rather than lost.
    for (const stamp of await attendeeStamps(registrationId)) {
      expect(stamp.ticket_sent_at).toBeNull();
    }
  });

  it('sends normally when the party is unchanged', async () => {
    const { registrationId } = await seedParty({ seats: 2 });
    await sql`update email_outbox set context = ${'{"attendee_count":"2"}'}::jsonb`;

    const transport = recordingTransport();
    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(1);
    expect(transport.messages[0].attachments).toHaveLength(2);
    expect(registrationId).toBeGreaterThan(0);
  });
});
