import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES } from '@/lib/tickets/defaults';
import { renderTicket } from '@/lib/tickets/render';
import type { TicketData } from '@/lib/tickets/bindings';

/**
 * A hostile name must not cost a serverless timeout.
 *
 * An independent QA pass measured an unbroken 240-character name at **19s** and
 * 500 at **87s**, on a route that renders one ticket. The line-breaker walked
 * back one character at a time, re-measuring a growing prefix at every step —
 * quadratic in the word, and cubic once SHRINK retried it at each font size.
 *
 * Names this long are pathological, but they arrive from a public form, and the
 * failure is a dead request rather than an ugly ticket. Bounds are loose on
 * purpose: this is a guard against a return to quadratic behaviour, not a
 * benchmark, and CI machines vary.
 */
const base: TicketData = {
  attendee: { fullName: 'x', ticketCode: 'ORC-7K4Q', qrToken: 'aB3xY9zQ1mN7pR4tW2kL6v' },
  registration: { contactName: null },
  player: null,
  show: {
    name: 'Autumn Serenade',
    startsAt: new Date('2026-09-19T11:30:00Z'),
    doorsOpenAt: new Date('2026-09-19T11:00:00Z'),
    venueName: 'Dewan Filharmonik PETRONAS',
    venueAddress: 'KLCC',
  },
  concert: { name: 'LCO', timezone: 'Asia/Kuala_Lumpur' },
  appUrl: 'https://zetix.vercel.app',
};

describe('render cost', () => {
  it.each([120, 240, 500])('survives an unbroken %i-character name', async (length) => {
    const started = Date.now();
    const { pdf } = await renderTicket({
      layout: DEFAULT_TEMPLATES[0].layout,
      data: { ...base, attendee: { ...base.attendee, fullName: 'W'.repeat(length) } },
    });
    const elapsed = Date.now() - started;

    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
    expect(elapsed, `${length} chars took ${elapsed}ms`).toBeLessThan(5_000);
  });

  it('scales sub-quadratically with name length', async () => {
    // The shape, not the absolute numbers: doubling the input must not
    // quadruple the work. Under the old walk-back it went 19s -> 87s.
    const time = async (length: number) => {
      const started = Date.now();
      await renderTicket({
        layout: DEFAULT_TEMPLATES[0].layout,
        data: { ...base, attendee: { ...base.attendee, fullName: 'W'.repeat(length) } },
      });
      return Date.now() - started;
    };
    await time(50); // warm the font embed
    const short = await time(250);
    const long = await time(500);
    expect(long).toBeLessThan(Math.max(short * 3, 1_500));
  });
});
