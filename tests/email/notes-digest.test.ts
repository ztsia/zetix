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
import { notesList, queueNotesDigest } from '@/lib/email/notes-digest';

/**
 * The player notes digest (spec/email.md §11.3, spec/admin.md §14.2).
 *
 * **This is the one place V2 touches a V1 non-negotiable** (`modules-v2.md`
 * §3.1): the digest is addressed to a player, who has no registration, and
 * `email_outbox.registration_id` is the key that makes a repeat blast harmless.
 * `J` kept the guarantee by adding a disjoint second key rather than swapping
 * the first, and the tests here are what prove this caller uses it correctly —
 * `J`'s own handoff asks for exactly this: "queue a digest with `player_id` set
 * and `registration_id` null; `on conflict do nothing` works exactly as it does
 * for tickets."
 */

let concertId: number;
let showId: number;
let segmentId: number;
let playerIds: number[];
let seat = 0;

/** A note by a fresh attendee, addressed as the case needs. */
async function note(opts: {
  body: string;
  toPlayerId?: number | null;
  moderation?: 'PENDING' | 'APPROVED' | 'HIDDEN';
  displayName?: string | null;
  isAnonymous?: boolean;
}): Promise<void> {
  const registrationId = await createRegistration({ showId, segmentId });
  await seedAttendees({ registrationId, showId, segmentId, count: 1, allocationType: 'BASE' });
  const [row] = await sql<{ id: string }[]>`
    select id from attendees where registration_id = ${registrationId} limit 1
  `;
  await sql`
    insert into portal_notes
      (concert_id, show_id, attendee_id, to_player_id, display_name, is_anonymous,
       body, moderation_status, wall_status)
    values (${concertId}, ${showId}, ${Number(row.id)}, ${opts.toPlayerId ?? null},
            ${opts.displayName ?? `Writer ${++seat}`}, ${opts.isAnonymous ?? false},
            ${opts.body}, ${opts.moderation ?? 'APPROVED'}, 'NOT_PUBLISHED')
  `;
}

const outbox = () => sql<
  {
    id: string;
    registration_id: string | null;
    player_id: string | null;
    template_key: string;
    to_email: string;
    to_name: string | null;
    subject: string;
    body_md: string;
    status: string;
  }[]
>`select * from email_outbox order by id`;

beforeEach(async () => {
  await resetDb();
  seat = 0;
  concertId = await createConcert('Digest');
  showId = await createShow(concertId, 200);
  segmentId = await createSegment(showId, { capacity: 100, audienceMode: 'PUBLIC' });
  playerIds = await createPlayers(concertId, 3);

  const { seedDefaultTemplates } = await import('@/lib/email/defaults');
  await seedDefaultTemplates();
});

