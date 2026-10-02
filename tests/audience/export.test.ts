import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { createConcert, createSegment, createShow } from '../helpers/fixtures';
import { createRegistration, type NewSeat } from '@/lib/registrations/mutations';
import { exportParties, exportSeats, listParties, matchPartyIds } from '@/lib/audience/queries';
import { getDb } from '@/db/client';

/**
 * Exports cover the whole selection, never the page (spec/v3.md §32.1).
 *
 * The failure this pins: a server-paged table held one page, and Export
 * exported what the table held. The loader now resolves the same selection the
 * commands take, through the listing's own WHERE, with no page limit.
 */

let concertId: number;
let segmentId: number;
const ids: number[] = [];

const seats = (n: number, name: string): NewSeat[] =>
  Array.from({ length: n }, (_, i) => ({ fullName: `${name} ${i + 1}`, allocationType: 'EXTRA' }));

beforeEach(async () => {
  await resetDb();
  ids.length = 0;
  concertId = await createConcert('Export');
  const showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 60, extrasPolicy: 'AUTO_FCFS' });
  // Twelve parties of two: more than one page at a page size of five.
  for (let i = 1; i <= 12; i++) {
    const { registrationId } = await createRegistration({
      segmentId,
      contactName: `Party ${String(i).padStart(2, '0')}`,
      seats: seats(2, `Guest${i}`),
    });
    ids.push(registrationId);
  }
});

describe('a whole-set export', () => {
  it('exports every matching party, not the page on screen', async () => {
    const page = await listParties(concertId, {}, { pageIndex: 0, pageSize: 5, sorting: [] });
    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(12);

    const rows = await exportParties(concertId, { filter: {}, excludedIds: [] }, []);
    expect(rows).toHaveLength(12);
    // The same rows a command given the same filter would act on.
    expect(rows.map((r) => r.id).sort()).toEqual(
      (await matchPartyIds(getDb(), concertId, {})).sort(),
    );
  });

  it('leaves out the rows unticked after "Select all N matching"', async () => {
    const rows = await exportParties(concertId, { filter: {}, excludedIds: [ids[0], ids[7]] }, []);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.id)).not.toContain(ids[7]);
  });

  it('exports the ticked rows across every page, and only those', async () => {
    const rows = await exportParties(concertId, { ids: [ids[1], ids[11]] }, []);
    expect(rows.map((r) => r.id).sort()).toEqual([ids[1], ids[11]].sort());
  });

  it('honours the filter: a search narrows the file as it narrows the table', async () => {
    const rows = await exportParties(concertId, { filter: { search: 'Party 1' }, excludedIds: [] }, []);
    // Party 10, 11, 12 (and nothing that merely shares a page with them).
    expect(rows.map((r) => r.contactName).sort()).toEqual(['Party 10', 'Party 11', 'Party 12']);
  });

  it('follows the table`s sort order', async () => {
    const rows = await exportParties(concertId, { filter: {}, excludedIds: [] }, [
      { id: 'contactName', desc: true },
    ]);
    expect(rows[0].contactName).toBe('Party 12');
  });

  it('exports every seat of the selection in the seats grain', async () => {
    const rows = await exportSeats(concertId, { filter: {}, excludedIds: [] }, []);
    expect(rows).toHaveLength(24);
  });

  it('never exports another concert`s rows by id', async () => {
    const other = await createConcert('Other');
    const otherShow = await createShow(other, 10);
    const otherSeg = await createSegment(otherShow, { audienceMode: 'PUBLIC', capacity: 5, extrasPolicy: 'AUTO_FCFS' });
    const { registrationId } = await createRegistration({ segmentId: otherSeg, contactName: 'Elsewhere', seats: seats(1, 'X') });
    expect(await exportParties(concertId, { ids: [registrationId] }, [])).toEqual([]);
  });
});
