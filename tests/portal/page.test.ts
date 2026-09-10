import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 * The ticket status page as a guest receives it (spec/README.md §4.1, spec/v2.md §13.2).
 *
 * No browser: this calls the real Server Component against the real database
 * and renders its output to markup, which is what the phone would be handed.
 * That covers the three states, what is on the page, and — the half that is
 * easy to leave untested — **what is not**.
 *
 * How it looks on a real phone is a browser job, and belongs to the QA pass.
 */

class NotFoundSignal extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

const TicketPage = (await import('@/app/(portal)/t/[token]/page')).default;
const { issueTickets } = await import('@/lib/tickets/issue');

async function render(token: string): Promise<string> {
  const element = await TicketPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(element);
}

/**
 * Whether the *QR* is on the page.
 *
 * Not `<svg`: every lucide icon is one too, so that assertion passes on a page
 * carrying no QR at all — it would have reported the cancelled state as correct
 * whatever it rendered. `crispEdges` is set by the QR renderer and by nothing
 * else here.
 */
function hasQr(html: string): boolean {
  return html.includes('shape-rendering="crispEdges"');
}

async function outcome(token: string): Promise<string> {
  try {
    await render(token);
    return 'rendered';
  } catch (error) {
    if (error instanceof NotFoundSignal) return 'notFound';
    throw error;
  }
}

let concertId: number;
let showId: number;
let registrationId: number;
let attendeeId: number;
let token: string;
let ticketCode: string;

beforeEach(async () => {
  await resetDb();
  process.env.APP_URL ??= 'https://zetix.vercel.app';

  concertId = await createConcert('Gems of the Classics');
  showId = await createShow(concertId, 100);
  await sql`
    update shows
       set name          = 'Evening Concert',
           starts_at     = '2026-09-19T11:30:00Z',
           doors_open_at = '2026-09-19T11:00:00Z',
           venue_name    = 'Victoria Concert Hall',
           venue_address = '11 Empress Pl, Singapore 179558'
     where id = ${showId}
  `;

  // Named to make a leak obvious if the segment ever reached the page.
  const segmentId = await createSegment(showId, {
    capacity: 50, audienceMode: 'PUBLIC', name: 'PublicBlockSecret',
  });
  registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({
    registrationId, showId, segmentId, count: 2, allocationType: 'BASE',
  });
  await issueTickets({ concertId, showId });

  const rows = await sql<{ id: string; qr_token: string; ticket_code: string }[]>`
    select id, qr_token, ticket_code from attendees order by id
  `;
  attendeeId = Number(rows[0].id);
  token = rows[0].qr_token;
  ticketCode = rows[0].ticket_code;
});