describe('the shape of the row, which is the non-negotiable', () => {
  it('sets player_id and leaves registration_id null', async () => {
    await note({ body: 'Beautiful solo.', toPlayerId: playerIds[0] });

    const result = await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    expect(result.queued).toBe(1);

    const [row] = await outbox();
    expect(Number(row.player_id)).toBe(playerIds[0]);
    expect(row.registration_id).toBeNull();
    expect(row.template_key).toBe('player_notes_digest');
    expect(row.status).toBe('DRAFT');
  });

  /**
   * §3.1's warning in full: without the check constraint a row addressed to
   * nobody conflicts with nothing, `on conflict do nothing` silently does
   * nothing, and the digest sends twice with no error anywhere. This asserts
   * the caller never produces such a row.
   */
  it('never writes a row addressed to neither', async () => {
    await note({ body: 'For you.', toPlayerId: playerIds[0] });
    await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox
       where registration_id is null and player_id is null
    `;
    expect(n).toBe(0);
  });

  it('addresses it to the player’s own email and name', async () => {
    await note({ body: 'Lovely.', toPlayerId: playerIds[1] });
    await sql`
      update players set email = 'violin@example.com', full_name = 'wei ling tan'
       where id = ${playerIds[1]}
    `;

    await queueNotesDigest({ concertId, playerIds: [playerIds[1]] });
    const [row] = await outbox();
    expect(row.to_email).toBe('violin@example.com');
    /** §11.3: every name in a message is cased for display, through `lib/names.ts`. */
    expect(row.to_name).toBe('Wei Ling Tan');
  });
});

describe('pressing Queue twice', () => {
  /**
   * The property the second partial unique index exists for. Same argument as
   * §11.4's for tickets: an admin unsure whether their first click registered
   * clicks again.
   */
  it('is harmless, and says so rather than silently doing nothing', async () => {
    for (const id of playerIds) await note({ body: `For ${id}.`, toPlayerId: id });

    const first = await queueNotesDigest({ concertId, playerIds });
    expect(first.queued).toBe(3);
    expect(first.alreadyPending).toBe(0);

    const second = await queueNotesDigest({ concertId, playerIds });
    expect(second.queued).toBe(0);
    expect(second.alreadyPending).toBe(3);

    expect(await outbox()).toHaveLength(3);
  });

  /**
   * Three players, not one. Module `C`'s lesson, recorded in `queue.ts`: a
   * test exercising a collection of one is not a test of the collection, and
   * the multi-row `values` shape only misbehaves past the first element.
   */
  it('queues each player separately, not one row for all of them', async () => {
    for (const id of playerIds) await note({ body: `For ${id}.`, toPlayerId: id });
    await queueNotesDigest({ concertId, playerIds });

    const rows = await outbox();
    expect(rows.map((r) => Number(r.player_id)).sort()).toEqual([...playerIds].sort());
  });

  /** Once the first digest has SENT, a later one is legitimate — the index is partial. */
  it('allows a second digest once the first has been sent', async () => {
    await note({ body: 'One.', toPlayerId: playerIds[0] });
    await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    await sql`update email_outbox set status = 'SENT', sent_at = now()`;

    await note({ body: 'Two.', toPlayerId: playerIds[0] });
    expect((await queueNotesDigest({ concertId, playerIds: [playerIds[0]] })).queued).toBe(1);
    expect(await outbox()).toHaveLength(2);
  });
});

describe('who is skipped, and why the admin is told', () => {
  it('skips a player nobody wrote to', async () => {
    const result = await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    expect(result.queued).toBe(0);
    expect(result.skipped).toEqual([
      { playerId: playerIds[0], playerName: expect.any(String), reason: 'NO_APPROVED_NOTES' },
    ]);
  });

  /**
   * Triage gates the digest. Forwarding text nobody has read to the person it
   * is about is the thing moderation exists to prevent.
   */
  it('skips a player whose only notes are unreviewed or hidden', async () => {
    await note({ body: 'Unreviewed.', toPlayerId: playerIds[0], moderation: 'PENDING' });
    await note({ body: 'Hidden.', toPlayerId: playerIds[0], moderation: 'HIDDEN' });

    const result = await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    expect(result.queued).toBe(0);
    expect(result.skipped[0].reason).toBe('NO_APPROVED_NOTES');
    expect(await outbox()).toHaveLength(0);
  });

  it('carries only the approved notes when some are not', async () => {
    await note({ body: 'Approved one.', toPlayerId: playerIds[0], moderation: 'APPROVED' });
    await note({ body: 'Still pending.', toPlayerId: playerIds[0], moderation: 'PENDING' });

    await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    const [row] = await outbox();
    expect(row.body_md).toContain('Approved one.');
    expect(row.body_md).not.toContain('Still pending.');
  });

  it('skips a player whose only notes have been deleted', async () => {
    await note({ body: 'Removed since.', toPlayerId: playerIds[0], moderation: 'APPROVED' });
    await sql`update portal_notes set deleted_at = now()`;

    const result = await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    expect(result.queued).toBe(0);
    expect(result.skipped[0].reason).toBe('NO_APPROVED_NOTES');
  });

  it('skips a player with no email address, and names them', async () => {
    await note({ body: 'For you.', toPlayerId: playerIds[0] });
    await sql`update players set email = null where id = ${playerIds[0]}`;

    const result = await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    expect(result.queued).toBe(0);
    expect(result.skipped[0].reason).toBe('NO_EMAIL');
    expect(result.skipped[0].playerName).toBeTruthy();
  });

  it('ignores a player id belonging to another concert', async () => {
    const other = await createConcert('Elsewhere');
    const [stranger] = await createPlayers(other, 1);

    const result = await queueNotesDigest({ concertId, playerIds: [stranger] });
    expect(result.queued).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(await outbox()).toHaveLength(0);
  });

  it('ignores a deactivated player', async () => {
    await note({ body: 'For you.', toPlayerId: playerIds[0] });
    await sql`update players set is_active = false where id = ${playerIds[0]}`;

    expect((await queueNotesDigest({ concertId, playerIds: [playerIds[0]] })).queued).toBe(0);
    expect(await outbox()).toHaveLength(0);
  });

  it('does nothing at all when asked for nobody', async () => {
    const result = await queueNotesDigest({ concertId, playerIds: [] });
    expect(result).toEqual({ queued: 0, alreadyPending: 0, skipped: [], unknownTokens: [] });
  });
});

describe('what the message says', () => {
  it('greets the player, not a registration', async () => {
    await note({ body: 'Wonderful.', toPlayerId: playerIds[0] });
    await sql`update players set full_name = 'Ada Lim' where id = ${playerIds[0]}`;

    await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    const [row] = await outbox();
    expect(row.body_md).toContain('Ada Lim');
    /**
     * The pre-V2 seed opened with `registration.contact_name`, which resolves
     * to nothing on a digest — it would have gone out as "Dear ,".
     */
    expect(row.body_md).not.toMatch(/Dear\s*,/);
  });

  it('carries the notes, attributed as §14.2 renders them', async () => {
    await note({
      body: 'The second movement was extraordinary.',
      toPlayerId: playerIds[0],
      displayName: 'Wei Ling',
    });

    await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    const [row] = await outbox();
    expect(row.body_md).toContain('The second movement was extraordinary.');
    expect(row.body_md).toContain('— Wei Ling');
  });

  /**
   * §13.4 hides an anonymous name "on the wall but never from admin". A digest
   * is neither: it goes to the person the note was written *to*, and a writer
   * who asked to be anonymous meant it about them, not only about strangers.
   */
  it('withholds an anonymous writer’s name from the player too', async () => {
    await note({
      body: 'Thank you.',
      toPlayerId: playerIds[0],
      displayName: 'Wei Ling',
      isAnonymous: true,
    });

    await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    const [row] = await outbox();
    expect(row.body_md).not.toContain('Wei Ling');
    expect(row.body_md).toContain('Anonymous');
  });

  it('reports no unknown tokens against the seeded template', async () => {
    await note({ body: 'Fine.', toPlayerId: playerIds[0] });
    const result = await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    expect(result.unknownTokens).toEqual([]);
  });

  it('never carries a note addressed to somebody else', async () => {
    await note({ body: 'For the first.', toPlayerId: playerIds[0] });
    await note({ body: 'For the second.', toPlayerId: playerIds[1] });
    await note({ body: 'For everyone.', toPlayerId: null });

    await queueNotesDigest({ concertId, playerIds: [playerIds[0]] });
    const [row] = await outbox();
    expect(row.body_md).toContain('For the first.');
    expect(row.body_md).not.toContain('For the second.');
    expect(row.body_md).not.toContain('For everyone.');
  });
});

describe('notesList', () => {
  /**
   * §11.3 records why the separator matters: a single `\n` is a *soft* break in
   * Markdown, so a list joined with one arrives in the HTML half as one
   * run-on paragraph. The same bug once put every ticket URL on one line.
   */
  it('separates notes with a blank line', () => {
    const rendered = notesList([
      { body: 'One.', displayName: 'A' },
      { body: 'Two.', displayName: 'B' },
    ]);
    expect(rendered).toContain('\n\n');
    expect(rendered.split('\n\n').length).toBeGreaterThan(1);
  });

  it('labels a withheld name as Anonymous', () => {
    expect(notesList([{ body: 'Hi.', displayName: null }])).toContain('— Anonymous');
  });

  /** A note with its own line breaks must stay inside the quote block. */
  it('keeps a multi-line body quoted throughout', () => {
    const rendered = notesList([{ body: 'One line.\nAnother line.', displayName: 'A' }]);
    for (const line of rendered.split('\n')) expect(line.startsWith('>')).toBe(true);
  });
});
