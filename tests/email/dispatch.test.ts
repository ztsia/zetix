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
import { purposeFor } from '@/lib/email/templates';
import { issueTickets } from '@/lib/tickets/issue';
import type { MailTransport, OutgoingMessage, SendResult } from '@/lib/mail/transport';

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
let partyCounter = 0;

async function seedParty(opts: { seats: number; subject?: string; templateKey?: string }) {
  // A distinct concert per party: `createConcert()` derives the slug from the
  // name, and a second "Test Concert" collides on it. Tests that queue several
  // parties at once need several concerts.
  const concertId = await createConcert(`Test Concert ${(partyCounter += 1)}`);
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
    insert into email_outbox (registration_id, purpose, template_key, to_email, to_name, subject,
                              body_md, status)
    values (${registrationId}, ${purposeFor(opts.templateKey ?? 'public_ticket')}::message_purpose,
            ${opts.templateKey ?? 'public_ticket'}, 'party@example.test', 'Party',
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
  partyCounter = 0;
  await setSystemSetting('email.max_per_dispatch', 25);
  await setSystemSetting('email.max_per_day', 450);
  await setSystemSetting('email.inter_message_delay_ms', 0);
  await setSystemSetting('email.max_attempts', 3);
  await setSystemSetting('email.merge_attachments_above', 8);
  await setSystemSetting('email.max_attachment_mb', 20);
});

/**
 * A dispatch has to stop before Vercel stops it (`dispatch.ts`'s
 * `SEND_WINDOW_MS`).
 *
 * A real blast of 244 went out ten at a time and then returned 504: sending is
 * serial, each message cost about six seconds against the one to two §11.1
 * assumes, and a batch of 25 simply did not fit in 60. Everything sent stayed
 * sent — but the rest of the claimed batch was left `SENDING`, where
 * `claimBatch()` cannot see it and `reclaimStranded()` will not touch it for ten
 * minutes, so pressing Send again did nothing and then timed out again.
 */
describe('staying inside the dispatch window', () => {
  it('stops starting messages once the window is spent', async () => {
    await seedParty({ seats: 1 });
    await seedParty({ seats: 1 });
    await seedParty({ seats: 1 });
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport, sendWindowMs: 0 });

    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(2);
    expect(transport.messages).toHaveLength(1);
  });

  /**
   * The first message always goes, whatever the clock says. Deferring the whole
   * batch would be a queue that never drains — and one message slower than the
   * window is exactly the case that needs to be attempted, not skipped.
   */
  it('always starts the first message', async () => {
    await seedParty({ seats: 1 });
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport, sendWindowMs: 0 });

    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(0);
  });

  it('hands the rest back as QUEUED, not left SENDING', async () => {
    await seedParty({ seats: 1 });
    await seedParty({ seats: 1 });
    await seedParty({ seats: 1 });

    await dispatchBatch({ transport: recordingTransport(), sendWindowMs: 0 });

    const rows = await sql<{ status: string }[]>`select status from email_outbox order by id`;
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'QUEUED', 'QUEUED']);
  });

  /**
   * The whole point of handing them back rather than leaving them to
   * `reclaimStranded()`: the next call must find them immediately. A ten-minute
   * wait reads, from the blast screen, as a blast that has stopped working.
   */
  it('lets the very next call send them', async () => {
    await seedParty({ seats: 1 });
    await seedParty({ seats: 1 });
    await seedParty({ seats: 1 });

    const first = await dispatchBatch({ transport: recordingTransport(), sendWindowMs: 0 });
    expect(first.remaining).toBe(2);

    const second = await dispatchBatch({ transport: recordingTransport() });

    expect(second.sent).toBe(2);
    expect(second.reclaimed).toBe(0);
    expect(second.remaining).toBe(0);
  });

  /**
   * The release is by id *and* still-`SENDING`, so a row that reached `SENT`
   * cannot be dragged back into the queue. Sending someone their tickets twice
   * is the one failure this module is built to prevent.
   */
  it('never hands back a row that was already sent', async () => {
    const { registrationId } = await seedParty({ seats: 2 });
    await seedParty({ seats: 1 });

    await dispatchBatch({ transport: recordingTransport(), sendWindowMs: 0 });

    const [row] = await sql<{ status: string }[]>`
      select status from email_outbox where registration_id = ${registrationId}
    `;
    expect(row.status).toBe('SENT');

    const stamps = await attendeeStamps(registrationId);
    for (const stamp of stamps) expect(stamp.ticket_sent_at).not.toBeNull();
  });

  it('sends the whole batch when there is time for it', async () => {
    await seedParty({ seats: 1 });
    await seedParty({ seats: 1 });
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(2);
    expect(result.deferred).toBe(0);
    expect(transport.messages).toHaveLength(2);
  });
});

