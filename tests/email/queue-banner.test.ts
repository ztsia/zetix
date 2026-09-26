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
import { MAX_DISPATCH_SECONDS, dispatchBatch, outboxBacklog } from '@/lib/email/dispatch';
import { queueBlast } from '@/lib/email/queue';
import { issueTickets } from '@/lib/tickets/issue';
import type { MailTransport } from '@/lib/email/transport';

/**
 * What the queue banner reads (spec/email.md §11.2.1).
 *
 * The banner exists to end one failure: **a blast that stops halfway looks
 * exactly like one that finished**. Every property here is a way of getting
 * that silence back, so each test asserts a number the banner would show an
 * admin, not an internal detail.
 */

const TEMPLATE = 'public_ticket';

/** An outbox with nothing outstanding — the state in which the banner hides. */
const EMPTY = { resumable: 0, retrying: 0, inFlight: 0, failed: 0 };

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
  await issueTickets({ concertId, showId });
  await queueBlast({ segmentId, templateKey: TEMPLATE });
  return { concertId, showId, segmentId };
}

/** See `dispatch-recovery.test.ts` — the `updated_at` trigger has to be stood down to age a row. */
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

describe('the backlog the queue banner renders', () => {
  it('shows nothing on a console with an empty outbox', async () => {
    expect(await outboxBacklog()).toEqual(EMPTY);
  });

  /**
   * **A `DRAFT` is not unfinished work.** Preparing a blast renders messages and
   * sends nothing (§11.5); only a human moves them to `QUEUED`. A banner that
   * counted drafts would nag about a batch nobody has confirmed, and would offer
   * Resume for rows the dispatcher is forbidden to touch.
   */
  it('ignores drafts, which no dispatcher may send', async () => {
    await seedWorld(3);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where status = 'DRAFT'
    `;
    expect(n, 'queueBlast should leave the batch in DRAFT').toBe(3);

    expect(await outboxBacklog()).toEqual(EMPTY);
  });

  it('counts confirmed, queued messages as resumable', async () => {
    await seedWorld(3);
    await sql`update email_outbox set status = 'QUEUED'`;

    expect(await outboxBacklog()).toEqual({ ...EMPTY, resumable: 3 });
  });

  it('ignores messages that have already been delivered', async () => {
    await seedWorld(3);
    await sql`update email_outbox set status = 'SENT', sent_at = now()`;

    expect(await outboxBacklog()).toEqual(EMPTY);
  });

  /**
   * A row out of attempts is a ticket nobody received. Nothing retries it and
   * Resume cannot reach it, so it is reported in its own bucket — clearing the
   * banner over it would be the silence §11.2.1 exists to end, and counting it
   * as resumable would offer a button that cannot deliver it.
   */
  it('reports a permanently failed message without calling it resumable', async () => {
    await seedWorld(3);
    await sql`update email_outbox set status = 'FAILED', attempts = 3`;

    expect(await outboxBacklog()).toEqual({ ...EMPTY, failed: 3 });
  });

  /**
   * **The silence this branch exists to end, in its nastiest form.**
   *
   * A dispatch that dies mid-batch leaves up to `email.max_per_dispatch` rows in
   * `SENDING`, not `QUEUED`. A banner counting only `QUEUED` would report zero
   * and hide itself while those messages sat undelivered — the halted blast
   * looking exactly like a finished one, which is the whole bug.
   */
  it('counts rows stranded by a dead dispatch, which a QUEUED-only count would hide', async () => {
    await seedWorld(3);
    await sql`update email_outbox set status = 'SENDING'`;
    await ageSendingRows(MAX_DISPATCH_SECONDS * 20);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where status = 'QUEUED'
    `;
    expect(n, 'the trap: nothing is QUEUED, yet nothing has been delivered').toBe(0);

    expect(await outboxBacklog()).toEqual({ ...EMPTY, resumable: 3 });
  });

  /**
   * The other half. A row a dispatch is still using cannot be reclaimed yet, so
   * Resume cannot send it — and a Resume button that does nothing reads as a
   * broken one. It is reported as in flight instead, which the banner renders
   * without offering Resume.
   */
  it('reports a row a dispatch could still be using as in flight, not resumable', async () => {
    await seedWorld(2);
    await sql`update email_outbox set status = 'SENDING', updated_at = now()`;

    expect(await outboxBacklog()).toEqual({ ...EMPTY, inFlight: 2 });
  });

  /**
   * The teeth: the number on the banner has to be the number Resume actually
   * sends. A count that merely looks plausible is what lets the banner say
   * "3 queued" over an outbox that will deliver two.
   */
  it('agrees with what a resumed dispatch delivers, and clears once it has', async () => {
    await seedWorld(3);
    await sql`update email_outbox set status = 'SENDING'`;
    await ageSendingRows(MAX_DISPATCH_SECONDS * 20);

    const before = await outboxBacklog();
    expect(before.resumable).toBe(3);

    // Exactly what pressing Resume does.
    const result = await dispatchBatch({ transport: recorder() });
    expect(result.sent).toBe(before.resumable);

    expect(await outboxBacklog()).toEqual(EMPTY);
  });

  /**
   * A failed message backs off and returns to `QUEUED` with `scheduled_for` in
   * the future (§11.2). It is still unfinished work and still belongs on the
   * banner — but **not as resumable**: `claimBatch()` skips a row that is not
   * due, so a Resume offered for it would do nothing however often it is
   * pressed, which is the daily cap's mistake in another costume.
   */
  it('holds a backing-off message apart from the ones Resume could send', async () => {
    await seedWorld(1);
    await sql`
      update email_outbox
         set status = 'QUEUED', attempts = 1, scheduled_for = now() + interval '1 minute'
    `;

    expect(await outboxBacklog()).toEqual({ ...EMPTY, retrying: 1 });
  });

  /**
   * The teeth on that split: the claim query and the banner have to agree about
   * what "due" means, or the number goes back to promising what the dispatcher
   * will not do. A row whose backoff has elapsed is resumable again.
   */
  it('agrees with the claim query about which rows are due', async () => {
    await seedWorld(2);
    await sql`
      update email_outbox
         set status = 'QUEUED', attempts = 1,
             scheduled_for = case when id = (select min(id) from email_outbox)
                                  then now() - interval '1 minute'
                                  else now() + interval '1 minute' end
    `;

    expect(await outboxBacklog()).toEqual({ ...EMPTY, resumable: 1, retrying: 1 });

    // And a dispatch delivers exactly the one the banner called resumable.
    const result = await dispatchBatch({ transport: recorder() });
    expect(result.sent).toBe(1);
    expect(await outboxBacklog()).toEqual({ ...EMPTY, retrying: 1 });
  });
});

