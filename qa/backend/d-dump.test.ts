import { writeFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { DEFAULT_TEMPLATES } from '@/lib/tickets/defaults';
import { renderTicket } from '@/lib/tickets/render';

it('dumps a sample ticket for inspection', async () => {
  const { pdf } = await renderTicket({
    layout: DEFAULT_TEMPLATES[0].layout,
    data: {
      attendee: { fullName: 'Wellington Mainwaring', ticketCode: 'ORC-7K4Q', qrToken: 'aB3xY9zQ1mN7pR4tW2kL6v' },
      registration: { contactName: 'Alice Tan' }, player: null,
      show: { name: 'Evening Show', startsAt: new Date('2026-09-19T11:30:00Z'), doorsOpenAt: new Date('2026-09-19T11:00:00Z'), venueName: 'Esplanade Concert Hall', venueAddress: null },
      concert: { name: 'QA Concert D', timezone: 'Asia/Singapore' },
      appUrl: 'https://zetix.vercel.app',
    },
  });
  writeFileSync('qa-artifacts/D-ticket-render/sample-ticket.pdf', pdf);
  expect(pdf.length).toBeGreaterThan(0);
});