describe('a ticket that has not been used yet', () => {
  it('shows the holder their seat, the QR and where to be', async () => {
    const html = await render(token);
    expect(html).toContain('Guest 1');
    expect(html).toContain('Gems of the Classics');
    expect(html).toContain('Evening Concert');
    expect(html).toContain('Present this QR at the door');
    expect(html).toContain('Victoria Concert Hall');
    expect(html).toContain('11 Empress Pl, Singapore 179558');
    expect(html).toContain(ticketCode);
  });

  it('inlines the QR rather than asking the phone to fetch one', async () => {
    // Venue wifi at the worst possible moment (spec/surfaces.md §15.3).
    const html = await render(token);
    expect(hasQr(html)).toBe(true);
    expect(html).toContain('viewBox="0 0 37 37"');
    expect(html).not.toMatch(/<img[^>]+src=/);
  });

  it('renders every time in the concert s zone, never the machine s', async () => {
    // The concert is Asia/Singapore; doors are 11:00Z, which is 19:00 there.
    const html = await render(token);
    expect(html).toContain('Sat 19 Sep 2026');
    expect(html).toContain('Doors open 19:00');
    expect(html).toContain('Starts 19:30');
    // The UTC clock time must not appear anywhere.
    expect(html).not.toContain('11:00');
    expect(html).not.toContain('11:30');
  });

  it('counts down to the doors rather than to the downbeat', async () => {
    /**
     * Relative to now, deliberately. Pinned to the fixture's 19 Sep 2026 this
     * would assert "in 9 days" until that date and "Doors are open" forever
     * after — a test that passes today and fails on its own, long after anyone
     * remembers why.
     */
    // The extra hour is not padding for its own sake: the countdown floors, so
    // doors at exactly now + 3 days is "in 2 days" by the time the page
    // renders. An hour of slack makes the assertion say what it means.
    await sql`
      update shows
         set doors_open_at = now() + interval '3 days' + interval '1 hour',
             starts_at     = now() + interval '3 days' + interval '2 hours'
       where id = ${showId}
    `;
    const html = await render(token);
    expect(html).toContain('Doors open');
    expect(html).toContain('in 3 days');
  });

  it('links the venue to a map, escaped', async () => {
    const html = await render(token);
    expect(html).toContain('https://www.google.com/maps/search/?api=1&amp;query=');
    expect(html).toContain('11%20Empress%20Pl');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('does not claim they are checked in', async () => {
    const html = await render(token);
    expect(html).not.toContain('Checked in');
    expect(html).not.toContain('Admitted');
  });
});

describe('what the page never says', () => {
  it('never names the segment', async () => {
    // A guest does not need to know they were in the "public" block (§13.3).
    const html = await render(token);
    expect(html).not.toContain('PublicBlockSecret');
    expect(html).not.toContain('PUBLIC');
  });

  it('never names anyone else in the party', async () => {
    const html = await render(token);
    expect(html).not.toContain('Guest 2');
  });

  it('never shows the contact details the registration was made with', async () => {
    /**
     * The page names the attendee and nobody else. The registration's contact
     * is frequently a different person — a player booking for guests — and
     * their address is not this holder's to see. Asserted against the real
     * column values rather than a bare `@`, which Tailwind's own class strings
     * carry.
     */
    const [reg] = await sql<{ contact_email: string | null; contact_name: string }[]>`
      select contact_email, contact_name from registrations where id = ${registrationId}
    `;
    expect(reg.contact_email).toBeTruthy();
    const html = await render(token);
    expect(html).not.toContain(reg.contact_email!);
    expect(html).not.toContain(reg.contact_name);
    expect(html).not.toContain('mailto:');
  });
});

describe('a ticket that has been scanned in', () => {
  beforeEach(async () => {
    await sql`
      insert into check_ins (attendee_id, show_id, scanned_at, source)
      values (${attendeeId}, ${showId}, '2026-09-19T11:12:00Z', 'ONLINE')
    `;
  });

  it('says so, with the time in the concert s zone', async () => {
    const html = await render(token);
    expect(html).toContain('Checked in');
    expect(html).toContain('Admitted Sat 19 Sep 2026, 19:12');
  });

  it('still shows the QR, because V1 has nothing to unlock', async () => {
    /**
     * §13.2 unlocks the full portal on admission — booklet, notes, the wall —
     * and every one of those is V2 (§13.3). V1 shows the same status page with
     * a badge rather than a stub of a surface it does not ship.
     */
    const html = await render(token);
    expect(hasQr(html)).toBe(true);
    expect(html).toContain('Guest 1');
    expect(html).not.toContain('booklet');
    expect(html).not.toContain('Leave a note');
  });
});

describe('a ticket that has been cancelled', () => {
  beforeEach(async () => {
    const { cancelRegistration } = await import('@/lib/registrations/mutations');
    await cancelRegistration(registrationId);
  });

  it('says it is not valid and sends them to a human', async () => {
    const html = await render(token);
    expect(html).toContain('no longer valid');
    expect(html).toContain('front desk');
  });

  it('withholds the QR, because it is not a ticket any more', async () => {
    const html = await render(token);
    expect(hasQr(html)).toBe(false);
    expect(html).not.toContain(token);
    expect(html).not.toContain('Present this QR at the door');
  });

  it('still says which show it was, so the front desk has something to go on', async () => {
    const html = await render(token);
    expect(html).toContain('Evening Concert');
    expect(html).toContain('Victoria Concert Hall');
  });
});

describe('a token that resolves to nothing', () => {
  it('is a 404 for an unknown token', async () => {
    expect(await outcome('ZzZzZzZzZzZzZzZzZzZzZz')).toBe('notFound');
  });

  it('is a 404 for junk, not a crash', async () => {
    for (const junk of ['', 'x', '../../etc/passwd', "' or 1=1--", `${token}x`]) {
      expect(await outcome(junk)).toBe('notFound');
    }
  });

  it('is a 404 for a soft-deleted seat, telling nobody which it was', async () => {
    await withDirectAttendeeWrites(
      (tx) => tx`update attendees set deleted_at = now() where id = ${attendeeId}`,
    );
    expect(await outcome(token)).toBe('notFound');
  });
});
