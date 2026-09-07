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

  it('refuses an operator even on a show they are rostered on', async () => {
    // `admin.md` §14.1: an operator "cannot edit any data, export, view PII
    // beyond name and ticket status". A rendered ticket is a downloadable file
    // carrying the attendee's name, show, venue and doors — an export in
    // everything but name. The door does not need it either: the scanner
    // matches `qr_token` against the offline manifest and never dereferences
    // the QR (decision 28). Found by an independent QA pass, which got a 200.
    asOperator();
    expect((await call(ticketedId)).status).toBe(404);
  });

  it('refuses an operator a ticket for a show they are not rostered on', async () => {
    asOperator();
    expect((await call(otherShowTicketId)).status).toBe(404);
  });

  it('answers 404 identically for missing and unissued', async () => {
    // Probing ids must not distinguish these, or the response becomes an oracle
    // for which attendees exist (modules.md §5.2.1). An admin legitimately sees
    // every show, so "not yours" does not arise for them.
    asAdmin();
    expect((await call(999_999)).status).toBe(404);
    expect((await call(unissuedId)).status).toBe(404);
  });

  it('gives an operator the same 404 whatever they ask for', async () => {
    // Refused as a role, so nothing in the response distinguishes an attendee
    // that exists from one that does not, or an assigned show from another.
    asOperator();
    for (const id of [ticketedId, otherShowTicketId, unissuedId, 999_999]) {
      expect((await call(id)).status).toBe(404);
    }
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

describe('the pin is read as two columns, not one', () => {
  it('refuses to render when the pinned version no longer matches the row', async () => {
    // §10.5: rendering always uses the pinned pair. Each `ticket_templates` row
    // is one immutable version, so the id alone identifies the version *today*
    // — but only while module E clones instead of mutating, and E is built in
    // parallel against the written spec rather than against this code. Reading
    // both columns turns "E mutated a row" from a silently different ticket
    // into a row that refuses to render.
    asAdmin();
    expect((await call(ticketedId)).status).toBe(200);

    await sql`
      update ticket_templates set version = version + 1
       where id = (select ticket_template_id from attendees where id = ${ticketedId})
    `;

    expect((await call(ticketedId)).status).toBe(404);
  });
});

describe('APP_URL is never a deployment hostname', () => {
  it('refuses a per-deployment Vercel URL rather than baking it into a QR', async () => {
    // §10.1 Rule A, decision 30. `APP_URL ?? VERCEL_URL` is a one-line change
    // that looks like a sensible fallback, passes lint and typecheck, and bakes
    // a hostname that dies within days into every ticket — permanently.
    asAdmin();
    const original = process.env.APP_URL;
    process.env.APP_URL = 'https://zetix-h7f2k9x-ztsia.vercel.app';
    try {
      await expect(call(ticketedId)).rejects.toThrow(/per-deployment/);
    } finally {
      process.env.APP_URL = original;
    }
  });

  it('accepts the production alias', async () => {
    asAdmin();
    const original = process.env.APP_URL;
    process.env.APP_URL = 'https://zetix.vercel.app';
    try {
      expect((await call(ticketedId)).status).toBe(200);
    } finally {
      process.env.APP_URL = original;
    }
  });
});