/**
 * An address with a space in it is refused, not sent.
 *
 * `may _zxample@yahoo.com` was stored, composed into a `To:` header and
 * delivered — to `_zxample@yahoo.com`, because an address parser splits on the
 * space and keeps the last token, and that token was a real address belonging
 * to a stranger. Every layer behaved reasonably and a guest's tickets went to
 * the wrong person; a bounce would have been the *good* outcome.
 *
 * So the dispatcher refuses anything it cannot address unambiguously. The
 * import strips whitespace out of addresses now as well (`import/plan.ts`), but
 * a row can reach the outbox by other routes — typed into the admin, edited
 * afterwards — and this is the last place before a mailer sees it.
 */
describe('an address that cannot be addressed', () => {
  const seedWithAddress = async (toEmail: string) => {
    const { registrationId } = await seedParty({ seats: 1 });
    await sql`update email_outbox set to_email = ${toEmail} where registration_id = ${registrationId}`;
    return registrationId;
  };

  it('is not sent', async () => {
    await seedWithAddress('may _zxample@yahoo.com');
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(transport.messages).toHaveLength(0);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  /**
   * Straight to `FAILED`, not back to the queue: a space will not spell itself
   * out on the second attempt, and three retries only delay the moment an admin
   * sees it.
   */
  it('fails permanently rather than retrying', async () => {
    const registrationId = await seedWithAddress('may _zxample@yahoo.com');

    await dispatchBatch({ transport: recordingTransport() });

    const [row] = await sql<{ status: string; attempts: number; last_error: string }[]>`
      select status, attempts, last_error from email_outbox where registration_id = ${registrationId}
    `;
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('cannot contain a space');
  });

  it('stamps nothing, so the seats stay pending for a later blast', async () => {
    const registrationId = await seedWithAddress('may _zxample@yahoo.com');

    await dispatchBatch({ transport: recordingTransport() });

    const stamps = await attendeeStamps(registrationId);
    expect(stamps).toHaveLength(1);
    expect(stamps[0].ticket_sent_at).toBeNull();
  });

  it('does not hold up the rest of the batch', async () => {
    await seedWithAddress('may _zxample@yahoo.com');
    await seedParty({ seats: 1 });
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(transport.messages).toHaveLength(1);
  });

  it('still sends an ordinary address', async () => {
    await seedWithAddress('may_zxample@yahoo.com');
    const transport = recordingTransport();

    const result = await dispatchBatch({ transport });

    expect(result.sent).toBe(1);
    expect(transport.messages[0].to).toBe('may_zxample@yahoo.com');
  });
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
        insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md,
                                  status)
        values (${registrationId}, 'TICKETS', 'public_ticket', ${`p${i}@example.test`}, 's', 'b',
                'QUEUED')
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
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md,
                                status)
      values (${registrationId}, 'EXTRAS_DECISION', 'extras_declined', 'x@example.test', 's', 'b',
              'QUEUED')
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
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md,
                                status)
      values (${registrationId}, 'TICKETS', 'public_ticket', 'x@example.test', 's', 'b', 'QUEUED')
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

/**
 * spec/v3.md §23.6: a message in the Trash is not sent. Messages › Delete
 * cancels before it deletes; this is the dispatcher's own refusal, for a row
 * that reached the Trash any other way.
 */
describe('a queued message in the Trash', () => {
  it('is neither claimed nor counted in the backlog', async () => {
    const { registrationId } = await seedParty({ seats: 1 });
    await sql`update email_outbox set deleted_at = now() where registration_id = ${registrationId}`;

    const transport = recordingTransport();
    const result = await dispatchBatch({ transport });

    expect(transport.messages).toHaveLength(0);
    expect(result.remaining).toBe(0);
    expect(result.backlog.resumable).toBe(0);
    const [row] = await sql<{ status: string }[]>`
      select status from email_outbox where registration_id = ${registrationId}
    `;
    expect(row.status).toBe('QUEUED');
  });
});
