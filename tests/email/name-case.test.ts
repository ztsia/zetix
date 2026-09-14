import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  seedAttendees,
} from '../helpers/fixtures';
import { queueBlast } from '@/lib/email/queue';

/**
 * The name in the message reads the way the name on the ticket does
 * (`lib/names.ts`).
 *
 * The blast built its merge context straight out of the database, so a guest
 * who typed their name in capitals got "Dear LOH KAI XIN" above a PDF printed
 * "Loh Kai Xin" — two answers to the same question, and the email is the half
 * they read first.
 *
 * The stored row is untouched by all of this: casing happens on the way out, so
 * the sheet, the admin screens and the database still agree with each other.
 */

const TEMPLATE = 'public_ticket';

async function seed() {
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (
      ${TEMPLATE}, 'Public ticket', 'Tickets for {{ registration.contact_name }}',
      ${'Dear {{ registration.contact_name }},\n\nGuests: {{ attendee_names }}\n\n{{ ticket_links }}'}
    )
    on conflict (key) do update set subject = excluded.subject, body_md = excluded.body_md
  `;
  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  const registrationId = await createRegistration({
    showId,
    segmentId,
    contactName: 'LOH KAI XIN',
  });
  await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });
  await sql`
    update attendees set full_name = case
        when id = (select min(id) from attendees where registration_id = ${registrationId})
        then 'LOH KAI XIN' else 'guest of loh kai xin' end
     where registration_id = ${registrationId}
  `;
  await issueTickets(concertId, showId);
  return { segmentId, registrationId };
}

const rowOf = async (registrationId: number) => {
  const [row] = await sql<{ subject: string; body_md: string; to_name: string | null }[]>`
    select subject, body_md, to_name from email_outbox where registration_id = ${registrationId}
  `;
  return row;
};

beforeEach(resetDb);

describe('a name in a queued message', () => {
  it('is cased in the body', async () => {
    const { segmentId, registrationId } = await seed();
    await queueBlast({ segmentId, templateKey: TEMPLATE });

    const row = await rowOf(registrationId);
    expect(row.body_md).toContain('Dear Loh Kai Xin,');
    expect(row.body_md).not.toContain('LOH KAI XIN');
  });

  it('is cased in the subject', async () => {
    const { segmentId, registrationId } = await seed();
    await queueBlast({ segmentId, templateKey: TEMPLATE });

    expect((await rowOf(registrationId)).subject).toBe('Tickets for Loh Kai Xin');
  });

  /** The `To:` header is read in the inbox before anything else. */
  it('is cased in the addressee', async () => {
    const { segmentId, registrationId } = await seed();
    await queueBlast({ segmentId, templateKey: TEMPLATE });

    expect((await rowOf(registrationId)).to_name).toBe('Loh Kai Xin');
  });

  it('is cased in the guest list and in the ticket links', async () => {
    const { segmentId, registrationId } = await seed();
    await queueBlast({ segmentId, templateKey: TEMPLATE });

    const { body_md: body } = await rowOf(registrationId);
    expect(body).toContain('Guests: Loh Kai Xin, Guest of Loh Kai Xin');
    // The link label is the guest it belongs to, so it is cased too.
    expect(body).toMatch(/- Loh Kai Xin — \[View ticket\]/);
  });
});

describe('what is not touched', () => {
  it('leaves the stored registration and attendees exactly as typed', async () => {
    const { segmentId, registrationId } = await seed();
    await queueBlast({ segmentId, templateKey: TEMPLATE });

    const [registration] = await sql<{ contact_name: string }[]>`
      select contact_name from registrations where id = ${registrationId}
    `;
    const names = await sql<{ full_name: string }[]>`
      select full_name from attendees where registration_id = ${registrationId} order by id
    `;

    expect(registration.contact_name).toBe('LOH KAI XIN');
    expect(names.map((n) => n.full_name)).toEqual(['LOH KAI XIN', 'guest of loh kai xin']);
  });
});
