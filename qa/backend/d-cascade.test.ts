/** AC-31 — does the template resolve through the cascade at all? */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createRegistration, createSegment, createShow, seedAttendees } from '../../tests/helpers/fixtures';
import { issueTickets } from '@/lib/tickets/issue';
import { resolveSetting } from '@/db/settings';
import { DEFAULT_TEMPLATES } from '@/lib/tickets/defaults';

describe('AC-31 the four-level cascade for ticket_template_id', () => {
  let concertId: number, showId: number, segmentId: number;
  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert('Cascade');
    showId = await createShow(concertId, 100);
    segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
    const reg = await createRegistration({ showId, segmentId });
    await seedAttendees({ registrationId: reg, showId, segmentId, count: 1, allocationType: 'BASE' });
  });

  it('ignores concerts.defaults -> ticket.default_template_id', async () => {
    await issueTickets({ concertId, showId }); // seeds the three defaults
    const [alt] = await sql<{ id: string }[]>`
      insert into ticket_templates (concert_id, name, version, background_kind,
        page_width_pt, page_height_pt, layout, is_default)
      values (${concertId}, 'Concert Default', 1, 'NONE', 842, 210,
        ${JSON.stringify(DEFAULT_TEMPLATES[2].layout)}::text::jsonb, false) returning id`;
    await sql`update concerts set defaults = ${JSON.stringify({ 'ticket.default_template_id': Number(alt.id) })}::text::jsonb where id = ${concertId}`;

    const viaCascade = await resolveSetting('ticket.default_template_id', { concertId });
    const reg = await createRegistration({ showId, segmentId });
    await seedAttendees({ registrationId: reg, showId, segmentId, count: 1, allocationType: 'BASE' });
    const result = await issueTickets({ concertId, showId });

    console.log('QA-CASCADE resolveSetting says', JSON.stringify(viaCascade),
      '| issueTickets pinned template', result.templates[showId].id, '| the concert default is', Number(alt.id));
    expect(viaCascade).toBe(Number(alt.id));
    expect(result.templates[showId].id).not.toBe(Number(alt.id));
  });
});
