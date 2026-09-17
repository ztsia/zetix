import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';
import { loadPublicWall } from '@/lib/portal/wall';
import { wallIsPublic } from '@/lib/portal/wall-visibility';

/**
 * What the public wall shows, and — the half that matters — what it does not
 * (spec/v2.md §13.4, decision 6).
 *
 * **Every test here is a privacy test.** This is the one V2 surface that prints
 * one guest's words to another, and each filter it applies is a promise made to
 * the person who wrote them: their name is withheld if they asked, their
 * personal note to a player is never posted, and nothing reaches the page that
 * an admin has not explicitly published.
 */

let concertId: number;
let showId: number;
let segmentId: number;
let playerIds: number[];
let seat = 0;

const PUBLIC_WALL = { enabled: true, visibility: 'AUDIENCE' as const };

/** A note by a fresh attendee, with whatever flags the case needs. */
async function note(opts: {
  body: string;
  moderation?: 'PENDING' | 'APPROVED' | 'HIDDEN';
  wall?: 'NOT_PUBLISHED' | 'PUBLISHED';
  toPlayerId?: number | null;
  displayName?: string | null;
  isAnonymous?: boolean;
  concert?: number;
}): Promise<void> {
  const cId = opts.concert ?? concertId;
  const sId = opts.concert ? await createShow(cId, 50) : showId;
  const segId = opts.concert
    ? await createSegment(sId, { capacity: 50, audienceMode: 'PUBLIC' })
    : segmentId;

  const registrationId = await createRegistration({ showId: sId, segmentId: segId });
  await seedAttendees({
    registrationId, showId: sId, segmentId: segId, count: 1, allocationType: 'BASE',
  });
  const [row] = await sql<{ id: string }[]>`
    select id from attendees where registration_id = ${registrationId} limit 1
  `;

  await sql`
    insert into portal_notes
      (concert_id, show_id, attendee_id, to_player_id, display_name, is_anonymous,
       body, moderation_status, wall_status)
    values (${cId}, ${sId}, ${Number(row.id)}, ${opts.toPlayerId ?? null},
            ${opts.displayName ?? `Writer ${++seat}`}, ${opts.isAnonymous ?? false},
            ${opts.body}, ${opts.moderation ?? 'APPROVED'}, ${opts.wall ?? 'PUBLISHED'})
  `;
}

beforeEach(async () => {
  await resetDb();
  seat = 0;
  concertId = await createConcert('Wall');
  showId = await createShow(concertId, 200);
  segmentId = await createSegment(showId, { capacity: 100, audienceMode: 'PUBLIC' });
  playerIds = await createPlayers(concertId, 2);
});

describe('the two settings that make a wall public', () => {
  it('shows nothing until both say so', async () => {
    await note({ body: 'Wonderful.' });

    for (const gate of [
      { enabled: false, visibility: 'AUDIENCE' as const },
      { enabled: true, visibility: 'ADMIN_ONLY' as const },
      { enabled: false, visibility: 'ADMIN_ONLY' as const },
      { enabled: true, visibility: null },
      { enabled: false, visibility: null },
    ]) {
      expect(await loadPublicWall({ concertId, ...gate })).toEqual([]);
    }

    expect(await loadPublicWall({ concertId, ...PUBLIC_WALL })).toHaveLength(1);
  });

  /**
   * An unresolved setting is not a permissive one. `portal.public_wall_enabled`
   * carries no seed, so null means nobody has configured this concert's wall —
   * exactly as a null capacity means nobody has configured the hall (§2.1).
   */
  it('treats an unconfigured wall as closed', () => {
    expect(wallIsPublic({ enabled: false, visibility: null })).toBe(false);
    expect(wallIsPublic({ enabled: true, visibility: null })).toBe(false);
    expect(wallIsPublic({ enabled: true, visibility: 'ADMIN_ONLY' })).toBe(false);
    expect(wallIsPublic({ enabled: true, visibility: 'AUDIENCE' })).toBe(true);
  });
});

