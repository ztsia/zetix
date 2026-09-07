import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Does `/api/tickets/{id}/pdf` **call** its guards?
 *
 * F2's QA passes found the same gap twice: guard functions were well covered,
 * whether any route invoked one was not, and deleting the check left the suite
 * green. `/api` is excluded from the proxy matcher entirely, so a Route Handler
 * is unprotected until it checks for itself (modules.md §5.2.1) — and this one
 * returns an attendee's name and show.
 *
 * The real route module runs against the real database and the real guards.
 * Only `getSessionUser` is stubbed: it is the one leaf needing Supabase, and no
 * cloud container holds a service-role key to make users with (local.md §7).
 */

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const { GET } = await import('@/app/api/tickets/[attendeeId]/pdf/route');
const { issueTickets } = await import('@/lib/tickets/issue');

async function makeUser(role: 'ADMIN' | 'OPERATOR'): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, display_name, role)
    values (${id}::uuid, ${`${role}-${id}@example.test`}, ${role}, ${role}::user_role)
  `;
  return id;
}

const call = (attendeeId: number | string) =>
  GET(new Request('http://localhost/api/tickets/x/pdf'), {
    params: Promise.resolve({ attendeeId: String(attendeeId) }),
  });

let concertId: number;
let assignedShow: number;
let otherShow: number;
let ticketedId: number;
let otherShowTicketId: number;
let unissuedId: number;
let operator: string;
let admin: string;

beforeEach(async () => {
  await resetDb();
  sessionUser.mockReset();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Route');
  assignedShow = await createShow(concertId, 100);
  otherShow = await createShow(concertId, 100);

  const segment = await createSegment(assignedShow, { capacity: 50, audienceMode: 'PUBLIC' });
  const registration = await createRegistration({ showId: assignedShow, segmentId: segment });
  await seedAttendees({
    registrationId: registration, showId: assignedShow, segmentId: segment,
    count: 2, allocationType: 'BASE',
  });

  const otherSegment = await createSegment(otherShow, { capacity: 50, audienceMode: 'PUBLIC' });
  const otherRegistration = await createRegistration({ showId: otherShow, segmentId: otherSegment });
  await seedAttendees({
    registrationId: otherRegistration, showId: otherShow, segmentId: otherSegment,
    count: 1, allocationType: 'BASE',
  });

  await issueTickets({ concertId, showId: assignedShow });
  await issueTickets({ concertId, showId: otherShow });

  const rows = await sql<{ id: string; show_id: string }[]>`
    select id, show_id from attendees order by id
  `;
  ticketedId = Number(rows[0].id);
  otherShowTicketId = Number(rows.find((r) => Number(r.show_id) === otherShow)!.id);

  // An attendee with no identifiers and no pinned template.
  await seedAttendees({
    registrationId: registration, showId: assignedShow, segmentId: segment,
    count: 1, allocationType: 'BASE',
  });
  const after = await sql<{ id: string }[]>`
    select id from attendees where qr_token is null order by id desc limit 1
  `;
  unissuedId = Number(after[0].id);

  operator = await makeUser('OPERATOR');
  admin = await makeUser('ADMIN');
  await sql`
    insert into operator_show_assignments (user_id, show_id)
    values (${operator}::uuid, ${assignedShow})
  `;
});

const asOperator = () =>
  sessionUser.mockResolvedValue({ id: operator, email: 'o@x', displayName: 'Wei', role: 'OPERATOR' });
const asAdmin = () =>
  sessionUser.mockResolvedValue({ id: admin, email: 'a@x', displayName: 'Committee', role: 'ADMIN' });
const anonymous = () => sessionUser.mockResolvedValue(null);

describe('GET /api/tickets/[attendeeId]/pdf', () => {
  it('renders a PDF for an admin', async () => {
    asAdmin();
    const response = await call(ticketedId);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    // It carries a name, so no shared cache may keep it.
    expect(response.headers.get('cache-control')).toContain('private');
  });

  it('refuses an anonymous request', async () => {
    // The probe that matters: `/api` is outside the proxy matcher, so without
    // the check in the handler this returns an attendee's name to anyone.
    anonymous();
    expect((await call(ticketedId)).status).toBe(401);
  });

  it('lets an operator fetch a ticket for a show they are rostered on', async () => {
    asOperator();
    expect((await call(ticketedId)).status).toBe(200);
  });

  it('refuses an operator a ticket for a show they are not rostered on', async () => {
    asOperator();
    expect((await call(otherShowTicketId)).status).toBe(404);
  });

  it('answers 404 identically for missing, unissued and not-yours', async () => {
    // Probing ids must not distinguish these three, or the response becomes an
    // oracle for which attendees exist (modules.md §5.2.1).
    asOperator();
    expect((await call(999_999)).status).toBe(404);
    expect((await call(unissuedId)).status).toBe(404);
    expect((await call(otherShowTicketId)).status).toBe(404);
  });

  it('rejects a non-numeric id without touching the database', async () => {
    asAdmin();
    expect((await call('not-a-number')).status).toBe(404);
    expect((await call('-1')).status).toBe(404);
  });

  it('names the file after the show, attendee and code', async () => {
    asAdmin();
    const disposition = (await call(ticketedId)).headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^inline; filename="/);
    expect(disposition).toMatch(/ORC-[0-9A-HJKMNP-TV-Z]{4}\.pdf"$/);
  });
});
