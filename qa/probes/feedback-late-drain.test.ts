import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  issueTickets,
  seedAttendees,
} from '../../tests/helpers/fixtures';
import { queueFeedbackBlast } from '@/lib/email/feedback-blast';

/**
 * QA probe for AC-45 / v2.md §13.5.1: "The recipient list is computed at send
 * time, not at completion time ... a list frozen two hours after the show would
 * silently omit everyone on that device."
 *
 * The branch's own test covers a late admit in a *different* party. This covers
 * the late admit inside a party that already had somebody admitted.
 */

const TEMPLATE = 'feedback_request';
let concertId: number;
let showId: number;
let segmentId: number;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';
  await sql`
    insert into email_templates (key, name, subject, body_md)
    values (${TEMPLATE}, 'Feedback', 'How was {{ show.name }}?',
            'Hello {{ registration.contact_name }}.\n\n{{ feedback_links }}')
    on conflict (key) do update set subject = excluded.subject
  `;
  await sql`
    insert into system_settings (key, value) values ('portal.feedback_send_hour', '12'::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
  concertId = await createConcert('Late drain');
  showId = await createShow(concertId, 400);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}`;
});

async function party(count: number, contactName: string): Promise<number[]> {
  const registrationId = await createRegistration({ showId, segmentId, contactName });
  await seedAttendees({ registrationId, showId, segmentId, count, allocationType: 'BASE' });
  const rows = await sql<{ id: string }[]>`
    select id from attendees where registration_id = ${registrationId} order by id
  `;
  return rows.map((r) => Number(r.id));
}

const admit = (attendeeId: number) => sql`
  insert into check_ins (attendee_id, show_id, scanned_at, source)
  values (${attendeeId}, ${showId}, now(), 'ONLINE')
`;

const outbox = () => sql<{ id: string; status: string; body_md: string }[]>`
  select id, status, body_md from email_outbox where template_key = ${TEMPLATE} order by id
`;

describe('a late-draining usher phone, inside a party that already had an admit', () => {
  it('AC-45a: while the first row is still QUEUED, the late seat never gets a link', async () => {
    const seats = await party(2, 'Mixed drain');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await queueFeedbackBlast({ showId });

    // The usher's phone drains the next morning.
    await admit(seats[1]);
    const second = await queueFeedbackBlast({ showId });

    const tokens = await sql<{ qr_token: string }[]>`
      select qr_token from attendees where id = any(${seats}) order by id
    `;
    const rows = await outbox();
    console.log('second run queued:', second.queued, 'rows:', rows.length);
    console.log('body contains late token?', rows[0].body_md.includes(tokens[1].qr_token));
    expect(rows).toHaveLength(1);
    expect(rows[0].body_md).toContain(tokens[0].qr_token);
    // Spec §13.5.1: this person was in the hall and must not be silently omitted.
    expect(rows[0].body_md).toContain(tokens[1].qr_token);
  });

  it('AC-45b: once the first row is SENT, a re-run queues nothing for that party', async () => {
    const seats = await party(2, 'Mixed drain sent');
    await issueTickets(concertId, showId);
    await admit(seats[0]);
    await queueFeedbackBlast({ showId });
    await sql`update email_outbox set status = 'SENT', sent_at = now() where template_key = ${TEMPLATE}`;

    await admit(seats[1]);
    const second = await queueFeedbackBlast({ showId });
    const rows = await outbox();
    console.log('after SENT, second run queued:', second.queued, 'total rows:', rows.length);
    const tokens = await sql<{ qr_token: string }[]>`
      select qr_token from attendees where id = any(${seats}) order by id
    `;
    console.log('any row carries late token?', rows.some((r) => r.body_md.includes(tokens[1].qr_token)));
    expect(rows.some((r) => r.body_md.includes(tokens[1].qr_token))).toBe(true);
  });
});
