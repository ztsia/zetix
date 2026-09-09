import { beforeEach, describe, expect, it } from 'vitest';
import { newConnection, resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  setSystemSetting,
} from '../helpers/fixtures';
import { MAX_DISPATCH_SECONDS, dispatchBatch } from '@/lib/email/dispatch';
import { blastSplit, queueBlast } from '@/lib/email/queue';
import { issueTickets } from '@/lib/tickets/issue';
import type { MailTransport } from '@/lib/email/transport';

/**
 * The properties an independent QA pass found were **defended by clauses no test
 * protected** — deleting `for update skip locked`, or swapping the
 * `concert.timezone` day boundary for UTC, both left the suite green.
 *
 * A guard nothing tests is a guard the next person deletes, so these live in
 * `tests/` where CI runs them rather than in `qa/`, which it does not.
 */

const TEMPLATE = 'public_ticket';

function recorder(): MailTransport {
  return {
    async send(message) {
      return {
        accepted: [message.to],
        rejected: [],
        response: '250 ok',
        messageId: '<t>',
        raw: null,
      };
    },
    async close() {},
  };
}

async function seedWorld(parties: number) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (${TEMPLATE}, 'Public ticket', 'Tickets', 'Hello {{ registration.contact_name }}')
  `;
  for (let i = 0; i < parties; i++) {
    const registrationId = await createRegistration({ showId, segmentId, contactName: `P${i + 1}` });
    await seedAttendees({ registrationId, showId, segmentId, count: 1, allocationType: 'BASE' });
  }
  // `public_ticket` is ticket-bearing (§11.3), so the dispatcher renders a PDF
  // per seat and refuses a party whose tickets were never issued.
  await issueTickets({ concertId, showId });
  await queueBlast({ segmentId, templateKey: TEMPLATE });
  await sql`update email_outbox set status = 'QUEUED'`;
  return { concertId, showId, segmentId };
}

/**
 * Backdates `updated_at` past the `email_outbox_set_updated_at` trigger.
 *
 * The trigger rewrites `updated_at` to `now()` on **every** update, which is
 * precisely what makes it a trustworthy claim time in production — a row sitting
 * in `SENDING` was last written when it was claimed. It also means a test cannot
 * age a row with an ordinary UPDATE, so the trigger is disabled for that one
 * statement rather than the column being worked around.
 */
async function ageSendingRows(seconds: number) {
  await sql`alter table email_outbox disable trigger email_outbox_set_updated_at`;
  await sql`
    update email_outbox
       set updated_at = now() - (interval '1 second' * ${seconds})
     where status = 'SENDING'
  `;
  await sql`alter table email_outbox enable trigger email_outbox_set_updated_at`;
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

describe('two dispatchers contending for the same queue', () => {
  /**
   * **Sequential calls prove nothing about `for update skip locked`.** The pool
   * is `max: 1`, so two `dispatchBatch()` calls serialise and the clause is
   * never exercised — which is exactly why deleting it left the suite green.
   *
   * This opens two real connections and holds the first claim's lock open while
   * the second runs, the only shape in which the clause matters. Without it the
   * second claimer blocks and then re-reads the same rows, and a double claim is
   * a double send.
   */
  it('never hands the same row to two claimers', async () => {
    await seedWorld(4);

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
        from claimed where o.id = claimed.id and o.status = 'QUEUED'
      returning o.id
    `;

    try {
      const [first, second] = await Promise.all([
        a.begin(async (tx) => {
          const rows = (await tx.unsafe(CLAIM)) as unknown as { id: string }[];
          await tx.unsafe('select pg_sleep(0.5)');
          return rows.map((r) => Number(r.id));
        }),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return b.begin(async (tx) => {
            const rows = (await tx.unsafe(CLAIM)) as unknown as { id: string }[];
            return rows.map((r) => Number(r.id));
          });
        })(),
      ]);

      const overlap = (first as number[]).filter((id) => (second as number[]).includes(id));
      expect(overlap, 'the same row was claimed twice — that is a double send').toEqual([]);
      expect([...(first as number[]), ...(second as number[])]).toHaveLength(4);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe('a dispatch that dies mid-batch', () => {
  /**
   * `claimBatch()` flips a whole batch to `SENDING` up front and then sends
   * serially, so a function timeout, a deploy or a crash leaves every unsent row
   * of that batch in `SENDING`. The partial unique index covers `SENDING`, so
   * the registration cannot be re-prepared either — §11.4's "nobody must be
   * silently skipped", with no way out from the UI.
   */
  it('recovers rows stranded longer than a dispatch can possibly run', async () => {
    const { segmentId } = await seedWorld(3);

    // Exactly what a timed-out invocation leaves behind.
    await sql`update email_outbox set status = 'SENDING'`;
    await ageSendingRows(MAX_DISPATCH_SECONDS * 20);

    // Before the fix this was the trap: nothing queued, nothing sent, and the
    // split still counting them pending.
    const stuck = await blastSplit({ segmentId, templateKey: TEMPLATE });
    expect(stuck.pendingRegistrations).toBe(3);

    const result = await dispatchBatch({ transport: recorder() });

    expect(result.reclaimed).toBe(3);
    expect(result.sent).toBe(3);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where status = 'SENT'
    `;
    expect(n).toBe(3);
  });

  /**
   * The other half, and the reason the window is generous: a row belonging to a
   * dispatch that is still running must never be taken back, or two functions
   * send the same message.
   */
  it('leaves a row alone while a dispatch could still be using it', async () => {
    await seedWorld(2);
    await sql`update email_outbox set status = 'SENDING', updated_at = now()`;

    const result = await dispatchBatch({ transport: recorder() });

    expect(result.reclaimed).toBe(0);
    expect(result.sent).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where status = 'SENDING'
    `;
    expect(n).toBe(2);
  });

  /**
   * Reclaiming must never touch delivery. `ticket_sent_at` is written only in
   * the transaction that marks a row SENT, so a row that died before that point
   * delivered nothing and is safe to send again.
   */
  it('does not stamp or unstamp anything when it reclaims', async () => {
    await seedWorld(2);
    await sql`update email_outbox set status = 'SENDING'`;
    await ageSendingRows(MAX_DISPATCH_SECONDS * 20);

    await dispatchBatch({ transport: recorder() });

    const rows = await sql<{ ticket_sent_source: string | null }[]>`
      select ticket_sent_source from attendees
    `;
    // They send on this same run, so EMAIL — never MANUAL, and never null.
    for (const row of rows) expect(row.ticket_sent_source).toBe('EMAIL');
  });
});

