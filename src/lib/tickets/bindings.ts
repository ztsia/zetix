import { TZDate } from '@date-fns/tz';
import { format as formatDate } from 'date-fns';
import { DATE_BINDINGS, type Binding, type Layout, bindingsUsed } from './layout';
import { qrUrl } from './identifiers';

/**
 * Turning a layout's bindings into the strings that get printed
 * (spec/tickets.md §10.2).
 *
 * Everything the renderer needs about one ticket, gathered once. Deliberately a
 * plain object rather than a database query: the renderer is the hot path for a
 * blast of several hundred PDFs, and it must be testable without a database.
 */
export type TicketData = {
  attendee: {
    fullName: string;
    ticketCode: string | null;
    qrToken: string | null;
  };
  registration: {
    contactName: string | null;
  };
  /** Null for a public registration — §12.1 prints it at the door when present. */
  player: {
    fullName: string | null;
    instrument: string | null;
  } | null;
  show: {
    name: string;
    startsAt: Date | null;
    doorsOpenAt: Date | null;
    venueName: string | null;
    venueAddress: string | null;
  };
  concert: {
    name: string;
    /** IANA zone. Timestamps render here, never in the viewer's zone. */
    timezone: string;
  };
  /** The Vercel production alias, frozen before the first render (§10.1). */
  appUrl: string;
};

/**
 * The default pattern for a date binding whose element gives none.
 *
 * Not an operational value — a display format, not a capacity or a deadline.
 * It exists so a template that forgets `format` prints something a human can
 * read rather than a raw ISO timestamp on a ticket.
 */
const DEFAULT_DATE_FORMAT = 'EEE d MMM yyyy, HH:mm';

/**
 * Resolve one binding to its printed string.
 *
 * **A missing value renders empty, never a placeholder or a throw.** Half the
 * bound columns are nullable — `starts_at`, `doors_open_at`, `venue_name`,
 * `venue_address`, and the whole player record for a public registration — and
 * a ticket that fails to render is worse than one with a blank line where the
 * venue would be. The admin sees the gap in the preview; the guest still gets
 * in, because admission matches on `qr_token` and not on anything printed.
 */
export function resolveBinding(
  binding: Binding,
  data: TicketData,
  options: { format?: string } = {},
): string {
  switch (binding) {
    case 'attendee.full_name':
      // Never blank: an unnamed seat carries the generated placeholder
      // "Guest of {contact_name}" (decision 32, spec/v2.md §8.2.1).
      return data.attendee.fullName;
    case 'attendee.ticket_code':
      return data.attendee.ticketCode ?? '';
    case 'attendee.qr_url':
      return data.attendee.qrToken ? qrUrl(data.attendee.qrToken, data.appUrl) : '';
    case 'registration.contact_name':
      return data.registration.contactName ?? '';
    case 'player.full_name':
      return data.player?.fullName ?? '';
    case 'player.instrument':
      return data.player?.instrument ?? '';
    case 'show.name':
      return data.show.name;
    case 'show.starts_at':
      return formatInTimezone(data.show.startsAt, data.concert.timezone, options.format);
    case 'show.doors_open_at':
      return formatInTimezone(data.show.doorsOpenAt, data.concert.timezone, options.format);
    case 'show.venue_name':
      return data.show.venueName ?? '';
    case 'show.venue_address':
      return data.show.venueAddress ?? '';
    case 'concert.name':
      return data.concert.name;
  }
}

/**
 * Render a timestamp in the concert's zone (CLAUDE.md conventions).
 *
 * Not `formatInZone()` from `src/lib/export/`: that one is deliberately fixed to
 * `YYYY-MM-DD HH:mm` so Excel parses it as a date. §10.2 gives each element its
 * own pattern, because "Sat 19 Sep 2026, 19:30" is what belongs on a ticket and
 * an ISO string is not. Different jobs, not a duplicated one.
 *
 * `TZDate` shifts the instant into the target zone so `date-fns` patterns
 * resolve there — the concert's zone, never the zone of whichever machine
 * happens to render the PDF, which for a Vercel function is UTC and for a
 * developer is wherever they are.
 */
function formatInTimezone(
  value: Date | null,
  timezone: string,
  pattern = DEFAULT_DATE_FORMAT,
): string {
  if (!value) return '';
  try {
    return formatDate(new TZDate(value, timezone), pattern);
  } catch {
    // A bad pattern is a template bug, and it must not take the whole blast
    // down: every ticket in the batch shares the template. Fall back to the
    // default pattern, which is known good.
    return formatDate(new TZDate(value, timezone), DEFAULT_DATE_FORMAT);
  }
}

/**
 * Interpolate `{{binding}}` placeholders in a static text element (§10.2's
 * `"Free seating · Doors {{show.doors_open_at}}"`).
 *
 * An unknown placeholder is left exactly as written rather than blanked, so a
 * typo shows up as `{{show.dooors_open_at}}` on the preview — visible and
 * diagnosable — instead of as a mysteriously short line.
 */
export function interpolate(
  text: string,
  data: TicketData,
  options: { format?: string } = {},
): string {
  return text.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g, (whole, name: string) => {
    const binding = name as Binding;
    return isBinding(binding) ? resolveBinding(binding, data, options) : whole;
  });
}

function isBinding(value: string): value is Binding {
  return (DATE_BINDINGS as readonly string[]).includes(value) || KNOWN.has(value);
}

const KNOWN = new Set<string>([
  'attendee.full_name',
  'attendee.ticket_code',
  'attendee.qr_url',
  'registration.contact_name',
  'player.full_name',
  'player.instrument',
  'show.name',
  'show.starts_at',
  'show.doors_open_at',
  'show.venue_name',
  'show.venue_address',
  'concert.name',
]);

/**
 * Which of a layout's bindings resolve to nothing for this attendee.
 *
 * For the editor's preview and the admin's pre-blast check: a template binding
 * `show.venue_name` on a show that has no venue prints a blank line, and the
 * only moment anyone can act on that is before the blast.
 */
export function emptyBindings(layout: Layout, data: TicketData): Binding[] {
  return [...bindingsUsed(layout)].filter((b) => resolveBinding(b, data) === '');
}
