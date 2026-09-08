import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { TicketData } from './bindings';

/**
 * The data the editor previews against (spec/tickets.md §10.3).
 *
 * §10.3 asks for two previews, and the second is the one that earns its keep:
 *
 *  - a **real attendee**, so the layout is judged against real strings rather
 *    than lorem ipsum;
 *  - the **longest name in the show**, because a name that overflows its box is
 *    otherwise discovered at four hundred tickets — by which time they are in
 *    four hundred inboxes and the only fix is a reissue.
 *
 * Deliberately *not* `loadTicket()`. That one loads a ticket through its
 * **pinned** template (§10.5) and returns null for an attendee who has none —
 * which is every attendee before a blast, and precisely who an admin is laying
 * the template out for.
 */

export type PreviewSubject = 'FIRST' | 'LONGEST_NAME' | 'SAMPLE';

export type PreviewOption = {
  subject: PreviewSubject;
  attendeeId: number | null;
  label: string;
  fullName: string;
};

/**
 * `APP_URL` for a preview, defaulted rather than demanded.
 *
 * The render path refuses to run without a valid one, because the origin is
 * baked into an issued ticket permanently (§10.1 rule 5). A preview issues
 * nothing and is thrown away, so a missing variable should not stop an admin
 * laying out a template — a QR that encodes a localhost URL still shows whether
 * the symbol fits its box, which is what the preview is for.
 */
function previewAppUrl(): string {
  return process.env.APP_URL || 'http://localhost:3000';
}

type AttendeeRow = {
  id: string;
  full_name: string;
  ticket_code: string | null;
  qr_token: string | null;
  contact_name: string | null;
  player_name: string | null;
  player_instrument: string | null;
};

type ShowRow = {
  id: string;
  name: string;
  starts_at: string | null;
  doors_open_at: string | null;
  venue_name: string | null;
  venue_address: string | null;
  concert_name: string;
  timezone: string | null;
};

async function loadShow(concertId: number, showId: number): Promise<ShowRow | null> {
  const rows = await getDb().execute<ShowRow>(sql`
    select s.id, s.name, s.starts_at, s.doors_open_at, s.venue_name, s.venue_address,
           c.name as concert_name, c.timezone
      from shows s
      join concerts c on c.id = s.concert_id
     where s.id = ${showId}
       and s.concert_id = ${concertId}
       and s.deleted_at is null
       and c.deleted_at is null
     limit 1
  `);
  return rows[0] ?? null;
}

async function loadAttendee(
  showId: number,
  subject: PreviewSubject,
  attendeeId: number | null,
): Promise<AttendeeRow | null> {
  if (subject === 'SAMPLE') return null;

  const base = sql`
    select a.id, a.full_name, a.ticket_code, a.qr_token,
           r.contact_name, p.full_name as player_name, p.instrument as player_instrument
      from attendees a
      join registrations r on r.id = a.registration_id
      left join players p on p.id = r.player_id
     where a.show_id = ${showId}
       and a.deleted_at is null
       and r.deleted_at is null
  `;

  const rows = await getDb().execute<AttendeeRow>(
    attendeeId
      ? sql`${base} and a.id = ${attendeeId} limit 1`
      : subject === 'LONGEST_NAME'
        ? sql`${base} order by length(a.full_name) desc, a.id asc limit 1`
        : sql`${base} order by a.id asc limit 1`,
  );
  return rows[0] ?? null;
}

/**
 * What an admin can preview against, for the picker.
 *
 * `SAMPLE` is always offered and always last: a concert being laid out before
 * its first import has no attendees at all, and the editor still has to be
 * usable then.
 */
export async function previewOptions(
  concertId: number,
  showId: number,
): Promise<PreviewOption[]> {
  const show = await loadShow(concertId, showId);
  if (!show) return [sampleOption()];

  const [first, longest] = await Promise.all([
    loadAttendee(showId, 'FIRST', null),
    loadAttendee(showId, 'LONGEST_NAME', null),
  ]);

  const options: PreviewOption[] = [];
  if (first) {
    options.push({
      subject: 'FIRST',
      attendeeId: Number(first.id),
      label: 'A real attendee',
      fullName: first.full_name,
    });
  }
  if (longest && (!first || longest.id !== first.id)) {
    options.push({
      subject: 'LONGEST_NAME',
      attendeeId: Number(longest.id),
      label: 'Longest name in this show',
      fullName: longest.full_name,
    });
  } else if (longest) {
    // One attendee, who is therefore both. Say so rather than offering the same
    // row twice under two names.
    options[0] = { ...options[0], label: 'The only attendee in this show' };
  }
  options.push(sampleOption());
  return options;
}

function sampleOption(): PreviewOption {
  return {
    subject: 'SAMPLE',
    attendeeId: null,
    label: 'Sample data',
    fullName: SAMPLE.attendee.fullName,
  };
}

/**
 * Stand-in values for a concert with no attendees yet.
 *
 * The name is long on purpose — laying a template out against "Jo Ng" and
 * discovering it at import time is the failure the longest-name preview exists
 * to prevent, and a short sample would walk straight into it.
 */
const SAMPLE: Omit<TicketData, 'concert' | 'show' | 'appUrl'> = {
  attendee: {
    fullName: 'Wellington Mainwaring-Fitzgerald',
    ticketCode: 'ORC-7K4Q',
    qrToken: 'SAMPLEqrTOKENsample22',
  },
  registration: { contactName: 'Wellington Mainwaring-Fitzgerald' },
  player: { fullName: 'Wellington Mainwaring-Fitzgerald', instrument: 'Second violin' },
};

/**
 * Everything a preview render needs, or null when the show is not this
 * concert's.
 *
 * The show is checked against the concert rather than trusted from the request:
 * this feeds a route handler whose caller controls both ids.
 */
export async function previewTicketData(input: {
  concertId: number;
  showId: number;
  subject: PreviewSubject;
  attendeeId?: number | null;
}): Promise<TicketData | null> {
  const show = await loadShow(input.concertId, input.showId);
  if (!show) return null;

  const attendee = await loadAttendee(input.showId, input.subject, input.attendeeId ?? null);

  return {
    attendee: attendee
      ? {
          fullName: attendee.full_name,
          ticketCode: attendee.ticket_code,
          qrToken: attendee.qr_token,
        }
      : SAMPLE.attendee,
    registration: attendee
      ? { contactName: attendee.contact_name }
      : SAMPLE.registration,
    player: attendee
      ? attendee.player_name
        ? { fullName: attendee.player_name, instrument: attendee.player_instrument }
        : null
      : SAMPLE.player,
    show: {
      name: show.name,
      startsAt: show.starts_at ? new Date(show.starts_at) : null,
      doorsOpenAt: show.doors_open_at ? new Date(show.doors_open_at) : null,
      venueName: show.venue_name,
      venueAddress: show.venue_address,
    },
    concert: {
      name: show.concert_name,
      // A concert with no timezone cannot render a real ticket at all
      // (`load.ts` throws), but it can still be laid out. UTC keeps the preview
      // working and the times visibly wrong rather than absent.
      timezone: show.timezone ?? 'UTC',
    },
    appUrl: previewAppUrl(),
  };
}
