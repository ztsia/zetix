import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow } from '../helpers/fixtures';

/**
 * Players — CRUD, invite tokens and CSV import (spec/domain.md §5.1,
 * spec/allocation.md §7.4).
 *
 * The thread running through most of this is that **adding or reactivating a
 * player is entitlement-guard route 2**: every active player is entitled to the
 * base quota of every player-invited segment in the concert, so the 81st player
 * can be the one that oversubscribes a segment nobody was looking at.
 */

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const sessionUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => sessionUser(),
  recordLogin: async () => {},
}));

const {
  commitPlayerImportAction,
  createPlayerAction,
  deletePlayerAction,
  planPlayerImportAction,
  rotateInviteTokenAction,
  setPlayerActiveAction,
  updatePlayerAction,
} = await import('@/app/(admin)/admin/concerts/[concertId]/players/actions');

const NO_STATE = { error: null, message: null };

async function asAdmin() {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, role, is_active)
    values (${id}::uuid, ${`admin-${id}@example.test`}, 'ADMIN', true)
  `;
  sessionUser.mockResolvedValue({ id, email: 'admin@example.test', role: 'ADMIN' });
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/** A CSV upload, as the browser would post it. */
function csvUpload(body: string, name = 'players.csv', extra: Record<string, string> = {}) {
  const data = new FormData();
  data.append('file', new File([body], name, { type: 'text/csv' }));
  for (const [key, value] of Object.entries(extra)) data.append(key, value);
  return data;
}

describe('player actions', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    await asAdmin();
    concertId = await createConcert();
  });

  describe('authorization', () => {
    it.each([
      ['createPlayerAction', () => createPlayerAction(concertId, NO_STATE, form({}))],
      ['updatePlayerAction', () => updatePlayerAction(concertId, 1, NO_STATE, form({}))],
      ['setPlayerActiveAction', () => setPlayerActiveAction(concertId, 1, false)],
      ['rotateInviteTokenAction', () => rotateInviteTokenAction(concertId, 1)],
      ['deletePlayerAction', () => deletePlayerAction(concertId, 1)],
      ['planPlayerImportAction', () => planPlayerImportAction(concertId, csvUpload('a'))],
      ['commitPlayerImportAction', () => commitPlayerImportAction(concertId, csvUpload('a'))],
    ])('%s refuses a signed-out caller', async (_label, run) => {
      sessionUser.mockResolvedValue(null);
      await expect(run()).rejects.toBeInstanceOf(RedirectSignal);
    });
  });

  describe('creating a player', () => {
    it('mints an unguessable invite token', async () => {
      await createPlayerAction(
        concertId,
        NO_STATE,
        form({ fullName: 'Ada Cello', email: 'ada@example.test', isActive: 'true' }),
      );

      const [row] = await sql<{ invite_token: string }[]>`
        select invite_token from players where concert_id = ${concertId}::bigint
      `;
      // 128 bits, base62 — the same entropy as a qr_token, because the token is
      // the whole credential (spec/domain.md §5.1).
      expect(row.invite_token).toMatch(/^[0-9A-Za-z]{22}$/);
    });

    it('gives every player a different token', async () => {
      for (const name of ['One', 'Two', 'Three']) {
        await createPlayerAction(
          concertId,
          NO_STATE,
          form({ fullName: name, isActive: 'true' }),
        );
      }
      const rows = await sql<{ invite_token: string }[]>`
        select invite_token from players where concert_id = ${concertId}::bigint
      `;
      expect(new Set(rows.map((r) => r.invite_token)).size).toBe(3);
    });

    it('allows a player with no email — the token is the credential', async () => {
      const result = await createPlayerAction(
        concertId,
        NO_STATE,
        form({ fullName: 'No Address', email: '', isActive: 'true' }),
      );
      expect(result.error).toBeNull();

      const [row] = await sql<{ email: string | null }[]>`
        select email from players where concert_id = ${concertId}::bigint
      `;
      expect(row.email).toBeNull();
    });

    it('explains a duplicate address instead of leaking the index name', async () => {
      await createPlayerAction(
        concertId,
        NO_STATE,
        form({ fullName: 'First', email: 'dup@example.test', isActive: 'true' }),
      );
      const result = await createPlayerAction(
        concertId,
        NO_STATE,
        // `email` is citext, so the clash is case-insensitive.
        form({ fullName: 'Second', email: 'DUP@example.test', isActive: 'true' }),
      );

      expect(result.error).toMatch(/already uses/i);
      expect(result.error).not.toMatch(/players_concert_email_key/);
    });
  });

  describe('the entitlement guard, reached through players (§7.4 route 2)', () => {
    beforeEach(async () => {
      const showId = await createShow(concertId, 400);
      await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 3,
        baseQuota: 1,
      });
      await createPlayers(concertId, 3);
    });

    it('blocks the player who would not fit, naming the numbers', async () => {
      const result = await createPlayerAction(
        concertId,
        NO_STATE,
        form({ fullName: 'One Too Many', isActive: 'true' }),
      );

      expect(result.error).toMatch(/4 active players × 1 base = 4 seats/);
      expect(result.error).toMatch(/the segment holds 3/);

      const [{ count }] = await sql<{ count: string }[]>`
        select count(*) from players where concert_id = ${concertId}::bigint
      `;
      expect(Number(count)).toBe(3);
    });

    it('allows an inactive one, which is entitled to nothing', async () => {
      const result = await createPlayerAction(
        concertId,
        NO_STATE,
        form({ fullName: 'Reserve', isActive: 'false' }),
      );
      expect(result.error).toBeNull();
    });

    it('blocks reactivating that reserve, the same guard from the other side', async () => {
      await createPlayerAction(
        concertId,
        NO_STATE,
        form({ fullName: 'Reserve', isActive: 'false' }),
      );
      const [row] = await sql<{ id: number }[]>`
        select id from players where full_name = 'Reserve'
      `;

      const result = await setPlayerActiveAction(concertId, Number(row.id), true);

      expect(result.error).toMatch(/but the segment holds 3/);
      const [after] = await sql<{ is_active: boolean }[]>`
        select is_active from players where id = ${row.id}::bigint
      `;
      expect(after.is_active).toBe(false);
    });

    it('deactivating is the lever §7.4 offers, and it works', async () => {
      const [row] = await sql<{ id: number }[]>`
        select id from players where concert_id = ${concertId}::bigint order by id limit 1
      `;

      const result = await setPlayerActiveAction(concertId, Number(row.id), false);

      expect(result.error).toBeNull();
      // With one deactivated, the segment now has room again.
      await expect(
        createPlayerAction(concertId, NO_STATE, form({ fullName: 'Now Fits', isActive: 'true' })),
      ).resolves.toMatchObject({ error: null });
    });
  });

  describe('rotating an invite token', () => {
    it('replaces the token, so the old link stops working', async () => {
      await createPlayerAction(concertId, NO_STATE, form({ fullName: 'Ada', isActive: 'true' }));
      const [before] = await sql<{ id: number; invite_token: string }[]>`
        select id, invite_token from players where concert_id = ${concertId}::bigint
      `;

      const result = await rotateInviteTokenAction(concertId, Number(before.id));

      expect(result.error).toBeNull();
      const [after] = await sql<{ invite_token: string }[]>`
        select invite_token from players where id = ${before.id}::bigint
      `;
      expect(after.invite_token).not.toBe(before.invite_token);
      expect(after.invite_token).toMatch(/^[0-9A-Za-z]{22}$/);
    });

    it('keeps the token out of the audit log', async () => {
      await createPlayerAction(concertId, NO_STATE, form({ fullName: 'Ada', isActive: 'true' }));
      const [player] = await sql<{ id: number; invite_token: string }[]>`
        select id, invite_token from players where concert_id = ${concertId}::bigint
      `;
      await rotateInviteTokenAction(concertId, Number(player.id));

      const [after] = await sql<{ invite_token: string }[]>`
        select invite_token from players where id = ${player.id}::bigint
      `;
      // The log is readable by anyone who can read the console. Writing a live
      // credential into it makes the audit trail a second copy of the secret.
      const rows = await sql<{ body: string }[]>`
        select coalesce(before::text, '') || coalesce(after::text, '') as body
          from audit_log where action = 'player.invite_rotated'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].body).not.toContain(after.invite_token);
      expect(rows[0].body).not.toContain(player.invite_token);
    });
  });

  describe('CSV import', () => {
    const SHEET = [
      'Name,Email,Instrument,Section',
      'Ada Cello,ada@example.test,Cello,Strings',
      'Bo Viola,bo@example.test,Viola,Strings',
      'Cy Horn,cy@example.test,Horn,Brass',
    ].join('\n');

    it('previews without writing anything', async () => {
      const result = await planPlayerImportAction(concertId, csvUpload(SHEET));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.counts).toEqual({ create: 3, update: 0, skip: 0 });
      expect(result.plan.mapping.fullName).toBe('Name');
      expect(result.plan.mapping.section).toBe('Section');

      const [{ count }] = await sql<{ count: string }[]>`select count(*) from players`;
      expect(Number(count)).toBe(0);
    });

    it('commits the rows it previewed', async () => {
      await commitPlayerImportAction(concertId, csvUpload(SHEET));

      const rows = await sql<{ full_name: string; section: string; invite_token: string }[]>`
        select full_name, section, invite_token from players
         where concert_id = ${concertId}::bigint order by full_name
      `;
      expect(rows.map((r) => r.full_name)).toEqual(['Ada Cello', 'Bo Viola', 'Cy Horn']);
      expect(rows.map((r) => r.section)).toEqual(['Strings', 'Strings', 'Brass']);
      // Every imported player gets their own token, same as one added by hand.
      expect(new Set(rows.map((r) => r.invite_token)).size).toBe(3);
    });

    it('updates a player whose address is already on file rather than duplicating', async () => {
      await commitPlayerImportAction(concertId, csvUpload(SHEET));
      const changed = [
        'Name,Email,Instrument,Section',
        'Ada Cello,ada@example.test,Double bass,Strings',
      ].join('\n');

      const plan = await planPlayerImportAction(concertId, csvUpload(changed));
      expect(plan.ok && plan.plan.counts).toMatchObject({ create: 0, update: 1 });

      await commitPlayerImportAction(concertId, csvUpload(changed));

      const rows = await sql<{ instrument: string }[]>`
        select instrument from players where email = 'ada@example.test'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].instrument).toBe('Double bass');
    });

    it('skips a row with no name, and says why', async () => {
      const sheet = ['Name,Email', ',nobody@example.test', 'Real Person,real@example.test'].join(
        '\n',
      );

      const result = await planPlayerImportAction(concertId, csvUpload(sheet));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.counts).toMatchObject({ create: 1, skip: 1 });
      expect(result.plan.rows.find((r) => r.action === 'skip')?.reason).toMatch(/No name/i);
    });

    it('skips the second of two rows sharing an address', async () => {
      // Otherwise the unique index fails halfway through the commit, and a
      // transaction that rolls back tells the admin nothing about which row.
      const sheet = [
        'Name,Email',
        'First Entry,same@example.test',
        'Second Entry,same@example.test',
      ].join('\n');

      const result = await planPlayerImportAction(concertId, csvUpload(sheet));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.counts).toMatchObject({ create: 1, skip: 1 });
      expect(result.plan.rows[1].reason).toMatch(/appears earlier/i);
    });

    it('honours a mapping the admin corrected', async () => {
      const sheet = ['Player,Contact,Plays', 'Ada Cello,ada@example.test,Cello'].join('\n');

      const result = await planPlayerImportAction(
        concertId,
        csvUpload(sheet, 'players.csv', { 'map-email': 'Contact', 'map-instrument': 'Plays' }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.rows[0].email).toBe('ada@example.test');
      expect(result.plan.rows[0].instrument).toBe('Cello');
    });

    it('skips a name longer than the manual form would accept', async () => {
      // The form caps at 200; the importer had no cap, so a malformed sheet
      // could load a name no screen renders and no ticket prints.
      const sheet = ['Name,Email', `${'a'.repeat(10_000)},huge@example.test`].join('\n');

      const result = await planPlayerImportAction(concertId, csvUpload(sheet));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.counts).toMatchObject({ create: 0, skip: 1 });
      expect(result.plan.rows[0].reason).toMatch(/limit is 200/);
    });

    it('refuses a file with no name column rather than importing blanks', async () => {
      const sheet = ['Instrument,Section', 'Cello,Strings'].join('\n');

      const result = await planPlayerImportAction(concertId, csvUpload(sheet));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/name/i);
    });

    it('refuses an empty upload', async () => {
      const result = await planPlayerImportAction(concertId, new FormData());
      expect(result.ok).toBe(false);
    });

    it('writes nothing at all when the guard refuses the import', async () => {
      const showId = await createShow(concertId, 400);
      await createSegment(showId, {
        audienceMode: 'PLAYER_INVITED',
        capacity: 2,
        baseQuota: 1,
      });

      // Three players into a segment that promises two. The guard is deferred to
      // COMMIT and judges the concert's players as a set, so the whole import
      // fails — leaving forty of eighty loaded, with nothing to say which forty,
      // would be far worse.
      const result = await commitPlayerImportAction(concertId, csvUpload(SHEET));

      expect(result.error).toMatch(/but the segment holds 2/);
      const [{ count }] = await sql<{ count: string }[]>`select count(*) from players`;
      expect(Number(count)).toBe(0);
    });
  });
});
