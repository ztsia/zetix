import { beforeEach, describe, expect, it } from 'vitest';
import { blastSplit, queueBlast } from '@/lib/email/queue';
import { verifyRegistration } from '@/lib/registrations/verification';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * The double opt-in gate on the blast (spec/v2.md §8.1.4, `email.md` §11.4).
 *
 * **This is the half of the branch that can strand people**, so it is tested
 * from both ends: that an unverified public registrant really is held back, and
 * — much more important — that everyone who was never asked to verify is
 * **not**. Getting the second wrong silently queues nothing for the entire
 * imported cohort, and the only symptom is tickets that never arrive.
 *
 * The gate is one condition: a registration is waiting only if it carries a
 * `verification_token`. Every exemption in the spec falls out of that rather
 * than being a rule of its own.
 */

const TEMPLATE = 'public_ticket';

async function scenario() {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, {
    audienceMode: 'PUBLIC',
    capacity: 100,
    extrasPolicy: 'AUTO_FCFS',
  });
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (${TEMPLATE}, 'Public ticket', 'Your tickets', 'Hello {{ registration.contact_name }}')
    on conflict (key) do nothing
  `;
  return { concertId, showId, segmentId };
}

/** A confirmed party of one, optionally gated behind a verification token. */
async function party(
  ids: { showId: number; segmentId: number },
  opts: { email: string; token?: string | null; verified?: boolean },
) {
  const registrationId = await createRegistration({
    showId: ids.showId,
    segmentId: ids.segmentId,
  });
  await sql`
    update registrations
       set contact_email = ${opts.email},
           verification_token = ${opts.token ?? null},
           email_verified_at = ${opts.verified ? sql`now()` : null}
     where id = ${registrationId}
  `;
  await seedAttendees({
    registrationId,
    showId: ids.showId,
    segmentId: ids.segmentId,
    count: 1,
    allocationType: 'EXTRA',
  });
  return registrationId;
}

async function queuedEmails(segmentId: number) {
  return sql<{ to_email: string }[]>`
    select o.to_email from email_outbox o
      join registrations r on r.id = o.registration_id
     where r.segment_id = ${segmentId}
     order by o.to_email
  `;
}

describe('the verification gate on the blast', () => {
  let ids: { concertId: number; showId: number; segmentId: number };

  beforeEach(async () => {
    await resetDb();
    ids = await scenario();
  });

  it('holds back a public registrant who has not verified', async () => {
    await party(ids, { email: 'unverified@example.test', token: 'tok-unverified' });
    await issueTickets(ids.concertId, ids.showId);

    const { queued } = await queueBlast({ segmentId: ids.segmentId, templateKey: TEMPLATE });
    expect(queued).toBe(0);
    expect(await queuedEmails(ids.segmentId)).toHaveLength(0);
  });

  it('queues them the moment they verify', async () => {
    await party(ids, { email: 'clicks@example.test', token: 'tok-clicks' });
    await issueTickets(ids.concertId, ids.showId);

    expect((await queueBlast({ segmentId: ids.segmentId, templateKey: TEMPLATE })).queued).toBe(0);

    await expect(verifyRegistration('tok-clicks')).resolves.toMatchObject({ state: 'VERIFIED' });

    const { queued } = await queueBlast({ segmentId: ids.segmentId, templateKey: TEMPLATE });
    expect(queued).toBe(1);
  });

  /**
   * **The one that would strand the 19 Sep cohort.** An imported registrant
   * never received a link; holding their tickets behind one they cannot click
   * means they never get tickets at all, and nothing anywhere reports it.
   */
  it('never holds back a registration that was not sent a link', async () => {
    await party(ids, { email: 'imported@example.test', token: null });
    await party(ids, { email: 'player@example.test', token: null });
    await issueTickets(ids.concertId, ids.showId);

    const { queued } = await queueBlast({ segmentId: ids.segmentId, templateKey: TEMPLATE });
    expect(queued).toBe(2);
    expect((await queuedEmails(ids.segmentId)).map((r) => r.to_email)).toEqual([
      'imported@example.test',
      'player@example.test',
    ]);
  });

  it('queues a party an admin released by hand', async () => {
    await party(ids, { email: 'released@example.test', token: 'tok-released', verified: true });
    await issueTickets(ids.concertId, ids.showId);

    expect((await queueBlast({ segmentId: ids.segmentId, templateKey: TEMPLATE })).queued).toBe(1);
  });

  it('queues the verified and holds the unverified in one run', async () => {
    await party(ids, { email: 'a-verified@example.test', token: 'tok-a', verified: true });
    await party(ids, { email: 'b-waiting@example.test', token: 'tok-b' });
    await party(ids, { email: 'c-imported@example.test', token: null });
    await issueTickets(ids.concertId, ids.showId);

    const { queued } = await queueBlast({ segmentId: ids.segmentId, templateKey: TEMPLATE });
    expect(queued).toBe(2);
    expect((await queuedEmails(ids.segmentId)).map((r) => r.to_email)).toEqual([
      'a-verified@example.test',
      'c-imported@example.test',
    ]);
  });

  /**
   * §11.4 requires the split to be shown before anything is queued, which is
   * only useful if the two agree. An admin confirming against "2 pending" and
   * getting 1 has been told a lie.
   */
  it('reports the held parties on the split rather than leaving a gap', async () => {
    await party(ids, { email: 'a-verified@example.test', token: 'tok-a', verified: true });
    await party(ids, { email: 'b-waiting@example.test', token: 'tok-b' });
    await issueTickets(ids.concertId, ids.showId);

    const split = await blastSplit({ segmentId: ids.segmentId, templateKey: TEMPLATE });
    expect(split.heldForVerification).toBe(1);
    expect(split.pendingRegistrations).toBe(1);

    const { queued } = await queueBlast({ segmentId: ids.segmentId, templateKey: TEMPLATE });
    expect(queued).toBe(split.pendingRegistrations);
  });

  /**
   * The gate is on the ticket, not on every message. Withholding a cancellation
   * from an address we are unsure of leaves a registrant uninformed for no
   * gain, and `public_verify` obviously cannot wait on its own click.
   */
  it('does not gate a template that carries no tickets', async () => {
    await sql`
      insert into email_templates (key, name, subject, body_md)
      values ('registration_cancelled', 'Cancelled', 'Cancelled', 'Sorry')
      on conflict (key) do nothing
    `;
    await party(ids, { email: 'waiting@example.test', token: 'tok-waiting' });

    const { queued } = await queueBlast({
      segmentId: ids.segmentId,
      templateKey: 'registration_cancelled',
    });
    expect(queued).toBe(1);
  });
});

describe('verifyRegistration', () => {
  let ids: { concertId: number; showId: number; segmentId: number };

  beforeEach(async () => {
    await resetDb();
    ids = await scenario();
  });

  it('verifies once and reports a repeat click as already done', async () => {
    await party(ids, { email: 'twice@example.test', token: 'tok-twice' });

    await expect(verifyRegistration('tok-twice')).resolves.toEqual({
      state: 'VERIFIED',
      contactName: 'Test Registrant',
    });
    await expect(verifyRegistration('tok-twice')).resolves.toEqual({
      state: 'ALREADY',
      contactName: 'Test Registrant',
    });
  });

  /**
   * The timestamp is evidence of when the address was proved. A second click a
   * week later must not move it, or the review screen's "waiting 50 hours"
   * becomes unanswerable.
   */
  it('does not move the timestamp on a repeat click', async () => {
    await party(ids, { email: 'stamp@example.test', token: 'tok-stamp' });
    await verifyRegistration('tok-stamp');

    const [first] = await sql<{ at: string }[]>`
      select email_verified_at::text as at from registrations where verification_token = 'tok-stamp'
    `;
    await verifyRegistration('tok-stamp');
    const [second] = await sql<{ at: string }[]>`
      select email_verified_at::text as at from registrations where verification_token = 'tok-stamp'
    `;
    expect(second.at).toBe(first.at);
  });

  /**
   * The token is **not** consumed. Clearing it would ungate the registration by
   * the very rule the blast reads — a null token means "never needed to verify"
   * — so a verified party and an imported one would become indistinguishable.
   */
  it('keeps the token after verifying', async () => {
    await party(ids, { email: 'keep@example.test', token: 'tok-keep' });
    await verifyRegistration('tok-keep');

    const [row] = await sql<{ verification_token: string | null }[]>`
      select verification_token from registrations where contact_email = 'keep@example.test'
    `;
    expect(row.verification_token).toBe('tok-keep');
  });

  it.each(['nope', '', '../etc', "'; drop table registrations; --"])(
    'returns UNKNOWN for %j',
    async (bad) => {
      await expect(verifyRegistration(bad)).resolves.toEqual({ state: 'UNKNOWN' });
    },
  );

  it('returns UNKNOWN for a soft-deleted registration', async () => {
    await party(ids, { email: 'gone@example.test', token: 'tok-gone' });
    await sql`update registrations set deleted_at = now() where verification_token = 'tok-gone'`;
    await expect(verifyRegistration('tok-gone')).resolves.toEqual({ state: 'UNKNOWN' });
  });
});
