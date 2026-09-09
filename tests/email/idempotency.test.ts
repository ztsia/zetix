import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';
import { blastSplit, queueBlast } from '@/lib/email/queue';

/**
 * **Pressing Send twice must be harmless** (spec/email.md §11.4, decision 16,
 * `CLAUDE.md`). This file is the primary test case for that, and it was written
 * before the implementation.
 *
 * The property is not "the UI disables the button". It is a database property,
 * which is why it can be proved here with no network at all: `ticket_sent_at`
 * as the dedup key, a filtered insert whose `exists` clause selects only
 * registrations that still have an undelivered seat, and the partial unique
 * index on pending rows that makes `on conflict do nothing` mean something.
 *
 * Take away any one of the three and something below turns red.
 */

const TEMPLATE = 'public_ticket';

async function seedTemplate() {
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (
      ${TEMPLATE}, 'Public ticket',
      'Your tickets for {{ concert.name }}',
      'Hello {{ registration.contact_name }}, {{ attendee_count }} ticket(s) attached.'
    )
    on conflict (key) do update set subject = excluded.subject
  `;
}

/** One show, one public segment, and `parties` registrations of two seats each. */
async function seedSegment(parties: number) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });

  const registrationIds: number[] = [];
  for (let i = 0; i < parties; i++) {
    const registrationId = await createRegistration({
      showId,
      segmentId,
      contactName: `Party ${i + 1}`,
    });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: 2,
      allocationType: 'BASE',
    });
    registrationIds.push(registrationId);
  }
  return { concertId, showId, segmentId, registrationIds };
}

const countRows = async (segmentId: number) => {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from email_outbox o
      join registrations r on r.id = o.registration_id
     where r.segment_id = ${segmentId}
  `;
  return n;
};

beforeEach(async () => {
  await resetDb();
  await seedTemplate();
});

describe('pressing Send twice', () => {
  it('queues nothing the second time', async () => {
    const { segmentId } = await seedSegment(3);

    const first = await queueBlast({ segmentId, templateKey: TEMPLATE });
    const second = await queueBlast({ segmentId, templateKey: TEMPLATE });

    expect(first.queued).toBe(3);
    // The whole point. An admin unsure whether the first click registered
    // clicks again, and the second click is a no-op rather than 3 more messages.
    expect(second.queued).toBe(0);
    expect(await countRows(segmentId)).toBe(3);
  });

  it('is still a no-op once the batch has moved on to QUEUED', async () => {
    const { segmentId } = await seedSegment(2);
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'QUEUED'`;

    expect((await queueBlast({ segmentId, templateKey: TEMPLATE })).queued).toBe(0);
    expect(await countRows(segmentId)).toBe(2);
  });

  it('is still a no-op mid-dispatch, while a row is SENDING', async () => {
    const { segmentId } = await seedSegment(2);
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'SENDING'`;

    expect((await queueBlast({ segmentId, templateKey: TEMPLATE })).queued).toBe(0);
    expect(await countRows(segmentId)).toBe(2);
  });
});

describe('the message is addressed to a registration, never a seat', () => {
  /**
   * Decision 22. A party of two produces **one** message, not two — guests are
   * frequently unaddressable (`v2.md` §8.1) and the registrant forwards the
   * PDFs. It is also the only shape in which the partial unique index bites: a
   * nullable `attendee_id` never conflicts with itself in Postgres.
   */
  it('writes one row per party, whatever the party size', async () => {
    const { segmentId, registrationIds } = await seedSegment(2);
    await queueBlast({ segmentId, templateKey: TEMPLATE });

    const rows = await sql<{ registration_id: string }[]>`
      select registration_id from email_outbox order by registration_id
    `;
    expect(rows.map((r) => Number(r.registration_id))).toEqual(registrationIds);
  });
});

