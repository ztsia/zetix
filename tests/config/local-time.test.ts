import { describe, expect, it } from 'vitest';
import {
  formatShowTime,
  toLocalInput,
} from '@/app/(admin)/admin/concerts/local-time';

/**
 * Times render at the venue's clock, never the viewer's
 * (spec/domain.md §6.1, CLAUDE.md).
 *
 * A QA pass found both functions untested: it broke each in turn — making them
 * render in the process's zone instead of the concert's — and all 682 tests
 * stayed green. The behaviour was right; nothing would have said so if it
 * stopped being.
 *
 * **`toLocalInput` is the destructive one.** The show edit dialog pre-fills
 * from it, `datetime-local` carries no zone of its own, and `updateShowAction`
 * reads whatever it is handed back as wall-clock in the concert's zone. So if
 * this ever formats in the viewer's zone, a committee member opening the dialog
 * abroad and pressing Save — changing nothing — writes `starts_at` back shifted
 * by their offset. That is the door time, on the ticket, in the blast.
 *
 * Every assertion below compares **two zones against each other** as well as
 * against a literal. A function that ignored its `timeZone` argument would
 * return the same string for both, so these fail wherever the suite happens to
 * run rather than only on a machine that is not UTC.
 */

/** 19 Sep 2026, 12:00 UTC — 20:00 in Kuala Lumpur, 08:00 in New York. */
const INSTANT = new Date('2026-09-19T12:00:00.000Z');

const KL = 'Asia/Kuala_Lumpur';
const NY = 'America/New_York';

describe('toLocalInput — what the edit dialog pre-fills', () => {
  it('gives the wall clock at the venue, not the viewer', () => {
    expect(toLocalInput(INSTANT, KL)).toBe('2026-09-19T20:00');
  });

  it('gives a different answer per zone, so the argument cannot be ignored', () => {
    expect(toLocalInput(INSTANT, NY)).toBe('2026-09-19T08:00');
    expect(toLocalInput(INSTANT, KL)).not.toBe(toLocalInput(INSTANT, NY));
  });

  it('round-trips: pre-fill then save leaves the instant untouched', () => {
    // The exact loop the QA pass called out. `toInstant` in the Server Action
    // is the mirror of this; re-deriving it here keeps the test honest about
    // what the pair has to guarantee together.
    const prefilled = toLocalInput(INSTANT, KL);
    const [datePart, timePart] = prefilled.split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);

    // 20:00 in UTC+8 is 12:00Z — the instant we started from.
    const backToUtc = Date.UTC(y, m - 1, d, hh - 8, mm);
    expect(new Date(backToUtc).toISOString()).toBe(INSTANT.toISOString());
  });

  it('is empty for no value and for no zone, rather than guessing one', () => {
    // A concert with no timezone cannot render a time at all; the show form
    // disables the field rather than filling it from the server's clock.
    expect(toLocalInput(null, KL)).toBe('');
    expect(toLocalInput(undefined, KL)).toBe('');
    expect(toLocalInput(INSTANT, null)).toBe('');
  });

  it('emits 00:00 rather than 24:00 at midnight, which the input would reject', () => {
    // en-CA formats midnight as hour "24"; `datetime-local` will not accept it.
    const midnightKL = new Date('2026-09-18T16:00:00.000Z'); // 00:00 on the 19th in KL
    expect(toLocalInput(midnightKL, KL)).toBe('2026-09-19T00:00');
  });
});

describe('formatShowTime — what a person reads', () => {
  it('renders at the venue, not the viewer', () => {
    expect(formatShowTime(INSTANT, KL)).toContain('20:00');
    expect(formatShowTime(INSTANT, KL)).toContain('19 Sept 2026');
  });

  it('gives a different answer per zone, so the argument cannot be ignored', () => {
    expect(formatShowTime(INSTANT, NY)).toContain('08:00');
    expect(formatShowTime(INSTANT, KL)).not.toBe(formatShowTime(INSTANT, NY));
  });

  it('falls back to UTC when the concert has no zone, and says so consistently', () => {
    // Not the server's zone: a missing concert timezone is a configuration gap
    // the overview reports, and rendering it in whatever zone the container
    // happens to sit in would make the same show read differently per deploy.
    expect(formatShowTime(INSTANT, null)).toContain('12:00');
  });

  it('is null for no value, so a caller renders "No date set" rather than "Invalid Date"', () => {
    expect(formatShowTime(null, KL)).toBeNull();
    expect(formatShowTime(undefined, KL)).toBeNull();
  });

  it('crosses the date line correctly — the venue day, not the UTC day', () => {
    // 23:30 on the 19th in Kuala Lumpur is 15:30Z on the same day; in New York
    // that same instant is still the 19th at 11:30. A concert late enough in
    // the KL evening lands on the *next* UTC day, which is where a naive
    // formatter shows the wrong date on a ticket.
    const lateKL = new Date('2026-09-19T16:30:00.000Z'); // 00:30 on the 20th in KL
    expect(formatShowTime(lateKL, KL)).toContain('20 Sept 2026');
    expect(formatShowTime(lateKL, 'UTC')).toContain('19 Sept 2026');
  });
});
