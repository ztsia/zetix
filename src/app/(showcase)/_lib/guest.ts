import type { FormSchema } from '@/lib/forms/schema';
import type { NoteRecipient } from '@/lib/portal/notes';
import type { WallNote } from '@/lib/portal/wall';

/**
 * Eleanor's evening, for the two guest pages the landing page runs live: her ticket page before the
 * gala (movement III) and her page after the open rehearsal (the encore). The demo's fictional
 * concert (`scripts/seed-demo.ts`), whose dates are counted from the day it was seeded, so these
 * are counted from today: the gala is always three weeks out, the rehearsal always just over.
 */
export const TIME_ZONE = 'Asia/Kuala_Lumpur';
export const CONCERT = 'Autumn Serenade';
export const GUEST = 'Eleanor Whitfield';
/** The same code the door's working scanner admits, so the QR she holds here is the one it reads. */
export const TICKET_CODE = 'ORC-SDM1';
export const PARTY_SIZE = 3;

export const GALA = {
  name: 'Gala evening',
  venue: 'Lakeside Arts Centre, Main Hall',
  /** Days from today, then the local times. */
  inDays: 20,
  doors: '18:45',
  starts: '19:30',
};

export const REHEARSAL = {
  name: 'Open rehearsal',
  venue: 'Lakeside Arts Centre, Studio Hall',
  inDays: -9,
  doors: '14:30',
  starts: '15:00',
  /** When the door admitted her, local time. */
  admitted: '14:41',
};

/** A local time on a day counted from today, as an instant. The zone is fixed at UTC+8, no DST. */
export function localAt(inDays: number, time: string, now = new Date()): Date {
  const [h, m] = time.split(':').map(Number);
  const local = new Date(now.getTime() + 8 * 3_600_000);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + inDays);
  return new Date(day + (h - 8) * 3_600_000 + m * 60_000);
}

export const PRACTICAL = [
  '**Getting there.** The Lakeside Arts Centre is a five-minute walk from Lakeside station. The car park opens an hour before doors.',
  '',
  '**Doors.** Seating is unreserved; doors open 45 minutes before the start.',
  '',
  '**Your ticket.** Show the QR code on your phone or on paper. One code per person — everyone in your party has their own.',
].join('\n');

/** The demo's feedback form, as `scripts/seed-demo.ts` seeds it. */
export const FEEDBACK_TITLE = 'Open rehearsal — feedback';
export const FEEDBACK_SCHEMA = {
  kind: 'FEEDBACK',
  blocks: [
    {
      id: 'feedback',
      type: 'CUSTOM',
      title: 'How was your afternoon?',
      fields: [
        { key: 'overall', label: 'How much did you enjoy it?', type: 'rating', required: true, system: false, scale: { min: 1, max: 5 } },
        {
          key: 'favourite',
          label: 'Which piece did you like best?',
          type: 'radio',
          required: false,
          system: false,
          options: [
            { value: 'overture', label: 'Overture — An Autumn Morning' },
            { value: 'serenade', label: 'Serenade for Strings' },
            { value: 'suite', label: 'Symphonic Suite — The Lake at Dusk' },
          ],
        },
        { key: 'comments', label: 'Anything else you would like to tell us?', type: 'textarea', required: false, system: false },
      ],
    },
  ],
} as FormSchema;

export const NOTE_MAX_LENGTH = 500;

export const PLAYERS: NoteRecipient[] = [
  { id: 1, name: 'Hana Lindqvist', instrument: 'Violin', section: 'Second violins' },
  { id: 2, name: 'Tomasz Rahman', instrument: 'Cello', section: 'Cellos' },
  { id: 3, name: 'Grace Adeyemi', instrument: 'Flute', section: 'Woodwind' },
  { id: 4, name: 'Felix Moreau', instrument: 'Timpani', section: 'Percussion' },
];

export const WALL: WallNote[] = [
  { id: 1, body: 'Bravo to the second violins. The Serenade was beautiful.', displayName: 'Eleanor' },
  { id: 2, body: 'Lovely afternoon. The percussion kept the little ones spellbound.', displayName: null },
  { id: 3, body: 'First time hearing you live. We will be back for the gala!', displayName: 'Sam & Priya' },
];
