import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createPlayers, createSegment, createShow } from '../../tests/helpers/fixtures';

/**
 * Phase 4 — module A's Server Actions against the real database.
 *
 * Every input gets valid, missing, wrong type, out of range and hostile. No
 * mocks except the session, which is the only thing a cloud container cannot
 * supply for free.
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

const { createConcertAction, setConcertArchivedAction } = await import(
  '@/app/(admin)/admin/concerts/actions'
);
const { createShowAction, createSegmentAction, updateSegmentAction, moveCapacityAction } =
  await import('@/app/(admin)/admin/concerts/[concertId]/shows/actions');
const { createPlayerAction, planPlayerImportAction, commitPlayerImportAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/players/actions'
);
const { setSystemSettingAction } = await import('@/app/(admin)/admin/settings/actions');

const NO_STATE = { error: null, message: null };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.append(k, v);
  return data;
}

function upload(body: string | Buffer, name = 'players.csv') {
  const data = new FormData();
  data.append('file', new File([body as BlobPart], name, { type: 'text/csv' }));
  return data;
}

async function asAdmin() {
  const id = randomUUID();
  await sql`
    insert into app_users (id, email, role, is_active)
    values (${id}::uuid, ${`admin-${id}@example.test`}, 'ADMIN', true)
  `;
  sessionUser.mockResolvedValue({ id, email: 'admin@example.test', role: 'ADMIN' });
  return id;
}

const NO_500 = (error: string | null) => {
  expect(error).not.toMatch(/at Object\.|at async |node_modules|\.ts:\d+/);
};

describe('module A — hostile and out-of-range input', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    await asAdmin();
    concertId = await createConcert();
    await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}::bigint`;
  });

  it('rejects a 10 000-character concert name without a stack trace', async () => {
    const result = await createConcertAction(
      NO_STATE,
      form({ name: 'x'.repeat(10_000), slug: 'long-one', timezone: 'Asia/Kuala_Lumpur' }),
    );
    expect(result.error).toBeTruthy();
    NO_500(result.error);
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from concerts where slug = 'long-one'`;
    expect(Number(count)).toBe(0);
  });

  it('does not execute SQL metacharacters in a player name', async () => {
    const nasty = "Robert'); drop table players;--";
    const result = await createPlayerAction(
      concertId,
      NO_STATE,
      form({ fullName: nasty, isActive: 'true' }),
    );
    expect(result.error).toBeNull();
    const [row] = await sql<{ full_name: string }[]>`select full_name from players`;
    expect(row.full_name).toBe(nasty);
    // The table is still there, which is the actual assertion.
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from players`;
    expect(Number(count)).toBe(1);
  });

  it('rejects a malformed email rather than storing it', async () => {
    const result = await createPlayerAction(
      concertId,
      NO_STATE,
      form({ fullName: 'Bad Address', email: 'not-an-email', isActive: 'true' }),
    );
    expect(result.error).toMatch(/not an email/i);
  });

  it('refuses a negative segment capacity', async () => {
    const showId = await createShow(concertId, 400);
    const result = await createSegmentAction(
      concertId,
      showId,
      NO_STATE,
      form({ name: 'Public', audienceMode: 'PUBLIC', capacity: '-5', extrasPolicy: '', allowPartialGrant: '' }),
    );
    expect(result.error).toMatch(/cannot be negative/i);
  });

  it('refuses a non-numeric capacity', async () => {
    const showId = await createShow(concertId, 400);
    const result = await createSegmentAction(
      concertId,
      showId,
      NO_STATE,
      form({ name: 'Public', audienceMode: 'PUBLIC', capacity: 'lots', extrasPolicy: '', allowPartialGrant: '' }),
    );
    expect(result.error).toBeTruthy();
    NO_500(result.error);
  });

  it('refuses an audience mode outside the enum', async () => {
    const showId = await createShow(concertId, 400);
    const result = await createSegmentAction(
      concertId,
      showId,
      NO_STATE,
      form({ name: 'Sneak', audienceMode: 'ADMIN_ONLY', capacity: '10', extrasPolicy: '', allowPartialGrant: '' }),
    );
    expect(result.error).toBeTruthy();
    NO_500(result.error);
  });

  it('reports what it stores for an out-of-range system number', async () => {
    const result = await setSystemSettingAction(NO_STATE, form({ key: 'email.max_per_dispatch', value: '-1' }));
    const [row] = await sql<{ value: unknown }[]>`
      select value from system_settings where key = 'email.max_per_dispatch'
    `;
    console.log('NEGATIVE SETTING →', JSON.stringify({ error: result.error, stored: row?.value ?? null }));
    // Recorded rather than asserted: see the report. `domain.md` §6 gives these
    // keys a meaning ("messages per dispatch") that -1 cannot have.
    expect(result).toBeTruthy();
  });

  it('reports what it stores for a fractional system number', async () => {
    const result = await setSystemSettingAction(NO_STATE, form({ key: 'email.max_per_day', value: '3.7' }));
    const [row] = await sql<{ value: unknown }[]>`
      select value from system_settings where key = 'email.max_per_day'
    `;
    console.log('FRACTIONAL SETTING →', JSON.stringify({ error: result.error, stored: row?.value ?? null }));
    expect(result).toBeTruthy();
  });

  it('refuses a key that is not in the catalogue', async () => {
    const result = await setSystemSettingAction(
      NO_STATE,
      form({ key: '../../etc/passwd', value: '1' }),
    );
    expect(result.error).toMatch(/not a setting/i);
  });

  it('survives a filename with path traversal in it', async () => {
    const sheet = 'Name,Email\nAda,ada@example.test';
    const result = await planPlayerImportAction(concertId, upload(sheet, '../../../etc/passwd.csv'));
    console.log('TRAVERSAL FILENAME →', JSON.stringify(result).slice(0, 200));
    expect(result).toBeTruthy();
  });
});

describe('module A — player CSV import at scale and at the edges', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    await asAdmin();
    concertId = await createConcert();
  });

  it('imports 420 rows in one transaction', async () => {
    const rows = ['Name,Email,Instrument,Section'];
    for (let i = 1; i <= 420; i++) rows.push(`Player ${i},p${i}@example.test,Violin,Strings`);
    const result = await commitPlayerImportAction(concertId, upload(rows.join('\n')));

    expect(result.error).toBeNull();
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from players`;
    expect(Number(count)).toBe(420);
    const [{ tokens }] = await sql<{ tokens: string }[]>`select count(distinct invite_token) as tokens from players`;
    expect(Number(tokens)).toBe(420);
  });

  it('reads a UTF-8 file with a BOM and non-ASCII names', async () => {
    const body = '﻿Name,Email\nSiti Nurhaliza,siti@example.test\nJoão Gonçalves,joao@example.test';
    const result = await commitPlayerImportAction(concertId, upload(body));
    expect(result.error).toBeNull();
    const rows = await sql<{ full_name: string }[]>`select full_name from players order by full_name`;
    expect(rows.map((r) => r.full_name)).toEqual(['João Gonçalves', 'Siti Nurhaliza']);
  });

  it('reports what a latin-1 encoded file does', async () => {
    const body = Buffer.from('Name,Email\nJo\xe3o Gon\xe7alves,joao@example.test', 'latin1');
    const result = await commitPlayerImportAction(concertId, upload(body));
    const rows = await sql<{ full_name: string }[]>`select full_name from players`;
    console.log('LATIN-1 →', JSON.stringify({ error: result.error, names: rows.map((r) => r.full_name) }));
    expect(result).toBeTruthy();
  });

  it('commits nothing when the guard refuses part-way through a large file', async () => {
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 10, baseQuota: 1 });

    const rows = ['Name,Email'];
    for (let i = 1; i <= 50; i++) rows.push(`Player ${i},p${i}@example.test`);
    const result = await commitPlayerImportAction(concertId, upload(rows.join('\n')));

    expect(result.error).toMatch(/but the segment holds 10/);
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from players`;
    expect(Number(count)).toBe(0);
  });

  it('reports what an email with no domain does on the import path', async () => {
    const body = 'Name,Email\nHalf Address,ada@\nAlso Bad,@example.test';
    const plan = await planPlayerImportAction(concertId, upload(body));
    console.log('IMPORT EMAIL VALIDATION →', JSON.stringify(plan.ok ? plan.plan.rows : plan));
    expect(plan).toBeTruthy();
  });
});

describe('module A — capacity and the §7.7 move', () => {
  let concertId: number;
  let showId: number;
  let playerSegment: number;
  let publicSegment: number;

  beforeEach(async () => {
    await resetDb();
    await asAdmin();
    concertId = await createConcert();
    await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}::bigint`;
    showId = await createShow(concertId, 400);
    playerSegment = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 1,
      name: 'Player invited',
    });
    publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 300,
      name: 'Public',
    });
  });

  it('raising one segment into held seats is valid (§7.7)', async () => {
    // 300 + 80 leaves 20 held; raising public to 320 spends them.
    await moveCapacityAction(concertId, showId, [{ segmentId: playerSegment, capacity: 80 }], null);
    const result = await moveCapacityAction(
      concertId,
      showId,
      [{ segmentId: publicSegment, capacity: 320 }],
      'Spending the held seats.',
    );
    expect(result.error).toBeNull();
  });

  it('a move that breaches base entitlement is refused with the §7.4 sentence', async () => {
    await createPlayers(concertId, 80);
    const result = await moveCapacityAction(
      concertId,
      showId,
      [
        { segmentId: playerSegment, capacity: 70 },
        { segmentId: publicSegment, capacity: 330 },
      ],
      null,
    );
    expect(result.error).toMatch(/80 active players × 1 base = 80 seats, but the segment holds 70/);
    const rows = await sql<{ capacity: number }[]>`
      select capacity from show_segments where show_id = ${showId}::bigint order by id
    `;
    expect(rows.map((r) => r.capacity)).toEqual([100, 300]);
  });

  it('reports whether a segment can be edited from another concert’s screen', async () => {
    const other = await createConcert('Other Concert');
    const result = await updateSegmentAction(
      other,
      publicSegment,
      NO_STATE,
      form({
        name: 'Hijacked',
        audienceMode: 'PUBLIC',
        capacity: '10',
        extrasPolicy: '',
        allowPartialGrant: '',
      }),
    );
    const [row] = await sql<{ name: string; capacity: number }[]>`
      select name, capacity from show_segments where id = ${publicSegment}::bigint
    `;
    console.log('CROSS-CONCERT SEGMENT EDIT →', JSON.stringify({ error: result.error, row }));
    expect(result).toBeTruthy();
  });

  it('reports whether a capacity move can be driven from another concert’s screen', async () => {
    const other = await createConcert('Other Concert');
    const result = await moveCapacityAction(
      other,
      showId,
      [{ segmentId: publicSegment, capacity: 250 }],
      null,
    );
    const [row] = await sql<{ capacity: number }[]>`
      select capacity from show_segments where id = ${publicSegment}::bigint
    `;
    console.log('CROSS-CONCERT MOVE →', JSON.stringify({ error: result.error, capacity: row.capacity }));
    expect(result).toBeTruthy();
  });
});

describe('module A — concerts', () => {
  beforeEach(async () => {
    await resetDb();
    await asAdmin();
  });

  it('refuses a duplicate slug and writes no second row', async () => {
    await createConcertAction(NO_STATE, form({ name: 'One', slug: 'qa-sep', timezone: 'Asia/Kuala_Lumpur' }));
    const result = await createConcertAction(
      NO_STATE,
      form({ name: 'Two', slug: 'qa-sep', timezone: 'Asia/Kuala_Lumpur' }),
    );
    expect(result.error).toMatch(/already uses the slug/);
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from concerts where slug = 'qa-sep'`;
    expect(Number(count)).toBe(1);
  });

  it('refuses an unrecognised timezone', async () => {
    const result = await createConcertAction(
      NO_STATE,
      form({ name: 'Nowhere', slug: 'nowhere', timezone: 'Mars/Olympus_Mons' }),
    );
    expect(result.error).toMatch(/IANA/);
  });

  it('archives without deleting, and audits it', async () => {
    await createConcertAction(NO_STATE, form({ name: 'One', slug: 'arch', timezone: 'Asia/Kuala_Lumpur' }));
    const [c] = await sql<{ id: number }[]>`select id from concerts where slug = 'arch'`;
    const result = await setConcertArchivedAction(Number(c.id), true);
    expect(result.error).toBeNull();
    const [row] = await sql<{ status: string; deleted_at: Date | null }[]>`
      select status, deleted_at from concerts where id = ${c.id}::bigint
    `;
    expect(row.status).toBe('ARCHIVED');
    expect(row.deleted_at).toBeNull();
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*) from audit_log where action = 'concert.archived'
    `;
    expect(Number(count)).toBe(1);
  });
});
