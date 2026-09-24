import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
} from '../helpers/fixtures';

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
 *
 * **Module `J` extended this file rather than starting a new one**, because V2
 * makes `registration_id` nullable to hold the one player-addressed message and
 * that is the exact move the non-negotiable warns about (`modules-v2.md` §3.1).
 * The property being defended is unchanged; there are now two keys defending it,
 * and the second half of this file is what proves the first half still bites.
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
    // because two rows with a NULL key do not conflict in Postgres. Having a key
    // at all — never both null — is what makes the constraint real.
    //
    // Before V2 that was `registration_id not null`. It is now a check
    // constraint, because the digest below needs the column nullable; the
    // property it defends is the same one.
    await expect(
      sql`
        insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
        values (null, 'public_ticket', 'to@example.test', 's', 'b', 'DRAFT')
      `,
    ).rejects.toThrow(/email_outbox_one_addressee/);
  });
});

/**
 * The player-addressed digest — `modules-v2.md` §3.1, spec/email.md §11.3.
 *
 * `player_notes_digest` is the one message addressed to a player rather than to
 * a registration, and a player has no registration. `J` made
 * `email_outbox.registration_id` nullable to hold it, which is precisely the
 * move `CLAUDE.md` warns about: "a nullable key would silently defeat the
 * index."
 *
 * These tests exist because that failure is silent. A row with both keys null
 * conflicts with nothing, `on conflict do nothing` does nothing, and every
 * digest queues twice with no error anywhere — the second send is the first
 * anyone hears about it.
 */
describe('the player-addressed digest keeps both keys total', () => {
  let registrationId: number;
  let playerId: number;
  let otherPlayerId: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 100);
    const segmentId = await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 50 });
    registrationId = await createRegistration({ showId, segmentId });
    [playerId, otherPlayerId] = await createPlayers(concertId, 2);
  });

  const queueDigest = (id: number, status = 'QUEUED') => sql`
    insert into email_outbox (player_id, template_key, to_email, subject, body_md, status)
    values (${id}::bigint, 'player_notes_digest', 'player@example.test', 'Your notes', 'body',
            ${status}::outbox_status)
    on conflict do nothing
    returning id
  `;

  it('refuses a row addressed to nobody', async () => {
    // The whole of §3.1. Without this check the two rows below are both legal,
    // neither conflicts with the other, and the digest goes out twice.
    await expect(
      sql`
        insert into email_outbox (template_key, to_email, subject, body_md, status)
        values ('player_notes_digest', 'p@example.test', 's', 'b', 'QUEUED')
      `,
    ).rejects.toThrow(/email_outbox_one_addressee/);
  });

  it('refuses a row addressed to both a registration and a player', async () => {
    // "Exactly one", not "at least one": a row carrying both keys would be
    // deduplicated by two indexes with two different opinions about it.
    await expect(
      sql`
        insert into email_outbox (registration_id, player_id, template_key, to_email,
                                  subject, body_md, status)
        values (${registrationId}::bigint, ${playerId}::bigint, 'player_notes_digest',
                'p@example.test', 's', 'b', 'QUEUED')
      `,
    ).rejects.toThrow(/email_outbox_one_addressee/);
  });

  it('queues a digest once and silently declines the second press', async () => {
    expect(await queueDigest(playerId)).toHaveLength(1);
    expect(await queueDigest(playerId)).toHaveLength(0);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where player_id = ${playerId}::bigint
    `;
    expect(n).toBe(1);
  });

  it('treats DRAFT, QUEUED and SENDING alike for a digest too', async () => {
    await queueDigest(playerId, 'DRAFT');
    await sql`
      update email_outbox set status = 'SENDING' where player_id = ${playerId}::bigint
    `;
    expect(await queueDigest(playerId, 'QUEUED')).toHaveLength(0);
  });

  it('allows the same player again once the first digest has SENT', async () => {
    await queueDigest(playerId);
    await sql`
      update email_outbox set status = 'SENT', sent_at = now()
       where player_id = ${playerId}::bigint
    `;
    // More notes arrive after the first digest went out; the next one must reach
    // them. Same reasoning as the added-guest case above.
    expect(await queueDigest(playerId)).toHaveLength(1);
  });

  it('does not confuse two players with each other', async () => {
    expect(await queueDigest(playerId)).toHaveLength(1);
    expect(await queueDigest(otherPlayerId)).toHaveLength(1);
  });

  it('leaves the registration index biting exactly as before', async () => {
    // The point of a disjoint second key rather than a swapped one: a digest in
    // the table must not make a registration-addressed row conflict, or fail to.
    await queueDigest(playerId);

    const queueTicket = () => sql`
      insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status)
      values (${registrationId}::bigint, 'player_confirmation', 'to@example.test', 's', 'b',
              'DRAFT')
      on conflict do nothing
      returning id
    `;
    expect(await queueTicket()).toHaveLength(1);
    expect(await queueTicket()).toHaveLength(0);
  });
});
