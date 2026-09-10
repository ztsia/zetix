import { describe, expect, it } from 'vitest';
import {
  countdownTo,
  formatDate,
  formatDateTime,
  formatTime,
  venueMapUrl,
} from '@/lib/portal/format';

/**
 * The display layer of the ticket status page (spec/v2.md §13.2).
 *
 * The one rule with teeth here is the timezone: every instant renders in the
 * concert's zone and never the machine's (`CLAUDE.md`, spec/domain.md §6.1). A
 * guest opening their ticket from another country must read the doors time the
 * hall will actually open at.
 */

/** 19:30 in Singapore on 19 Sep 2026, expressed as the UTC instant it is. */
const DOORS = new Date('2026-09-19T11:30:00Z');

describe('rendering an instant for the audience', () => {
  it('renders in the concert zone rather than the runner s', () => {
    expect(formatDate(DOORS, 'Asia/Singapore')).toBe('Sat 19 Sep 2026');
    expect(formatTime(DOORS, 'Asia/Singapore')).toBe('19:30');
  });

  it('gives a different clock time for the same instant in another zone', () => {
    // The assertion that proves the zone is actually applied: same Date, two
    // concerts, two answers. A formatter that quietly used the process zone
    // would return one string for both.
    expect(formatTime(DOORS, 'Europe/London')).toBe('12:30');
    expect(formatDate(DOORS, 'Pacific/Auckland')).toBe('Sat 19 Sep 2026');
    expect(formatTime(DOORS, 'Pacific/Auckland')).toBe('23:30');
  });

  it('crosses the date line rather than assuming the day is the same', () => {
    const lateNight = new Date('2026-09-19T20:00:00Z');
    expect(formatDate(lateNight, 'Asia/Singapore')).toBe('Sun 20 Sep 2026');
    expect(formatDate(lateNight, 'America/Los_Angeles')).toBe('Sat 19 Sep 2026');
  });

  it('drops the line rather than printing a time that might be wrong', () => {
    // A concert with no zone has no correct answer, and a confidently wrong
    // doors time is a guest at a locked door. The page hides the row instead.
    expect(formatDate(DOORS, null)).toBeNull();
    expect(formatTime(DOORS, null)).toBeNull();
    expect(formatDateTime(DOORS, null)).toBeNull();
    expect(formatDate(null, 'Asia/Singapore')).toBeNull();
  });

  it('joins date and time for the admitted stamp', () => {
    expect(formatDateTime(DOORS, 'Asia/Singapore')).toBe('Sat 19 Sep 2026, 19:30');
  });
});

describe('the countdown', () => {
  const now = new Date('2026-09-10T00:00:00Z');
  const at = (ms: number) => countdownTo(new Date(now.getTime() + ms), now);

  it('reports one coarse unit, never seconds', () => {
    expect(at(9 * 86_400_000)).toEqual({ open: false, label: '9 days' });
    expect(at(5 * 3_600_000)).toEqual({ open: false, label: '5 hours' });
    expect(at(12 * 60_000)).toEqual({ open: false, label: '12 minutes' });
  });

  it('singularises', () => {
    expect(at(86_400_000)).toEqual({ open: false, label: '1 day' });
    expect(at(3_600_000)).toEqual({ open: false, label: '1 hour' });
    expect(at(60_000)).toEqual({ open: false, label: '1 minute' });
  });

  it('switches unit exactly at the boundary, not near it', () => {
    // 59m59s is still minutes; one second later it is an hour.
    expect(at(3_599_000)).toEqual({ open: false, label: '59 minutes' });
    expect(at(3_600_000)).toEqual({ open: false, label: '1 hour' });
    expect(at(86_399_000)).toEqual({ open: false, label: '23 hours' });
    expect(at(86_400_000)).toEqual({ open: false, label: '1 day' });
  });

  it('never counts up once the moment has passed', () => {
    expect(at(0)).toEqual({ open: true });
    expect(at(-1)).toEqual({ open: true });
    expect(at(-9 * 86_400_000)).toEqual({ open: true });
  });

  it('says less than a minute rather than 0 minutes', () => {
    expect(at(59_000)).toEqual({ open: false, label: 'less than a minute' });
  });

  it('has nothing to count to when the show carries no times', () => {
    expect(countdownTo(null, now)).toBeNull();
  });
});

describe('the venue link', () => {
  it('prefers the address, which places a venue a name alone would not', () => {
    const url = venueMapUrl('Esplanade', '1 Esplanade Dr, Singapore 038981');
    expect(url).toContain('1%20Esplanade%20Dr');
    expect(url).not.toContain('Esplanade%20Dr%2C%20Singapore&');
  });

  it('falls back to the name when there is no address', () => {
    expect(venueMapUrl('Victoria Concert Hall', null)).toContain('Victoria%20Concert%20Hall');
  });

  it('escapes the query rather than pasting it into a URL', () => {
    const url = venueMapUrl(null, 'Hall & Foyer, #02-01');
    expect(url).toContain('Hall%20%26%20Foyer%2C%20%2302-01');
  });

  it('is null when there is nowhere to point, so the row disappears', () => {
    expect(venueMapUrl(null, null)).toBeNull();
    expect(venueMapUrl('   ', '  ')).toBeNull();
  });
});
