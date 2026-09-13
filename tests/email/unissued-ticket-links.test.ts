import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';
import { queueBlast } from '@/lib/email/queue';

/**
 * A seat with no `qr_token` must not be linked (spec/email.md §11.3).
 *
 * This reached a real inbox: `https://zetix.vercel.app/t/NULL`, under the
 * guest's own name. `postgres.js` parses a NULL element of a **text** array as
 * the four-character string `"NULL"` — a real null and the literal word are
 * indistinguishable once `array_agg(a.qr_token)` has crossed the wire — so the
 * `filter(Boolean)` guarding the link list waved it straight through.
 *
 * Nothing upstream stops it either: §11.4's predicate is `ticket_sent_at is
 * null`, which says nothing about whether a ticket was ever issued. So a blast
 * queued before the issue step renders dead links into `body_md`, and `body_md`
 * is sent verbatim (decision 23).
 *
 * The fix is in the query — untokened seats never enter the array — and this
 * test is deliberately at the database level, because a unit test of
 * `ticketLinks()` cannot see the driver behaviour that caused it.
 */

const TEMPLATE = 'public_ticket';
const TOKEN = 'Ada00000000000000000a1'; // the minted shape: [0-9A-Za-z]{22}

async function seedTemplate() {
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (
      ${TEMPLATE}, 'Public ticket',
      'Your tickets for {{ concert.name }}',
      ${'Guests: {{ attendee_names }}\n\n{{ ticket_links }}'}
    )
    on conflict (key) do update set body_md = excluded.body_md
  `;
}

/** One party of two, only one of whom has had a ticket issued. */
async function seedHalfIssuedParty() {
  const concertId = await createConcert();
  const showId = await createShow(concertId, 400);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  const registrationId = await createRegistration({ showId, segmentId, contactName: 'Ada Lim' });
  await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });

  // Issue a token to the first seat only. Going null -> value is allowed; it is
  // a *change* of an existing token the immutability trigger refuses.
  await sql`
    update attendees set qr_token = ${TOKEN}
     where id = (select min(id) from attendees where registration_id = ${registrationId})
  `;
  return { segmentId, registrationId };
}

const bodyOf = async (registrationId: number) => {
  const [row] = await sql<{ body_md: string }[]>`
    select body_md from email_outbox where registration_id = ${registrationId}
  `;
  return row.body_md;
};

beforeEach(async () => {
  await resetDb();
  await seedTemplate();
  process.env.APP_URL = 'https://zetix.example';
});

afterEach(() => {
  delete process.env.APP_URL;
});

describe('a seat whose ticket has not been issued', () => {
  it('is not linked as /t/NULL', async () => {
    const { segmentId, registrationId } = await seedHalfIssuedParty();

    await queueBlast({ segmentId, templateKey: TEMPLATE });
    const body = await bodyOf(registrationId);

    expect(body).not.toContain('/t/NULL');
    expect(body).not.toMatch(/\/t\/\s*\)/);
  });

  it('still links the seat that does have a token', async () => {
    const { segmentId, registrationId } = await seedHalfIssuedParty();

    await queueBlast({ segmentId, templateKey: TEMPLATE });
    const body = await bodyOf(registrationId);

    expect(body).toContain(`/t/${TOKEN}`);
    expect(body.match(/\/t\//g)).toHaveLength(1);
  });

  /**
   * The guest list is a different question from the link list: a party of two
   * is a party of two whether or not both tickets exist yet. Filtering the
   * wrong aggregate would quietly shrink the party.
   */
  it('still names every guest in the party', async () => {
    const { segmentId, registrationId } = await seedHalfIssuedParty();

    await queueBlast({ segmentId, templateKey: TEMPLATE });
    const body = await bodyOf(registrationId);

    expect(body).toContain('Guest 1');
    expect(body).toContain('Guest 2');
  });

  /**
   * The link must sit under the name of the guest it belongs to. Both
   * aggregates carry the same filter for this reason: filtering tokens alone
   * would leave "Guest 1" pointing at the second seat's ticket.
   */
  it('labels the surviving link with the right guest', async () => {
    const { segmentId, registrationId } = await seedHalfIssuedParty();

    await queueBlast({ segmentId, templateKey: TEMPLATE });
    const body = await bodyOf(registrationId);

    expect(body).toMatch(new RegExp(`Guest 1[^\n]*${TOKEN}`));
  });
});