describe('what reaches the wall', () => {
  it('shows a published, approved, unaddressed note', async () => {
    await note({ body: 'The encore was the best of it.', displayName: 'Wei Ling' });

    const wall = await loadPublicWall({ concertId, ...PUBLIC_WALL });
    expect(wall).toHaveLength(1);
    expect(wall[0].body).toBe('The encore was the best of it.');
    expect(wall[0].displayName).toBe('Wei Ling');
  });

  it('never shows one an admin has not published', async () => {
    await note({ body: 'Not yet.', wall: 'NOT_PUBLISHED' });
    expect(await loadPublicWall({ concertId, ...PUBLIC_WALL })).toEqual([]);
  });

  /**
   * The two flags are independent (§13.4), so this is not redundant with the
   * check above: an admin who published a note and later hid it in triage has
   * made a decision, and the wall must honour the later one.
   */
  it('never shows one that has been hidden since it was published', async () => {
    await note({ body: 'Published then hidden.', moderation: 'HIDDEN', wall: 'PUBLISHED' });
    expect(await loadPublicWall({ concertId, ...PUBLIC_WALL })).toEqual([]);
  });

  it('never shows one still waiting for triage', async () => {
    await note({ body: 'Unreviewed.', moderation: 'PENDING', wall: 'PUBLISHED' });
    expect(await loadPublicWall({ concertId, ...PUBLIC_WALL })).toEqual([]);
  });

  /**
   * §13.4: a note addressed to a player is personal mail bound for that
   * player's digest. The admin action refuses to publish one at all, so a row
   * in this state should be unreachable — the filter is the belt to that
   * braces, because "unreachable" is what a later bulk update or a hand-edit
   * quietly breaks, and the cost is somebody's personal message on a public
   * page.
   */
  it('never shows a note addressed to a player, even marked published', async () => {
    await note({ body: 'For you alone.', toPlayerId: playerIds[0], wall: 'PUBLISHED' });
    expect(await loadPublicWall({ concertId, ...PUBLIC_WALL })).toEqual([]);
  });

  it('never shows another concert’s notes', async () => {
    const other = await createConcert('Elsewhere');
    await note({ body: 'Different night.', concert: other });
    expect(await loadPublicWall({ concertId, ...PUBLIC_WALL })).toEqual([]);
  });
});

describe('anonymity', () => {
  /**
   * §13.4 hides the name "on the wall but never from admin", so the name is
   * stored and this read is where it is dropped. Applied in the query rather
   * than the component so that it never reaches the browser at all.
   */
  it('withholds the name, and the name does not reach the caller', async () => {
    await note({ body: 'Rather not say.', displayName: 'Wei Ling', isAnonymous: true });

    const wall = await loadPublicWall({ concertId, ...PUBLIC_WALL });
    expect(wall[0].displayName).toBeNull();
    expect(JSON.stringify(wall)).not.toContain('Wei Ling');
  });

  it('keeps the name when anonymity was not asked for', async () => {
    await note({ body: 'Happy to say.', displayName: 'Wei Ling', isAnonymous: false });
    expect((await loadPublicWall({ concertId, ...PUBLIC_WALL }))[0].displayName).toBe('Wei Ling');
  });
});

describe('ordering and bound', () => {
  it('is newest first', async () => {
    await note({ body: 'First.' });
    await sql`update portal_notes set created_at = now() - interval '1 hour'`;
    await note({ body: 'Second.' });

    const wall = await loadPublicWall({ concertId, ...PUBLIC_WALL });
    expect(wall.map((n) => n.body)).toEqual(['Second.', 'First.']);
  });

  it('is bounded, and the bound can be lowered', async () => {
    for (let i = 0; i < 3; i += 1) await note({ body: `Note ${i}` });
    expect(await loadPublicWall({ concertId, ...PUBLIC_WALL })).toHaveLength(3);
    expect(await loadPublicWall({ concertId, ...PUBLIC_WALL, limit: 2 })).toHaveLength(2);
  });
});
