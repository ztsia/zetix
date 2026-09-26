import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';
import { startCommand } from '@/lib/commands/runner';
import { getCommand } from '@/lib/commands/registry';
import { DeliveryDefaultsError, loadSegmentDelivery, saveSegmentDelivery } from '@/lib/delivery/defaults';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { createRegistration } from '@/lib/registrations/mutations';

/**
 * A segment's delivery defaults (spec/v3.md §24.2): stored on the segment,
 * read by Send tickets, and "inherit" is a real third state.
 */

let concertId: number;
let segmentId: number;
let concertDesign: number;
let galaDesign: number;

async function design(name: string, isDefault: boolean, concert = concertId) {
  const [row] = await sql<{ id: string }[]>`
    insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
    values (${concert}, ${name}, 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}', ${isDefault})
    returning id`;
  return Number(row.id);
}

beforeEach(async () => {
  await resetDb();
  await seedDefaultTemplates();
  concertId = await createConcert('Defaults');
  const showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 40, extrasPolicy: 'AUTO_FCFS', allowPartialGrant: false, name: 'Public' });
  concertDesign = await design('Default', true);
  galaDesign = await design('Gala', false);
  await setSystemSetting('admin.typed_confirm_above', 20);
});

describe('segment delivery defaults', () => {
  it('say what is inherited, store a choice, and Send tickets uses it', async () => {
    const before = await loadSegmentDelivery(concertId, segmentId);
    expect(before).toMatchObject({ designId: null, ticketTemplate: null });
    expect(before?.inherited).toEqual({ designLabel: 'Default · v1', template: 'public_ticket' });

    await saveSegmentDelivery(concertId, segmentId, { designId: galaDesign, ticketTemplate: 'player_confirmation' }, null);
    const after = await loadSegmentDelivery(concertId, segmentId);
    expect(after).toMatchObject({ designId: galaDesign, ticketTemplate: 'player_confirmation' });
    // The segment's own choice never hides what it would inherit without one.
    expect(after?.inherited.designLabel).toBe('Default · v1');

    const { registrationId } = await createRegistration({
      segmentId,
      contactName: 'Party',
      contactEmail: 'p@example.test',
      seats: [{ fullName: 'P One', allocationType: 'EXTRA' }],
    });
    await startCommand(getCommand('delivery.send_tickets')!, { concertId, selection: { ids: [registrationId] }, params: {} }, {
      actorId: null,
      deadline: Date.now() + 60_000,
    });
    const [seat] = await sql<{ ticket_template_id: string }[]>`select ticket_template_id from attendees where registration_id = ${registrationId}`;
    expect(Number(seat.ticket_template_id)).toBe(galaDesign);
    const [message] = await sql<{ template_key: string }[]>`select template_key from email_outbox where registration_id = ${registrationId}`;
    expect(message.template_key).toBe('player_confirmation');

    // Back to inherit: both choices go.
    await saveSegmentDelivery(concertId, segmentId, { designId: null, ticketTemplate: null }, null);
    expect(await loadSegmentDelivery(concertId, segmentId)).toMatchObject({ designId: null, ticketTemplate: null });
    const [rows] = await sql<{ n: number }[]>`select count(*)::int as n from segment_message_defaults`;
    expect(rows.n).toBe(0);
  });

  it('refuses another concert’s design and a template that carries no tickets', async () => {
    const other = await createConcert('Other');
    const foreign = await design('Foreign', true, other);
    await expect(saveSegmentDelivery(concertId, segmentId, { designId: foreign, ticketTemplate: null }, null)).rejects.toBeInstanceOf(
      DeliveryDefaultsError,
    );
    await expect(saveSegmentDelivery(concertId, segmentId, { designId: null, ticketTemplate: 'reminder' }, null)).rejects.toBeInstanceOf(
      DeliveryDefaultsError,
    );
    expect(await loadSegmentDelivery(other, segmentId)).toBeNull();
    void concertDesign;
  });
});
