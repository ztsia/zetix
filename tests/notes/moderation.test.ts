import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Triage and publishing (spec/admin.md §14.2, spec/v2.md §13.4).
 *
 * The guards are `action-guards.test.ts`'s subject; this file is what the
 * actions *do* once past them. Two properties carry the weight:
 *
 * - **The two flags stay independent** (§13.4). Approving does not publish and
 *   publishing does not approve, and the wall requires both.
 * - **A note written to a player never goes on the wall**, and the refusal is
 *   the whole call rather than a partial success.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const admin = { id: randomUUID(), role: 'ADMIN' as const, email: 'a@test', displayName: 'Admin' };
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: async () => admin,
  recordLogin: async () => {},
}));

const actions = await import('@/app/(admin)/admin/concerts/[concertId]/notes/actions');
const { loadPublicWall } = await import('@/lib/portal/wall');

let concertId: number;
let showId: number;
let segmentId: number;
let playerIds: number[];
let seat = 0;

async function note(opts: {
  body: string;
  toPlayerId?: number | null;
  moderation?: 'PENDING' | 'APPROVED' | 'HIDDEN';
  wall?: 'NOT_PUBLISHED' | 'PUBLISHED';
  concert?: number;
  show?: number;
  segment?: number;
}): Promise<number> {
  const cId = opts.concert ?? concertId;
  const sId = opts.show ?? showId;
  const segId = opts.segment ?? segmentId;
  const registrationId = await createRegistration({ showId: sId, segmentId: segId });
  await seedAttendees({
    registrationId, showId: sId, segmentId: segId, count: 1, allocationType: 'BASE',
  });
  const [attendee] = await sql<{ id: string }[]>`
    select id from attendees where registration_id = ${registrationId} limit 1
  `;
  const [row] = await sql<{ id: string }[]>`
    insert into portal_notes
      (concert_id, show_id, attendee_id, to_player_id, display_name, is_anonymous,
       body, moderation_status, wall_status)
    values (${cId}, ${sId}, ${Number(attendee.id)}, ${opts.toPlayerId ?? null},
            ${`Writer ${++seat}`}, false, ${opts.body},
            ${opts.moderation ?? 'PENDING'}, ${opts.wall ?? 'NOT_PUBLISHED'})
    returning id
  `;
  return Number(row.id);
}

const read = (id: number) => sql<
  { moderation_status: string; wall_status: string; moderated_by: string | null; moderated_at: string | null }[]
>`select moderation_status, wall_status, moderated_by, moderated_at from portal_notes where id = ${id}`;

