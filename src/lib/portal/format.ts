/**
 * Turning instants into what the ticket holder reads.
 *
 * No `server-only` here: the countdown ticks in the browser and shares
 * {@link countdownTo} with the server render, which is what stops the first
 * painted frame and the first tick disagreeing.
 *
 * These do not duplicate `src/lib/export/columns.ts`. That one renders
 * `2026-09-19 19:30` into a spreadsheet cell, where a sortable machine format
 * is the point; this one renders `Sat 19 Sep 2026` at arm's length in a dark
 * foyer. Sharing an implementation would mean one of the two surfaces getting
 * the other's format.
 */

/**
 * **Every timestamp on this page resolves in the concert's zone, never the
 * viewer's** (`CLAUDE.md`, spec/domain.md §6.1). A guest checking their ticket
 * from another country must read the doors time the hall will actually open at.
 *
 * A null zone returns null, and the caller drops the line rather than printing
 * a time that might be hours wrong. That mirrors how the renderer treats a
 * missing bound value (spec/tickets.md, `resolveBinding`): a blank line is a
 * disappointment, a confidently wrong doors time is a guest at a locked door.
 */
export function formatDate(value: Date | null, timeZone: string | null): string | null {
  if (!value || !timeZone) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  /**
   * Assembled from parts rather than taken from `format()`, the same way
   * `src/lib/export/columns.ts` and the admin's `toLocalInput` do, and for the
   * same reason: the joined output is ICU's to change. Here it hands back
   * `Sat, 19 Sept 2026` — a comma this line does not want, and a four-letter
   * `Sept` that is the only month ICU abbreviates past three, which makes the
   * date jump width between September and every other month on a page whose
   * layout is fixed. The slice pins all twelve to three letters.
   */
  return `${get('weekday')} ${get('day')} ${get('month').slice(0, 3)} ${get('year')}`;
}

export function formatTime(value: Date | null, timeZone: string | null): string | null {
  if (!value || !timeZone) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

/** `Sat 19 Sep 2026, 19:30`, or null if either half is unavailable. */
export function formatDateTime(value: Date | null, timeZone: string | null): string | null {
  const date = formatDate(value, timeZone);
  const time = formatTime(value, timeZone);
  if (!date) return null;
  return time ? `${date}, ${time}` : date;
}

export type Countdown =
  /** The moment has passed — the page says so rather than counting up. */
  | { open: true }
  | { open: false; label: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long until `target`, in one unit, for §13.2's countdown.
 *
 * **Coarse on purpose.** Whole days, hours or minutes — never seconds. A
 * seconds display would force a one-second timer on a page that is often open
 * for a minute on venue wifi, and buy the reader nothing: someone checking
 * their ticket three days early wants "in 3 days", and someone in the queue
 * wants the QR, not a clock.
 *
 * The unit boundaries are display granularity rather than operational values —
 * there is no policy here to make admin-editable (`CLAUDE.md`, decision 18).
 */
export function countdownTo(target: Date | null, now: Date): Countdown | null {
  if (!target) return null;
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return { open: true };
  if (ms < MINUTE) return { open: false, label: 'less than a minute' };
  if (ms < HOUR) return { open: false, label: plural(Math.floor(ms / MINUTE), 'minute') };
  if (ms < DAY) return { open: false, label: plural(Math.floor(ms / HOUR), 'hour') };
  return { open: false, label: plural(Math.floor(ms / DAY), 'day') };
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * A maps link for the venue, or null when there is nothing to point at.
 *
 * A plain search URL rather than a provider's deep link or embedded map: it
 * opens in whatever the phone has, adds no third-party script to a page that
 * must load on 3G, and leaks nothing about who is asking. The address is
 * preferred over the name because a name alone can land the wrong side of a
 * city.
 */
export function venueMapUrl(name: string | null, address: string | null): string | null {
  const query = address?.trim() || name?.trim();
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
