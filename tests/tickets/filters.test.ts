import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attendees, registrations } from '@/db/schema/registrations';
import { showSegments, shows } from '@/db/schema/shows';
import {
  parseTicketFilters,
  ticketSearchParams,
  ticketWhere,
  type TicketFilters,
} from '@/app/(admin)/admin/concerts/[concertId]/tickets/filters';
import { db, resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * The tickets screen's filters (spec/tickets.md §10.5).
 *
 * `ticketWhere()` is shared by the page that *shows* a filtered count and the
 * action that turns the same filters into the ids a mutation acts on, so these
 * run it against real rows rather than asserting on generated SQL: what matters
 * is that both callers touch the same set.
 */

let concertId: number;
let showA: number;
let showB: number;
let publicSegment: number;
let playerSegment: number;
let otherShowSegment: number;
let publicSeats: number[];

const NO_FILTERS: TicketFilters = {
  showId: null,
  segmentId: null,
  status: null,
  ticketState: null,
  search: '',
};

/** Ids of the attendees the filters select, so assertions read as counts. */
async function matching(filters: Partial<TicketFilters>): Promise<number[]> {
  const rows = await db
    .select({ id: attendees.id })
    .from(attendees)
    .innerJoin(registrations, eq(registrations.id, attendees.registrationId))
    .innerJoin(shows, eq(shows.id, attendees.showId))
    .innerJoin(showSegments, eq(showSegments.id, attendees.segmentId))
    .where(ticketWhere(concertId, { ...NO_FILTERS, ...filters }))
    .orderBy(attendees.id);
  return rows.map((row) => row.id);
}

async function nameOf(id: number): Promise<string> {
  const [row] = await sql<{ full_name: string }[]>`
    select full_name from attendees where id = ${id}
  `;
  return row.full_name;
}

describe('ticketWhere', () => {
  beforeEach(async () => {
    await resetDb();

    concertId = await createConcert('Filters');
    showA = await createShow(concertId, 200);
    showB = await createShow(concertId, 200);
    publicSegment = await createSegment(showA, { capacity: 100, audienceMode: 'PUBLIC' });
    // One show holding both a public and a player-invited block is this concert's
    // actual shape (CLAUDE.md), and the reason segment is a filter at all rather
    // than something derivable from the show.
    playerSegment = await createSegment(showA, {
      capacity: 100,
      audienceMode: 'PLAYER_INVITED',
    });
    otherShowSegment = await createSegment(showB, { capacity: 100, audienceMode: 'PUBLIC' });

    const confirmed = await createRegistration({ showId: showA, segmentId: publicSegment });
    await seedAttendees({
      registrationId: confirmed,
      showId: showA,
      segmentId: publicSegment,
      count: 4,
      allocationType: 'BASE',
    });

    const player = await createRegistration({ showId: showA, segmentId: playerSegment });
    await seedAttendees({
      registrationId: player,
      showId: showA,
      segmentId: playerSegment,
      count: 2,
      allocationType: 'BASE',
    });

    const elsewhere = await createRegistration({ showId: showB, segmentId: otherShowSegment });
    await seedAttendees({
      registrationId: elsewhere,
      showId: showB,
      segmentId: otherShowSegment,
      count: 3,
      allocationType: 'BASE',
    });

    const waitlisted = await createRegistration({
      showId: showA,
      segmentId: publicSegment,
      status: 'WAITLIST',
    });
    await seedAttendees({
      registrationId: waitlisted,
      showId: showA,
      segmentId: publicSegment,
      count: 1,
      allocationType: 'EXTRA',
      status: 'WAITLIST',
    });

    // Four ticket states over the confirmed party's four seats: not issued,
    // issued-not-sent, sent, and sent-then-flagged.
    publicSeats = (
      await sql<{ id: number }[]>`
        select id from attendees where registration_id = ${confirmed} order by id
      `
    ).map((row) => Number(row.id));

    await sql`
      update attendees
         set qr_token = 'tok' || id, ticket_template_version = 1, ticket_issued_at = now()
       where id = any(${publicSeats.slice(1)})
    `;
    await sql`
      update attendees set ticket_sent_at = now() where id = any(${publicSeats.slice(2)})
    `;
    await sql`update attendees set needs_reissue = true where id = ${publicSeats[3]}`;
    await sql`update attendees set full_name = 'Findable Person' where id = ${publicSeats[0]}`;
  });

  it('spans the whole concert when nothing is chosen', async () => {
    // 4 public + 2 player + 3 on the other show + 1 waitlisted.
    expect(await matching({})).toHaveLength(10);
  });

  it('narrows to one show', async () => {
    expect(await matching({ showId: showB })).toHaveLength(3);
  });

  it('narrows to one segment inside a show that holds two', async () => {
    expect(await matching({ segmentId: playerSegment })).toHaveLength(2);
    expect(await matching({ segmentId: publicSegment })).toHaveLength(5);
  });

  it('narrows by booking status', async () => {
    expect(await matching({ status: 'WAITLIST' })).toHaveLength(1);
    expect(await matching({ status: 'CONFIRMED' })).toHaveLength(9);
  });

  describe('ticket state', () => {
    it('counts a half-issued row as not issued', async () => {
      // A token with no pinned template cannot be rendered, so it must not
      // count as issued (§10.5).
      await sql`
        update attendees
           set qr_token = 'half-issued', ticket_template_version = null
         where id = ${publicSeats[1]}
      `;
      expect(await matching({ ticketState: 'not_issued' })).toContain(publicSeats[1]);
      expect(await matching({ ticketState: 'issued' })).not.toContain(publicSeats[1]);
    });

    it('separates not issued, issued-not-sent and sent', async () => {
      // 1 of the 4 public seats, plus 2 player, 3 other show, 1 waitlist.
      expect(await matching({ ticketState: 'not_issued' })).toHaveLength(7);
      expect(await matching({ ticketState: 'issued' })).toHaveLength(1);
      expect(await matching({ ticketState: 'sent' })).toHaveLength(2);
    });

    it('reports a flagged ticket as both sent and needing reissue', async () => {
      const flagged = await matching({ ticketState: 'needs_reissue' });
      expect(flagged).toEqual([publicSeats[3]]);
      // Deliberately overlapping: an operator asking "what has been sent" must
      // still see it.
      expect(await matching({ ticketState: 'sent' })).toContain(publicSeats[3]);
    });
  });

  it('searches the attendee name', async () => {
    const found = await matching({ search: 'findable' });
    expect(found).toHaveLength(1);
    expect(await nameOf(found[0])).toBe('Findable Person');
  });

  it('combines filters rather than replacing them', async () => {
    expect(await matching({ segmentId: publicSegment, status: 'WAITLIST' })).toHaveLength(1);
    expect(
      await matching({ segmentId: publicSegment, status: 'WAITLIST', ticketState: 'sent' }),
    ).toHaveLength(0);
  });

  it('excludes a soft-deleted attendee', async () => {
    const all = await matching({});
    await sql`update attendees set deleted_at = now() where id = ${all[0]}`;
    expect(await matching({})).toHaveLength(all.length - 1);
  });
});

describe('parseTicketFilters', () => {
  it('reads a full query string', () => {
    expect(
      parseTicketFilters({
        show: '3',
        segment: '8',
        status: 'CONFIRMED',
        ticket: 'sent',
        q: '  Ada  ',
      }),
    ).toEqual({
      showId: 3,
      segmentId: 8,
      status: 'CONFIRMED',
      ticketState: 'sent',
      search: 'Ada',
    });
  });

  it('drops values that are not ours rather than trusting the URL', () => {
    expect(
      parseTicketFilters({
        show: '-1',
        segment: 'abc',
        status: 'DROP TABLE',
        ticket: 'whatever',
      }),
    ).toEqual({
      showId: null,
      segmentId: null,
      status: null,
      ticketState: null,
      search: '',
    });
  });
});

describe('ticketSearchParams', () => {
  it('round-trips through parseTicketFilters', () => {
    const filters: TicketFilters = {
      showId: 5,
      segmentId: 8,
      status: 'PENDING_REVIEW',
      ticketState: 'not_issued',
      search: 'Wan',
    };
    const params = ticketSearchParams(filters);
    expect(parseTicketFilters(Object.fromEntries(params))).toEqual(filters);
  });

  it('omits defaults so a clean view has a clean URL', () => {
    expect(ticketSearchParams(NO_FILTERS).toString()).toBe('');
    expect(ticketSearchParams(NO_FILTERS, { page: 0, size: 25 }).toString()).toBe('');
  });
});