const setSetting = async (key: string, value: unknown) => {
  await sql`
    insert into system_settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
};

beforeEach(async () => {
  await resetDb();
  seat = 0;
  concertId = await createConcert('Triage');
  showId = await createShow(concertId, 200);
  segmentId = await createSegment(showId, { capacity: 100, audienceMode: 'PUBLIC' });
  playerIds = await createPlayers(concertId, 2);

  await sql`
    insert into app_users (id, email, display_name, role)
    values (${admin.id}, ${admin.email}, ${admin.displayName}, 'ADMIN')
    on conflict (id) do nothing
  `;

  /**
   * §13.4 permits publishing "only when the concert has the wall enabled", so
   * every publish test needs this on. `wall-off.test` below is the one that
   * turns it back off.
   */
  await setSetting('portal.public_wall_enabled', true);
});

describe('approving and hiding', () => {
  it('approves in bulk and records who decided', async () => {
    const ids = [await note({ body: 'One.' }), await note({ body: 'Two.' })];

    const result = await actions.moderateNotesAction(concertId, ids, 'APPROVED');
    expect(result.error).toBeNull();
    expect(result.message).toBe('2 notes approved');

    for (const id of ids) {
      const [row] = await read(id);
      expect(row.moderation_status).toBe('APPROVED');
      expect(row.moderated_by).toBe(admin.id);
      expect(row.moderated_at).not.toBeNull();
    }
  });

  it('counts one note in the singular', async () => {
    const id = await note({ body: 'Alone.' });
    expect((await actions.moderateNotesAction(concertId, [id], 'HIDDEN')).message).toBe(
      '1 note hidden',
    );
  });

  /**
   * Sending a note back to review clears the verdict with it. The old decision
   * was about a text somebody has since questioned; leaving the moderator on
   * the row credits them with a judgement they are no longer making.
   */
  it('clears the moderator when a note goes back to review', async () => {
    const id = await note({ body: 'Reconsider.' });
    await actions.moderateNotesAction(concertId, [id], 'APPROVED');
    await actions.moderateNotesAction(concertId, [id], 'PENDING');

    const [row] = await read(id);
    expect(row.moderation_status).toBe('PENDING');
    expect(row.moderated_by).toBeNull();
    expect(row.moderated_at).toBeNull();
  });

  /**
   * The screen is per concert and so is the action. Without the predicate an
   * admin on one concert's screen could moderate another's by editing an id.
   */
  it('never touches another concert’s note', async () => {
    const other = await createConcert('Elsewhere');
    const otherShow = await createShow(other, 50);
    const otherSegment = await createSegment(otherShow, { capacity: 50, audienceMode: 'PUBLIC' });
    const stranger = await note({
      body: 'Not yours.', concert: other, show: otherShow, segment: otherSegment,
    });

    const result = await actions.moderateNotesAction(concertId, [stranger], 'APPROVED');
    expect(result.message).toBe('0 notes approved');
    expect((await read(stranger))[0].moderation_status).toBe('PENDING');
  });

  it('refuses an empty selection', async () => {
    expect((await actions.moderateNotesAction(concertId, [], 'APPROVED')).error).toBe(
      'Select at least one note.',
    );
  });
});

describe('the two flags stay independent', () => {
  it('approving does not publish', async () => {
    const id = await note({ body: 'Approved only.' });
    await actions.moderateNotesAction(concertId, [id], 'APPROVED');
    expect((await read(id))[0].wall_status).toBe('NOT_PUBLISHED');
  });

  it('publishing does not approve, and the wall stays empty until both', async () => {
    const id = await note({ body: 'Published only.' });
    await actions.setNotesOnWallAction(concertId, [id], true);

    const [row] = await read(id);
    expect(row.wall_status).toBe('PUBLISHED');
    expect(row.moderation_status).toBe('PENDING');

    const gate = { enabled: true, visibility: 'AUDIENCE' as const };
    expect(await loadPublicWall({ concertId, ...gate })).toEqual([]);

    await actions.moderateNotesAction(concertId, [id], 'APPROVED');
    expect(await loadPublicWall({ concertId, ...gate })).toHaveLength(1);
  });

  /**
   * Hiding a published note takes it off the wall immediately, without this
   * action touching `wall_status` — the read requires both flags, which is why
   * they can stay independent without the wall ever showing a hidden note.
   */
  it('hiding an approved, published note removes it from the wall at once', async () => {
    const id = await note({ body: 'On, then off.', moderation: 'APPROVED', wall: 'PUBLISHED' });
    const gate = { enabled: true, visibility: 'AUDIENCE' as const };
    expect(await loadPublicWall({ concertId, ...gate })).toHaveLength(1);

    await actions.moderateNotesAction(concertId, [id], 'HIDDEN');
    expect(await loadPublicWall({ concertId, ...gate })).toEqual([]);
    /** Still marked published — the decision was about review, not the wall. */
    expect((await read(id))[0].wall_status).toBe('PUBLISHED');
  });

  it('unpublishes without changing the review verdict', async () => {
    const id = await note({ body: 'Off the wall.', moderation: 'APPROVED', wall: 'PUBLISHED' });
    await actions.setNotesOnWallAction(concertId, [id], false);

    const [row] = await read(id);
    expect(row.wall_status).toBe('NOT_PUBLISHED');
    expect(row.moderation_status).toBe('APPROVED');
  });
});

describe('a note written to a player is never published', () => {
  /**
   * §13.4 calls an addressed note personal mail bound for that player's
   * digest. Publishing one is a privacy decision the writer never made, and
   * unlike every other mistake on this screen it cannot be undone — a guest
   * who has read it has read it.
   */
  it('refuses the whole call rather than publishing the rest', async () => {
    const open = await note({ body: 'For everyone.', moderation: 'APPROVED' });
    const personal = await note({
      body: 'For you alone.', toPlayerId: playerIds[0], moderation: 'APPROVED',
    });

    const result = await actions.setNotesOnWallAction(concertId, [open, personal], true);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('personal');

    /**
     * Nothing was published — not even the one that could have been. A partial
     * success an admin skims past is how the wrong note ends up public: they
     * select forty, read "38 published", and never learn which two were not.
     */
    expect((await read(open))[0].wall_status).toBe('NOT_PUBLISHED');
    expect((await read(personal))[0].wall_status).toBe('NOT_PUBLISHED');
  });

  it('names who the note was written to, so it can be found and deselected', async () => {
    await sql`update players set full_name = 'Ada Lim' where id = ${playerIds[0]}`;
    const personal = await note({ body: 'Yours.', toPlayerId: playerIds[0] });

    const result = await actions.setNotesOnWallAction(concertId, [personal], true);
    expect(result.error).toContain('Ada Lim');
  });

  it('publishes the unaddressed ones once the personal note is deselected', async () => {
    const open = await note({ body: 'For everyone.', moderation: 'APPROVED' });
    await note({ body: 'For you.', toPlayerId: playerIds[0] });

    const result = await actions.setNotesOnWallAction(concertId, [open], true);
    expect(result.error).toBeNull();
    expect((await read(open))[0].wall_status).toBe('PUBLISHED');
  });

  /** Unpublishing is always allowed — taking something down is never the risk. */
  it('still allows an addressed note to be unpublished', async () => {
    const personal = await note({
      body: 'Somehow up.', toPlayerId: playerIds[0], wall: 'PUBLISHED',
    });
    const result = await actions.setNotesOnWallAction(concertId, [personal], false);
    expect(result.error).toBeNull();
    expect((await read(personal))[0].wall_status).toBe('NOT_PUBLISHED');
  });
});

describe('publishing needs the concert to have a wall', () => {
  /**
   * Nothing unsafe reaches a guest without this — `loadPublicWall` gates on
   * the same setting independently. What it fixes is what the *admin*
   * believes: a screen that marks forty notes PUBLISHED on a concert with no
   * wall has said forty times that something happened, and no guest sees any
   * of it.
   */
  it('refuses, and says how to turn it on, when the wall is off', async () => {
    await setSetting('portal.public_wall_enabled', false);
    const id = await note({ body: 'Nowhere to go.', moderation: 'APPROVED' });

    const result = await actions.setNotesOnWallAction(concertId, [id], true);
    expect(result.error).toContain('Public wall enabled');
    expect((await read(id))[0].wall_status).toBe('NOT_PUBLISHED');
  });

  /**
   * `ADMIN_ONLY` is the state for choosing the notes before anyone reads
   * them, so requiring `enabled` costs the curate-then-reveal workflow
   * nothing — it asks only that the wall exists.
   */
  it('allows publishing while visibility is still ADMIN_ONLY', async () => {
    await setSetting('portal.public_wall_enabled', true);
    await setSetting('portal.public_wall_visibility', 'ADMIN_ONLY');
    const id = await note({ body: 'Chosen early.', moderation: 'APPROVED' });

    expect((await actions.setNotesOnWallAction(concertId, [id], true)).error).toBeNull();
    expect((await read(id))[0].wall_status).toBe('PUBLISHED');
    /** Still invisible to a guest, which is the point of ADMIN_ONLY. */
    expect(await loadPublicWall({ concertId, enabled: true, visibility: 'ADMIN_ONLY' })).toEqual([]);
  });

  /** Taking notes down is never gated — removing is never the risk. */
  it('still allows unpublishing when the wall has been turned off', async () => {
    const id = await note({ body: 'Up already.', moderation: 'APPROVED', wall: 'PUBLISHED' });
    await setSetting('portal.public_wall_enabled', false);

    expect((await actions.setNotesOnWallAction(concertId, [id], false)).error).toBeNull();
    expect((await read(id))[0].wall_status).toBe('NOT_PUBLISHED');
  });
});

describe('a selection larger than the screen can send', () => {
  /**
   * The refusal used to read "Select at least one note." for a selection of
   * five thousand, which is the opposite of what happened. A concert of
   * several shows holds one note per seat per show and Select-all is one
   * click, so this is reachable rather than theoretical.
   */
  it('says the limit rather than claiming nothing was selected', async () => {
    const tooMany = Array.from({ length: 5001 }, (_, i) => i + 1);
    const result = await actions.moderateNotesAction(concertId, tooMany, 'APPROVED');
    expect(result.error).toContain('5000');
    expect(result.error).not.toContain('at least one');
  });

  it('still says "at least one" for an empty selection', async () => {
    expect((await actions.moderateNotesAction(concertId, [], 'APPROVED')).error).toBe(
      'Select at least one note.',
    );
  });
});

describe('a soft-deleted note is out of reach', () => {
  it('is not moderated, published, or listed', async () => {
    const id = await note({ body: 'Removed.', moderation: 'PENDING' });
    await sql`update portal_notes set deleted_at = now() where id = ${id}`;

    expect((await actions.moderateNotesAction(concertId, [id], 'APPROVED')).message).toBe(
      '0 notes approved',
    );
    expect((await read(id))[0].moderation_status).toBe('PENDING');

    await actions.setNotesOnWallAction(concertId, [id], true);
    expect((await read(id))[0].wall_status).toBe('NOT_PUBLISHED');

    const { loadNotesScreen } = await import(
      '@/app/(admin)/admin/concerts/[concertId]/notes/queries'
    );
    expect((await loadNotesScreen(concertId))!.notes).toEqual([]);
  });
});

describe('queueing a digest from the screen', () => {
  it('reports who was skipped and why, rather than failing silently', async () => {
    await sql`update players set full_name = 'Ada Lim', email = null where id = ${playerIds[0]}`;
    await sql`update players set full_name = 'Ben Ong' where id = ${playerIds[1]}`;
    await note({ body: 'For Ada.', toPlayerId: playerIds[0], moderation: 'APPROVED' });

    const { seedDefaultTemplates } = await import('@/lib/email/defaults');
    await seedDefaultTemplates();

    const result = await actions.queueDigestAction(concertId, playerIds);
    /**
     * Not an error: nothing failed, the admin asked a question and these are
     * the answers. A red alert reads as a fault rather than a step still to do.
     */
    expect(result.error).toBeNull();
    expect(result.message).toContain('Ada Lim has no email address on file');
    expect(result.message).toContain('Ben Ong has no approved notes yet');
  });

  it('refuses an empty selection', async () => {
    expect((await actions.queueDigestAction(concertId, [])).error).toBe(
      'Select at least one player.',
    );
  });
});
