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
 * **A party is not drafted until every one of its tickets exists**
 * (spec/email.md §11.4).
 *
 * `buildPartyAttachments()` renders every confirmed seat and throws if any one
 * has no pinned template, so a half-issued party could never be *sent* — it
 * could only be drafted, reviewed, confirmed, and then fail at dispatch. Worse,
 * `body_md` is rendered when the draft is prepared and sent verbatim (decision
 * 23): a party queued before the issue step keeps a `ticket_links` value
 * rendered against tickets that did not exist, and issuing afterwards does not
 * go back to fix it. That reached a real inbox as `/t/NULL`.
 *
 * So eligibility has to be decided at queue time, which is what this pins.
 */

const TICKET_TEMPLATE = 'public_ticket';
const TEXT_ONLY = 'reminder';
const TOKEN = (n: number) => `Tok${String(n).padStart(19, '0')}`; // [0-9A-Za-z]{22}

async function seedEmailTemplates() {
  for (const key of [TICKET_TEMPLATE, TEXT_ONLY]) {
    await sql`
      insert into email_templates (key, name, subject, body_md)
      values (${key}, ${key}, 'Subject', ${'Hello {{ registration.contact_name }}'})
      on conflict (key) do nothing
    `;
  }
}

async function ticketTemplateFor(concertId: number): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into ticket_templates (
      concert_id, name, version, background_kind,
      page_width_pt, page_height_pt, layout, is_default
    ) values (
      ${concertId}, 'Plain', 1, 'NONE', 595, 280,
      ${JSON.stringify({ canvas: { width_pt: 595, height_pt: 280, dpi: 300 }, elements: [] })}::text::jsonb,
      true
    )
    returning id
  `;
  return Number(row.id);
}

/** One party of two seats; `issued` of them have a ticket. */
async function seedParty(issued: 0 | 1 | 2) {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  const templateId = await ticketTemplateFor(concertId);
  const registrationId = await createRegistration({ showId, segmentId, contactName: 'Ada Lim' });
  await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });

  const seats = await sql<{ id: string }[]>`
    select id from attendees where registration_id = ${registrationId} order by id
  `;
  for (let i = 0; i < issued; i++) {
    await sql`
      update attendees
         set qr_token = ${TOKEN(i + 1)},
             ticket_template_id = ${templateId},
             ticket_template_version = 1,
             ticket_issued_at = now()
       where id = ${Number(seats[i].id)}
    `;
  }
  return { segmentId, registrationId };
}

beforeEach(async () => {
  await resetDb();
  await seedEmailTemplates();
});

describe('queueing a ticket-bearing blast', () => {
  it('queues a party whose tickets are all issued', async () => {
    const { segmentId } = await seedParty(2);

    expect((await queueBlast({ segmentId, templateKey: TICKET_TEMPLATE })).queued).toBe(1);
  });

  it('queues nothing for a party with no tickets at all', async () => {
    const { segmentId } = await seedParty(0);

    expect((await queueBlast({ segmentId, templateKey: TICKET_TEMPLATE })).queued).toBe(0);
  });

  /**
   * The case that matters most: one seat short is the whole party held back,
   * because the message carries every ticket the party holds (decision 22) and
   * one email with half the PDFs is worse than no email.
   */
  it('holds back a party where only one of two seats is issued', async () => {
    const { segmentId } = await seedParty(1);

    expect((await queueBlast({ segmentId, templateKey: TICKET_TEMPLATE })).queued).toBe(0);
  });

  it('queues it once the missing ticket is issued', async () => {
    const { segmentId, registrationId } = await seedParty(1);
    expect((await queueBlast({ segmentId, templateKey: TICKET_TEMPLATE })).queued).toBe(0);

    const [{ id }] = await sql<{ id: string }[]>`
      select id from attendees
       where registration_id = ${registrationId} and qr_token is null
       order by id limit 1
    `;
    const [{ ticket_template_id }] = await sql<{ ticket_template_id: string }[]>`
      select ticket_template_id from attendees
       where registration_id = ${registrationId} and qr_token is not null limit 1
    `;
    await sql`
      update attendees
         set qr_token = ${TOKEN(9)}, ticket_template_id = ${Number(ticket_template_id)},
             ticket_template_version = 1, ticket_issued_at = now()
       where id = ${Number(id)}
    `;

    expect((await queueBlast({ segmentId, templateKey: TICKET_TEMPLATE })).queued).toBe(1);
  });
});

describe('the split says so before anything is queued', () => {
  it('counts a half-issued party as waiting, not as pending', async () => {
    const { segmentId } = await seedParty(1);

    const split = await blastSplit({ segmentId, templateKey: TICKET_TEMPLATE });

    expect(split.confirmedAttendees).toBe(2);
    expect(split.pendingAttendees).toBe(0);
    expect(split.pendingRegistrations).toBe(0);
    expect(split.unissuedAttendees).toBe(2);
    expect(split.unissuedRegistrations).toBe(1);
  });

  it('reports nothing waiting once every ticket exists', async () => {
    const { segmentId } = await seedParty(2);

    const split = await blastSplit({ segmentId, templateKey: TICKET_TEMPLATE });

    expect(split.pendingAttendees).toBe(2);
    expect(split.unissuedAttendees).toBe(0);
    expect(split.unissuedRegistrations).toBe(0);
  });
});

/**
 * A reminder, a decline and a cancellation attach nothing. Waiting for tickets
 * before sending those would block precisely the messages an admin writes
 * *because* somebody has no ticket.
 */
describe('a template that carries no tickets', () => {
  it('is queued for a party with no tickets at all', async () => {
    const { segmentId } = await seedParty(0);

    expect((await queueBlast({ segmentId, templateKey: TEXT_ONLY })).queued).toBe(1);
  });

  it('reports nothing as held back', async () => {
    const { segmentId } = await seedParty(0);

    const split = await blastSplit({ segmentId, templateKey: TEXT_ONLY });

    expect(split.pendingRegistrations).toBe(1);
    expect(split.unissuedAttendees).toBe(0);
    expect(split.unissuedRegistrations).toBe(0);
  });
});
