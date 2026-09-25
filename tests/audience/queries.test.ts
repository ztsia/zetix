import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow } from '../helpers/fixtures';
import { createRegistration, type NewSeat } from '@/lib/registrations/mutations';
import { filterFromUrl, VIEWS } from '@/lib/audience/filter';
import {
  listParties,
  listSeats,
  matchPartyIds,
  matchSeatIds,
  poolMeters,
  viewCounts,
} from '@/lib/audience/queries';
import { getDb } from '@/db/client';
import { loadPartyRecord } from '@/lib/audience/record';

/**
 * The Audience table's reads — spec/v3.md §22.1–§22.4.
 *
 * The promise under test: a view means the same parties in either grain, the
 * count on the view bar is the number of rows the view lists, and a command
 * given the filter resolves exactly the rows the page showed (§22.3).
 */

let concertId: number;
let segmentId: number;
let reviewSeg: number;

const paging = { pageIndex: 0, pageSize: 25, sorting: [] };

const seats = (n: number, type: NewSeat['allocationType'], name: string): NewSeat[] =>
  Array.from({ length: n }, (_, i) => ({ fullName: `${name} ${i + 1}`, allocationType: type }));

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Views');
  const showId = await createShow(concertId, 50);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 10, extrasPolicy: 'AUTO_FCFS' });
  reviewSeg = await createSegment(showId, {
    audienceMode: 'PLAYER_INVITED',
    capacity: 3,
    extrasPolicy: 'REVIEW',
    name: 'Players',
  });
});

describe('views and grains', () => {
  it('lists the same parties in both grains, and the counts match the rows', async () => {
    const a = await createRegistration({ segmentId, contactName: 'Ada', seats: seats(2, 'EXTRA', 'Ada') });
    const b = await createRegistration({ segmentId, contactName: 'Bea', seats: seats(1, 'EXTRA', 'Bea') });
    await sql`update registrations set approved_at = null where id = ${b.registrationId}`;
    await createRegistration({ segmentId: reviewSeg, contactName: 'Cy', seats: seats(2, 'EXTRA', 'Cy') });

    const needsTickets = filterFromUrl({ view: 'needs-tickets' }, '');
    const parties = await listParties(concertId, needsTickets, paging);
    expect(parties.rows.map((r) => r.id)).toEqual([a.registrationId]);
    const seatPage = await listSeats(concertId, needsTickets, paging);
    expect(seatPage.rows.map((r) => r.registrationId)).toEqual([a.registrationId, a.registrationId]);

    const counts = await viewCounts(concertId, {});
    expect(counts.all).toBe(3);
    expect(counts.views['needs-tickets']).toBe(1);
    expect(counts.views['needs-review']).toBe(2);
    for (const view of VIEWS) {
      const listed = await listParties(concertId, { view: view.id }, paging);
      expect(listed.total, view.id).toBe(counts.views[view.id]);
    }

    // What a command resolves is what the page listed.
    const db = getDb();
    expect(await matchPartyIds(db, concertId, needsTickets)).toEqual([a.registrationId]);
    expect((await matchSeatIds(db, concertId, needsTickets)).length).toBe(2);
  });

  it('searches contact, guest names and ticket codes, and refines seats by status', async () => {
    const a = await createRegistration({ segmentId, contactName: 'Ada', seats: seats(2, 'EXTRA', 'Zelda') });
    await createRegistration({ segmentId, contactName: 'Bea', seats: seats(1, 'EXTRA', 'Bea') });
    expect((await listParties(concertId, { search: 'zeld' }, paging)).rows.map((r) => r.id)).toEqual([
      a.registrationId,
    ]);
    const pending = await listSeats(concertId, { seatStatus: 'PENDING_REVIEW' }, paging);
    expect(pending.total).toBe(0);
    const none = await listSeats(concertId, { ticket: 'none' }, paging);
    expect(none.total).toBe(3);
  });

  it('never lists another concert’s parties', async () => {
    await createRegistration({ segmentId, contactName: 'Mine', seats: seats(1, 'EXTRA', 'M') });
    const other = await createConcert('Other');
    const otherShow = await createShow(other, 10);
    const otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 5, extrasPolicy: 'AUTO_FCFS' });
    await createRegistration({ segmentId: otherSeg, contactName: 'Theirs', seats: seats(1, 'EXTRA', 'T') });
    const page = await listParties(concertId, {}, paging);
    expect(page.rows.map((r) => r.contactName)).toEqual(['Mine']);
  });
});

describe('the pool meter (§22.2)', () => {
  it('shows each segment with extras waiting, and what is left in its pool', async () => {
    await createRegistration({ segmentId: reviewSeg, contactName: 'Cy', seats: seats(2, 'EXTRA', 'Cy') });
    const meters = await poolMeters(concertId);
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({ segmentId: reviewSeg, pendingSeats: 2, pendingParties: 1 });
    expect(meters[0].pool.extras_pool).toBe(3);
  });
});

describe('the party record (§22.4)', () => {
  it('reads the header from the pipeline, the seats, the messages and the activity', async () => {
    const a = await createRegistration({ segmentId, contactName: 'Ada', seats: seats(2, 'EXTRA', 'Ada') });
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status)
      values (${a.registrationId}, 'TICKETS', 'public_ticket', 'a@example.test', 'Your tickets', 'b', 'DRAFT')
    `;
    await sql`
      insert into audit_log (action, entity_type, entity_id) values ('registration.updated', 'registration', ${String(a.registrationId)})
    `;
    const record = await loadPartyRecord(concertId, a.registrationId);
    expect(record?.party.stage).toBe('NEEDS_TICKETS');
    expect(record?.party.provenance).toBe('Entered by an admin');
    expect(record?.seats).toHaveLength(2);
    expect(record?.messages.map((m) => m.subject)).toEqual(['Your tickets']);
    expect(record?.activity.map((r) => r.action)).toContain('registration.updated');

    expect(await loadPartyRecord(concertId + 1, a.registrationId)).toBeNull();
  });
});
