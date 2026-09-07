import { beforeEach, describe, expect, it } from 'vitest';
import { resolveTemplateForShow } from '@/lib/tickets/seed-templates';
import { issueTickets } from '@/lib/tickets/issue';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  setSystemSetting,
} from '../helpers/fixtures';

/**
 * A ticket template resolves through the cascade (spec/domain.md §5.1).
 *
 * > `ticket_template_id` resolves like any other cascading value: **show →
 * > concert (`ticket.default_template_id`) → the seeded default**. It is
 * > nullable precisely so a concert can set one template for all its shows and a
 * > single show can override it. **Never read the column directly.**
 *
 * An independent QA pass found this missing: resolution went straight to the
 * concert's seeded default, so both overrides were accepted by the admin UI and
 * silently discarded. It matters more than an ignored setting usually would,
 * because the resolved template is **pinned** at issue time (§10.5) — the wrong
 * choice survives being corrected, and only a deliberate reissue undoes it.
 */

let concertId: number;
let showA: number;
let showB: number;
let segmentA: number;

async function makeTemplate(name: string, version = 1): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into ticket_templates (
      concert_id, name, version, background_kind,
      page_width_pt, page_height_pt, layout, is_default
    ) values (
      ${concertId}, ${name}, ${version}, 'NONE', 595, 280,
      '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb, false
    )
    returning id
  `;
  return Number(row.id);
}

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Cascade');
  showA = await createShow(concertId, 100);
  showB = await createShow(concertId, 100);
  segmentA = await createSegment(showA, { capacity: 50, audienceMode: 'PUBLIC' });
});

describe('resolving a show its template', () => {
  it('falls back to the seeded default when nothing overrides', async () => {
    const resolved = await resolveTemplateForShow(showA);
    const [row] = await sql<{ name: string; concert_id: string }[]>`
      select name, concert_id from ticket_templates where id = ${resolved.id}
    `;
    expect(row.name).toBe('Classic Landscape');
    expect(Number(row.concert_id)).toBe(concertId);
  });

  it("prefers the concert's setting over the seeded default", async () => {
    const houseStyle = await makeTemplate('House Style');
    await setSystemSetting('ticket.default_template_id', houseStyle);

    expect((await resolveTemplateForShow(showA)).id).toBe(houseStyle);
  });

  it("prefers the show's own override over the concert's setting", async () => {
    const houseStyle = await makeTemplate('House Style');
    const galaOnly = await makeTemplate('Gala Only');
    await setSystemSetting('ticket.default_template_id', houseStyle);
    await sql`update shows set ticket_template_id = ${galaOnly} where id = ${showA}`;

    expect((await resolveTemplateForShow(showA)).id).toBe(galaOnly);
    // The other show in the same concert still takes the concert's choice.
    expect((await resolveTemplateForShow(showB)).id).toBe(houseStyle);
  });

  it('ignores an override pointing at a deleted template', async () => {
    // A soft-deleted template is not a design anyone can print; falling through
    // is better than failing to issue on the night before a blast.
    const gone = await makeTemplate('Retired');
    await sql`update shows set ticket_template_id = ${gone} where id = ${showA}`;
    await sql`update ticket_templates set deleted_at = now() where id = ${gone}`;

    const resolved = await resolveTemplateForShow(showA);
    expect(resolved.id).not.toBe(gone);
  });

  it('refuses a show that does not exist', async () => {
    await expect(resolveTemplateForShow(999_999)).rejects.toThrow(/does not exist/);
  });
});

describe('issuing honours the cascade', () => {
  it('pins each show its own resolved template', async () => {
    // The consequence that makes this a Major rather than a nicety: resolving
    // once for the whole scope would give every attendee the first show's
    // design, and pinning would make that permanent.
    const galaOnly = await makeTemplate('Gala Only');
    await sql`update shows set ticket_template_id = ${galaOnly} where id = ${showA}`;

    const segmentB = await createSegment(showB, { capacity: 50, audienceMode: 'PUBLIC' });
    const regA = await createRegistration({ showId: showA, segmentId: segmentA });
    const regB = await createRegistration({ showId: showB, segmentId: segmentB });
    await seedAttendees({
      registrationId: regA, showId: showA, segmentId: segmentA, count: 2, allocationType: 'BASE',
    });
    await seedAttendees({
      registrationId: regB, showId: showB, segmentId: segmentB, count: 2, allocationType: 'BASE',
    });

    const result = await issueTickets({ concertId });

    expect(result.pinned).toBe(4);
    const rows = await sql<{ show_id: string; ticket_template_id: string }[]>`
      select show_id, ticket_template_id from attendees order by id
    `;
    for (const row of rows) {
      const expected =
        Number(row.show_id) === showA ? galaOnly : result.templates[showB].id;
      expect(Number(row.ticket_template_id)).toBe(expected);
    }
    // Two shows, two different templates — the whole point.
    expect(result.templates[showA].id).toBe(galaOnly);
    expect(result.templates[showB].id).not.toBe(galaOnly);
  });

  it("pins the concert's setting when a show has no override", async () => {
    const houseStyle = await makeTemplate('House Style');
    await setSystemSetting('ticket.default_template_id', houseStyle);
    const registrationId = await createRegistration({ showId: showA, segmentId: segmentA });
    await seedAttendees({
      registrationId, showId: showA, segmentId: segmentA, count: 2, allocationType: 'BASE',
    });

    await issueTickets({ concertId, showId: showA });

    const rows = await sql<{ ticket_template_id: string }[]>`
      select ticket_template_id from attendees where show_id = ${showA}
    `;
    for (const row of rows) expect(Number(row.ticket_template_id)).toBe(houseStyle);
  });
});
