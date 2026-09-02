import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createRegistration, createSegment, createShow } from '../helpers/fixtures';

/**
 * `outbox_no_duplicate_pending` — spec/email.md §11.4, decision 16.
 *
 * A CLAUDE.md non-negotiable: "Pressing Send twice must be harmless." The
 * partial unique index is what makes the `on conflict do nothing` in §11.4
 * mean anything; without it that clause is decoration and a second click queues
 * everything twice.
 *
 * The index is F1's, so its regression test is F1's too, even though module F
 * writes the blast itself.
 */

describe('outbox idempotency', () => {
  let registrationId: number;
  let otherRegistrationId: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 100);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
    registrationId = await createRegistration({ showId, segmentId });
    otherRegistrationId = await createRegistration({ showId, segmentId });
  });

  const queue = (id: number, status = 'DRAFT') => sql`
    insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
    values (${id}::bigint, 'public_ticket', 'to@example.test', 'Your ticket', 'body',
            ${status}::outbox_status)
    on conflict do nothing
    returning id
  `;

  it('queues once and silently declines the second press of Send', async () => {
    expect(await queue(registrationId)).toHaveLength(1);
    // The admin who is unsure whether the first click registered clicks again.
    expect(await queue(registrationId)).toHaveLength(0);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox
       where registration_id = ${registrationId}::bigint
    `;
    expect(n).toBe(1);
  });

  it('treats DRAFT, QUEUED and SENDING alike as pending', async () => {
    await queue(registrationId, 'DRAFT');
    await sql`
      update email_outbox set status = 'QUEUED' where registration_id = ${registrationId}::bigint
    `;
    expect(await queue(registrationId, 'SENDING')).toHaveLength(0);
  });

  it('allows the same registration again once the first message has SENT', async () => {
    await queue(registrationId);
    await sql`
      update email_outbox set status = 'SENT', sent_at = now()
       where registration_id = ${registrationId}::bigint
    `;

    // The added-guest case (§11.4): a fourth guest joins a party whose first
    // three tickets are already sent, and the next blast must reach them.
    expect(await queue(registrationId)).toHaveLength(1);
  });

  it('does not confuse two registrations with each other', async () => {
    expect(await queue(registrationId)).toHaveLength(1);
    expect(await queue(otherRegistrationId)).toHaveLength(1);
  });

  it('keys on the registration, so the index actually bites', async () => {
    // Decision 22: a nullable `attendee_id` key would defeat this outright,
    // because two rows with a NULL key do not conflict in Postgres. The column
    // being NOT NULL is what makes the constraint real.
    await expect(
      sql`
        insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
        values (null, 'public_ticket', 'to@example.test', 's', 'b', 'DRAFT')
      `,
    ).rejects.toThrow(/null value in column "registration_id"/);
  });
});
