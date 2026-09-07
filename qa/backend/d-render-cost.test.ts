/** QA phase 4 — how long one ticket takes to render, by name shape. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES } from '@/lib/tickets/defaults';
import { renderTicket } from '@/lib/tickets/render';
import type { TicketData } from '@/lib/tickets/bindings';

const base: TicketData = {
  attendee: { fullName: 'A', ticketCode: 'ORC-7K4Q', qrToken: 'aB3xY9zQ1mN7pR4tW2kL6v' },
  registration: { contactName: 'Alice Tan' },
  player: null,
  show: {
    name: 'Autumn Serenade',
    startsAt: new Date('2026-09-19T11:30:00Z'),
    doorsOpenAt: new Date('2026-09-19T11:00:00Z'),
    venueName: 'Dewan Filharmonik PETRONAS',
    venueAddress: null,
  },
  concert: { name: 'LCO Season 12', timezone: 'Asia/Singapore' },
  appUrl: 'https://zetix.vercel.app',
};

const layout = DEFAULT_TEMPLATES[0].layout;

async function timeRender(fullName: string): Promise<number> {
  const t0 = Date.now();
  await renderTicket({ layout, data: { ...base, attendee: { ...base.attendee, fullName } } });
  return Date.now() - t0;
}

describe('render cost', () => {
  it('measures realistic names, spaced and unspaced', async () => {
    const cases: [string, string][] = [
      ['typical 17', 'Wellington Lim'],
      ['long spaced 44', 'Guest of Nurul Aisyah binti Abdul Rahman Ali'],
      ['long spaced 80', 'Guest of Nurul Aisyah binti Abdul Rahman Ali and Family Party of Four People'],
      ['unspaced 40', 'W'.repeat(40)],
      ['unspaced 80', 'W'.repeat(80)],
      ['unspaced 160', 'W'.repeat(160)],
    ];
    const out: [string, number][] = [];
    for (const [label, name] of cases) out.push([label, await timeRender(name)]);
    console.log('QA-COST:', JSON.stringify(out));
    expect(out.length).toBe(cases.length);
  }, 300_000);

  it('measures a 50-ticket batch, the unit module F will run', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) await timeRender(`Attendee Number ${i} Lim`);
    const ms = Date.now() - t0;
    console.log('QA-COST: 50 tickets in', ms, 'ms =>', Math.round(ms / 50), 'ms each');
    expect(ms).toBeGreaterThan(0);
  }, 300_000);
});
