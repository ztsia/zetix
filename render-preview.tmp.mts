import { writeFileSync } from 'node:fs';
import { DEFAULT_TEMPLATES } from './src/lib/tickets/defaults';
import { renderTicket } from './src/lib/tickets/render';
import type { TicketData } from './src/lib/tickets/bindings';

const OUT = '/tmp/claude-0/-home-user-zetix/ccbebae5-c638-5929-89cb-ae145f866b54/scratchpad';

const data: TicketData = {
  attendee: { fullName: 'Wellington Mainwaring', ticketCode: 'ORC-7K4Q', qrToken: 'aB3xY9zQ1mN7pR4tW2kL6v' },
  registration: { contactName: 'Wellington Mainwaring' },
  player: { fullName: 'Siti Nurhaliza', instrument: 'Violin I' },
  show: {
    name: 'Autumn Serenade',
    startsAt: new Date('2026-09-19T11:30:00Z'),   // 19:30 in Kuala Lumpur
    doorsOpenAt: new Date('2026-09-19T11:00:00Z'),
    venueName: 'Dewan Filharmonik PETRONAS',
    venueAddress: 'KLCC, Kuala Lumpur',
  },
  concert: { name: 'Lakeside Community Orchestra · Season 12', timezone: 'Asia/Kuala_Lumpur' },
  appUrl: 'https://zetix.vercel.app',
};

for (const t of DEFAULT_TEMPLATES) {
  const { pdf, truncated } = await renderTicket({ layout: t.layout, data });
  const file = `${OUT}/${t.name.replace(/\s+/g, '-').toLowerCase()}.pdf`;
  writeFileSync(file, pdf);
  console.log(`${t.name.padEnd(20)} ${String(pdf.length).padStart(7)} bytes  truncated=[${truncated}]  -> ${file}`);
}