/**
 * spec/v3.md §24.5, `local.md` §14.1: the banner once reported 34 failed
 * messages on a concert that had none. The backlog is counted for the concert
 * in view; the dispatcher still works the whole queue.
 */
describe('the backlog of one concert', () => {
  it('counts only that concert’s messages, party- and player-addressed', async () => {
    const { concertId } = await seedWorld(2);
    await sql`update email_outbox set status = 'QUEUED' where status = 'DRAFT'`;
    const other = await createConcert('Another concert');
    const [player] = await sql<{ id: string }[]>`
      insert into players (concert_id, full_name, email, invite_token)
      values (${concertId}, 'Pat', 'pat@example.test', 'tok-pat') returning id`;
    await sql`insert into email_outbox (player_id, purpose, template_key, to_email, subject, body_md, status)
              values (${player.id}, 'NOTES_DIGEST', 'player_notes_digest', 'pat@example.test', 's', 'b', 'FAILED')`;

    expect(await outboxBacklog(concertId)).toEqual({ ...EMPTY, resumable: 2, failed: 1 });
    expect(await outboxBacklog(other)).toEqual(EMPTY);
    expect(await outboxBacklog()).toEqual({ ...EMPTY, resumable: 2, failed: 1 });

    // A dispatch asked for the other concert's backlog still sends this one's mail.
    const result = await dispatchBatch({ transport: recorder(), backlogConcertId: other });
    expect(result.sent).toBe(2);
    expect(result.backlog).toEqual(EMPTY);
  });
});
