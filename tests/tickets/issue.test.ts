import { beforeEach, describe, expect, it } from 'vitest';
import {
  countNeedingReissue,
  flagReissueForChangedFields,
  issueTickets,
  reissueTickets,
} from '@/lib/tickets/issue';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Pinning and reissue (spec/tickets.md §10.5, §10.6).
 *
 * Both exist because PDFs are **rendered on demand, not stored** (§10.4). A
 * stored PDF cannot drift from what was sent; a regenerated one can, either
 * because the template changed underneath it or because the data did. Every
 * test here is about one of those two drifts.
 */

let concertId: number;
let showId: number;
let segmentId: number;
let registrationId: number;

async function fixture(count = 3) {
  concertId = await createConcert('Pinned');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
  registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({ registrationId, showId, segmentId, count, allocationType: 'BASE' });
}

async function attendees() {
  return sql<
    {
      id: string; qr_token: string | null; ticket_template_id: string | null;
      ticket_template_version: number | null; ticket_issued_at: string | null;
      ticket_sent_at: string | null; needs_reissue: boolean;
    }[]
  >`select * from attendees where show_id = ${showId} order by id`;
}

/** A second template version, as the editor would create one (§10.5). */
async function addVersion(version: number): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into ticket_templates (
      concert_id, name, version, background_kind,
      page_width_pt, page_height_pt, layout, is_default
    ) values (
      ${concertId}, 'Classic Landscape', ${version}, 'NONE', 595, 280,
      ${JSON.stringify({
        canvas: { width_pt: 595, height_pt: 280, dpi: 300 },
        elements: [
          {
            id: 'el_name', type: 'TEXT', binding: 'attendee.full_name',
            x: 40, y: 40, w: 300, h: 30, rotation: 0,
            font_family: 'Inter', font_size: 20, font_weight: 600, color: '#1a1a1a',
            align: 'left', valign: 'middle', max_lines: 1, overflow: 'SHRINK',
          },
        ],
      })}::text::jsonb,
      true
    )
    returning id
  `;
  return Number(row.id);
}

describe('issuing tickets', () => {
  beforeEach(async () => {
    await resetDb();
    await fixture(3);
  });

  it('mints identifiers and pins the template in one step', async () => {
    const result = await issueTickets({ concertId, showId });

    expect(result.minted).toBe(3);
    expect(result.pinned).toBe(3);
    for (const row of await attendees()) {
      expect(row.qr_token).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(Number(row.ticket_template_id)).toBe(result.template.id);
      expect(row.ticket_template_version).toBe(result.template.version);
      expect(row.ticket_issued_at).not.toBeNull();
    }
  });

  it('seeds the concert its templates on the way through', async () => {
    // An unconfigured concert must still be able to issue (decision 10).
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from ticket_templates where concert_id = ${concertId}
    `;
    expect(before[0].n).toBe(0);

    await issueTickets({ concertId, showId });

    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from ticket_templates where concert_id = ${concertId}
    `;
    expect(after[0].n).toBe(3);
  });

  it('is idempotent — pressing it twice changes nothing', async () => {
    // This runs immediately before a blast, and an admin will press it twice.
    await issueTickets({ concertId, showId });
    const before = await attendees();

    const again = await issueTickets({ concertId, showId });

    expect(again.minted).toBe(0);
    expect(again.pinned).toBe(0);
    expect(await attendees()).toEqual(before);
  });

  it('never re-pins an attendee to a newer template', async () => {
    // §10.5's whole point. An attendee already pinned holds a ticket rendered
    // against that version; moving them silently would change a PDF someone may
    // already be holding.
    const first = await issueTickets({ concertId, showId });
    await addVersion(2);

    const second = await issueTickets({ concertId, showId });

    expect(second.template.version).toBe(2);
    expect(second.pinned).toBe(0);
    for (const row of await attendees()) {
      expect(row.ticket_template_version).toBe(first.template.version);
    }
  });

  it('pins a later attendee to the template current when they were issued', async () => {
    // The other half: an edit affects tickets issued afterwards, and only those.
    await issueTickets({ concertId, showId });
    await addVersion(2);
    await seedAttendees({
      registrationId, showId, segmentId, count: 1, allocationType: 'BASE',
    });

    await issueTickets({ concertId, showId });

    const versions = (await attendees()).map((r) => r.ticket_template_version);
    expect(versions.filter((v) => v === 1)).toHaveLength(3);
    expect(versions.filter((v) => v === 2)).toHaveLength(1);
  });

  it('does not issue to a seat nobody granted', async () => {
    await seedAttendees({
      registrationId, showId, segmentId, count: 1,
      allocationType: 'EXTRA', status: 'WAITLIST',
    });

    await issueTickets({ concertId, showId });

    const rows = await sql<{ status: string; ticket_template_id: string | null }[]>`
      select status, ticket_template_id from attendees where show_id = ${showId}
    `;
    for (const row of rows) {
      expect(Boolean(row.ticket_template_id)).toBe(row.status === 'CONFIRMED');
    }
  });
});

describe('reissuing tickets', () => {
  beforeEach(async () => {
    await resetDb();
    await fixture(3);
    await issueTickets({ concertId, showId });
    await sql`update attendees set ticket_sent_at = now(), ticket_sent_source = 'EMAIL' where show_id = ${showId}`;
  });

  it('repins to the current template and clears the sent stamp', async () => {
    await addVersion(2);

    const result = await reissueTickets({ concertId, showId });

    expect(result.repinned).toBe(3);
    expect(result.requeued).toBe(3);
    for (const row of await attendees()) {
      expect(row.ticket_template_version).toBe(2);
      // Clearing this is what puts them back in the pending bucket for the next
      // blast (spec/email.md §11.4). A repin without it leaves the recipient
      // holding a stale PDF and nothing to say so.
      expect(row.ticket_sent_at).toBeNull();
      expect(row.needs_reissue).toBe(false);
    }
  });

  it('never mints a new token', async () => {
    // Decision 28, §10.1 rule 3. A guest who kept the printed first copy must
    // still get through the door.
    const before = (await attendees()).map((r) => r.qr_token);
    await addVersion(2);

    await reissueTickets({ concertId, showId });

    expect((await attendees()).map((r) => r.qr_token)).toEqual(before);
  });

  it('clears a reissue flag it has resolved', async () => {
    await sql`update attendees set needs_reissue = true where show_id = ${showId}`;
    expect(await countNeedingReissue({ showId })).toBe(3);

    await reissueTickets({ concertId, showId });

    expect(await countNeedingReissue({ showId })).toBe(0);
  });

  it('scopes to the attendees it was given', async () => {
    const rows = await attendees();
    const one = Number(rows[0].id);
    await addVersion(2);

    const result = await reissueTickets({ concertId, attendeeIds: [one] });

    expect(result.repinned).toBe(1);
    const after = await attendees();
    expect(after[0].ticket_template_version).toBe(2);
    expect(after[1].ticket_template_version).toBe(1);
    expect(after[1].ticket_sent_at).not.toBeNull();
  });
});

describe('flagging a reissue when bound data changes', () => {
  beforeEach(async () => {
    await resetDb();
    await fixture(2);
    await issueTickets({ concertId, showId });
  });

  it('flags a sent ticket whose printed field changed', async () => {
    await sql`update attendees set ticket_sent_at = now() where show_id = ${showId}`;
    const ids = (await attendees()).map((r) => Number(r.id));

    const flagged = await flagReissueForChangedFields(ids, ['attendee.full_name']);

    expect(flagged).toBe(2);
    expect(await countNeedingReissue({ showId })).toBe(2);
  });

  it('leaves an unsent ticket alone', async () => {
    // Nothing has reached anyone, so nothing can disagree — it simply renders
    // correctly when it does go out.
    const ids = (await attendees()).map((r) => Number(r.id));

    const flagged = await flagReissueForChangedFields(ids, ['attendee.full_name']);

    expect(flagged).toBe(0);
    expect(await countNeedingReissue({ showId })).toBe(0);
  });

  it('ignores a field this concert does not print', async () => {
    // The seeded Classic Landscape carries no `player.instrument`. Correcting an
    // instrument must not raise a reissue count for a ticket that never showed
    // it — a spurious count trains an admin to ignore a real one.
    await sql`update attendees set ticket_sent_at = now() where show_id = ${showId}`;
    const ids = (await attendees()).map((r) => Number(r.id));

    const flagged = await flagReissueForChangedFields(ids, ['player.instrument']);

    expect(flagged).toBe(0);
  });

  it('reads the attendee\'s own pinned template, not the current one', async () => {
    // The version they hold is what they were sent. A later version that drops
    // a field cannot un-diverge a ticket already printed with it.
    await sql`update attendees set ticket_sent_at = now() where show_id = ${showId}`;
    const ids = (await attendees()).map((r) => Number(r.id));
    // Version 2 prints only the name; the pinned version 1 prints the venue too.
    await addVersion(2);

    const flagged = await flagReissueForChangedFields(ids, ['show.venue_name']);

    expect(flagged).toBe(2);
  });

  it('does not double-count an already flagged ticket', async () => {
    await sql`update attendees set ticket_sent_at = now() where show_id = ${showId}`;
    const ids = (await attendees()).map((r) => Number(r.id));
    await flagReissueForChangedFields(ids, ['attendee.full_name']);

    const again = await flagReissueForChangedFields(ids, ['attendee.full_name']);

    expect(again).toBe(0);
    expect(await countNeedingReissue({ showId })).toBe(2);
  });

  it('does nothing for an empty list', async () => {
    expect(await flagReissueForChangedFields([], ['attendee.full_name'])).toBe(0);
    expect(await flagReissueForChangedFields([1, 2], [])).toBe(0);
  });
});