describe('the daily cap is counted in the concert timezone', () => {
  /**
   * §11.1 counts `email.max_per_day` in `concert.timezone` days, and swapping
   * that for UTC left the whole suite green.
   *
   * **The two boundaries only disagree inside one window**, so a test has to
   * put a message in it. Asia/Singapore is UTC+8, so the venue's midnight is
   * 16:00 UTC the previous day — *earlier* than UTC's. A message sent an hour
   * after the venue's midnight therefore falls:
   *
   * - **inside** today, counted, if the boundary is the venue's — correct;
   * - **before** today, uncounted, if the boundary is UTC — the bug.
   *
   * With a cap of one, the correct reading has already spent the budget and
   * defers the rest to tomorrow (§11.1); the broken one sends.
   */
  it('spends the budget on a message already sent today at the venue', async () => {
    await seedWorld(1);

    await sql`
      insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status, sent_at)
      select registration_id, 'reminder', to_email, 's', 'b', 'SENT',
             (date_trunc('day', now() at time zone 'Asia/Singapore') at time zone 'Asia/Singapore')
               + interval '1 hour'
        from email_outbox limit 1
    `;
    await setSystemSetting('email.max_per_day', 1);

    const result = await dispatchBatch({ transport: recorder() });

    expect(result.dailyCapReached).toBe(true);
    expect(result.sent).toBe(0);
  });

  /** The other side of the same boundary: yesterday at the venue does not count. */
  it('does not spend it on a message from the venue’s previous day', async () => {
    await seedWorld(1);

    await sql`
      insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status, sent_at)
      select registration_id, 'reminder', to_email, 's', 'b', 'SENT',
             (date_trunc('day', now() at time zone 'Asia/Singapore') at time zone 'Asia/Singapore')
               - interval '1 hour'
        from email_outbox limit 1
    `;
    await setSystemSetting('email.max_per_day', 1);

    const result = await dispatchBatch({ transport: recorder() });

    expect(result.dailyCapReached).toBe(false);
    expect(result.sent).toBe(1);
  });
});
