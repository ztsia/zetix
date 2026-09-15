import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert, createRegistration, createSegment, createShow, issueTickets, seedAttendees,
} from '../../tests/helpers/fixtures';
import { queueFeedbackBlast } from '@/lib/email/feedback-blast';

/** AC-46 under contention: the cron and the admin button pressing at the same moment. */
let showId: number; let segmentId: number; let concertId: number;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';
  await sql`insert into email_templates (key, name, subject, body_md)
            values ('feedback_request','F','How was {{ show.name }}?','{{ feedback_links }}')`;
  await sql`insert into system_settings (key, value) values ('portal.feedback_send_hour','12'::jsonb)`;
  concertId = await createConcert('Race');
  showId = await createShow(concertId, 400);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  await sql`update concerts set timezone='Asia/Kuala_Lumpur' where id = ${concertId}`;
});

describe('two queue calls at once', () => {
  it('leaves exactly one outbox row per registration', async () => {
    for (const name of ['One', 'Two', 'Three']) {
      const registrationId = await createRegistration({ showId, segmentId, contactName: name });
      await seedAttendees({ registrationId, showId, segmentId, count: 2, allocationType: 'BASE' });
    }
    await issueTickets(concertId, showId);
    const seats = await sql<{ id: string }[]>`select id from attendees where show_id = ${showId}`;
    for (const s of seats) {
      await sql`insert into check_ins (attendee_id, show_id, scanned_at, source)
                values (${Number(s.id)}, ${showId}, now(), 'ONLINE')`;
    }

    const [a, b] = await Promise.all([
      queueFeedbackBlast({ showId }),
      queueFeedbackBlast({ showId }),
    ]);
    console.log('run A:', JSON.stringify(a), 'run B:', JSON.stringify(b));
    const rows = await sql<{ registration_id: string; n: number }[]>`
      select registration_id, count(*)::int as n from email_outbox
       where template_key = 'feedback_request' group by registration_id`;
    console.log('rows per registration:', JSON.stringify(rows));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.n === 1)).toBe(true);
    expect(a.queued + b.queued).toBe(3);
  });
});
