import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';

/**
 * `GET /api/portal/{token}/ticket` when there is no PDF to give
 * (spec/v3.md §32.3): a person pressed a button, so they get a page, never
 * `{"error":"Not found"}`.
 */
const { GET } = await import('@/app/api/portal/[token]/ticket/route');
const { issueTickets } = await import('@/lib/tickets/issue');

let token: string;
let attendeeId: number;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';
  const concertId = await createConcert('Portal');
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({ registrationId, showId, segmentId, count: 1, allocationType: 'BASE' });
  await issueTickets({ concertId, showId });
  const [row] = await sql<{ id: string; qr_token: string }[]>`select id, qr_token from attendees`;
  token = row.qr_token;
  attendeeId = Number(row.id);
});

const get = (t: string) =>
  GET(new Request(`http://localhost/api/portal/${t}/ticket`), {
    params: Promise.resolve({ token: t }),
  });

async function expectPage(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get('content-type')).toContain('text/html');
  const body = await response.text();
  expect(body).toContain('<h1>');
  expect(body).not.toContain('"error"');
  return body;
}

describe('no PDF to give', () => {
  it('answers an unknown token with a page, not JSON', async () => {
    const body = await expectPage(await get('B'.repeat(22)));
    expect(body).toContain('/t/' + 'B'.repeat(22));
  });

  it('answers a ticket not yet issued with a page that links back to it', async () => {
    await withDirectAttendeeWrites(
      (tx) => tx`
        update attendees set ticket_template_id = null, ticket_template_version = null
         where id = ${attendeeId}
      `,
    );
    const body = await expectPage(await get(token));
    expect(body).toContain(`/t/${token}`);
  });

  it('hands no PDF to a seat on hold, which the door will refuse', async () => {
    await withDirectAttendeeWrites(
      (tx) => tx`update attendees set status = 'WAITLIST' where id = ${attendeeId}`,
    );
    await expectPage(await get(token));
  });

  it('does not echo a malformed token into the page', async () => {
    const body = await expectPage(await get('<script>x</script>'));
    expect(body).not.toContain('<script>x');
  });
});