describe('who a blast selects', () => {
  it('skips a registration whose every seat is already delivered', async () => {
    const { segmentId, registrationIds } = await seedSegment(2);
    await sql`
      update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
       where registration_id = ${registrationIds[0]}
    `;

    const result = await queueBlast({ segmentId, templateKey: TEMPLATE });

    expect(result.queued).toBe(1);
    const rows = await sql<{ registration_id: string }[]>`select registration_id from email_outbox`;
    expect(Number(rows[0].registration_id)).toBe(registrationIds[1]);
  });

  /**
   * §11.4's added-guest case, and it is a *feature*: the fourth guest joins a
   * party whose first tickets are already out, so the party is selected again
   * and receives one message carrying everything they hold.
   *
   * A `SENT` row does not block this — the partial unique index covers only
   * DRAFT/QUEUED/SENDING — which is exactly why the index is partial.
   */
  it('re-queues a party that gained a seat after its first message went out', async () => {
    const { showId, segmentId, registrationIds } = await seedSegment(1);
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'SENT', sent_at = now()`;
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'`;

    await seedAttendees({
      registrationId: registrationIds[0],
      showId,
      segmentId,
      count: 1,
      allocationType: 'EXTRA',
    });

    expect((await queueBlast({ segmentId, templateKey: TEMPLATE })).queued).toBe(1);
    expect(await countRows(segmentId)).toBe(2);
  });

  it('ignores seats that are not confirmed, and soft-deleted ones', async () => {
    const { showId, segmentId } = await seedSegment(0);
    const waitlisted = await createRegistration({ showId, segmentId, contactName: 'Waitlisted' });
    await seedAttendees({
      registrationId: waitlisted,
      showId,
      segmentId,
      count: 1,
      allocationType: 'EXTRA',
      status: 'WAITLIST',
    });

    const deleted = await createRegistration({ showId, segmentId, contactName: 'Deleted seat' });
    await seedAttendees({
      registrationId: deleted,
      showId,
      segmentId,
      count: 1,
      allocationType: 'BASE',
    });
    await sql`update attendees set deleted_at = now() where registration_id = ${deleted}`;

    expect((await queueBlast({ segmentId, templateKey: TEMPLATE })).queued).toBe(0);
  });

  it('ignores a cancelled registration', async () => {
    const { showId, segmentId } = await seedSegment(0);
    const cancelled = await createRegistration({ showId, segmentId, contactName: 'Gone' });
    await seedAttendees({
      registrationId: cancelled,
      showId,
      segmentId,
      count: 2,
      allocationType: 'BASE',
    });
    await sql`update registrations set status = 'CANCELLED' where id = ${cancelled}`;

    expect((await queueBlast({ segmentId, templateKey: TEMPLATE })).queued).toBe(0);
  });
});

describe('the split shown before anything is queued', () => {
  /**
   * §11.4: "Nothing is queued until the admin confirms against those numbers."
   * The numbers therefore have to be real, and `pending` has to be the count a
   * blast would actually act on.
   */
  it('counts confirmed, already sent and pending seats', async () => {
    const { segmentId, registrationIds } = await seedSegment(3);
    await sql`
      update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL'
       where registration_id = ${registrationIds[0]}
    `;

    const split = await blastSplit({ segmentId, templateKey: TEMPLATE });

    expect(split.confirmedAttendees).toBe(6);
    expect(split.alreadySent).toBe(2);
    expect(split.pendingAttendees).toBe(4);
    expect(split.pendingRegistrations).toBe(2);
    expect(split.failedRetryable).toBe(0);
  });

  it('counts a failed row as retryable rather than as pending work done', async () => {
    const { segmentId } = await seedSegment(2);
    await queueBlast({ segmentId, templateKey: TEMPLATE });
    await sql`update email_outbox set status = 'FAILED', attempts = 1, last_error = 'nope'`;

    const split = await blastSplit({ segmentId, templateKey: TEMPLATE });
    expect(split.failedRetryable).toBe(2);
  });

  it('reports the split without writing anything', async () => {
    const { segmentId } = await seedSegment(2);
    await blastSplit({ segmentId, templateKey: TEMPLATE });
    expect(await countRows(segmentId)).toBe(0);
  });
});

describe('what a queued row holds', () => {
  /**
   * Decision 23: `subject` and `body_md` hold the **rendered** message, not a
   * template reference, so an admin can edit before dispatch and a later
   * template edit cannot reach a message already reviewed (§11.5).
   */
  it('stores the rendered message, with merge fields resolved', async () => {
    const { segmentId } = await seedSegment(1);
    await queueBlast({ segmentId, templateKey: TEMPLATE });

    const [row] = await sql<{ subject: string; body_md: string; status: string }[]>`
      select subject, body_md, status from email_outbox
    `;
    expect(row.subject).toBe('Your tickets for Test Concert');
    expect(row.body_md).toContain('Party 1');
    expect(row.body_md).not.toContain('{{');
    // Nothing leaves the system a person has not looked at (§11.5).
    expect(row.status).toBe('DRAFT');
  });
});
