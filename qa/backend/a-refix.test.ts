import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import { createConcert, createSegment, createShow } from '../../tests/helpers/fixtures';

/**
 * Re-verification pass. Each block is a finding from the first QA run, asserted
 * as it should now behave rather than merely printed.
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

const { updateSegmentAction, deleteSegmentAction, moveCapacityAction, createSegmentAction } =
  await import('@/app/(admin)/admin/concerts/[concertId]/shows/actions');
const { planPlayerImportAction, commitPlayerImportAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/players/actions'
);
const { setSystemSettingAction } = await import('@/app/(admin)/admin/settings/actions');
const { resolveSetting } = await import('@/db/settings');

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
}

describe('finding 5 — numeric settings are bounded', () => {
  beforeEach(async () => {
    await resetDb();
    await asAdmin();
  });

  it('refuses a negative messages-per-dispatch and stores nothing', async () => {
    const result = await setSystemSettingAction(
      NO_STATE,
      form({ key: 'email.max_per_dispatch', value: '-1' }),
    );
    expect(result.error).toBeTruthy();
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from system_settings where key = 'email.max_per_dispatch'`;
    expect(Number(count)).toBe(0);
  });

  it('refuses a fractional messages-per-day', async () => {
    const result = await setSystemSettingAction(
      NO_STATE,
      form({ key: 'email.max_per_day', value: '3.7' }),
    );
    expect(result.error).toMatch(/whole number/i);
  });

  it('refuses a negative base quota, which would void every player’s promise', async () => {
    const result = await setSystemSettingAction(
      NO_STATE,
      form({ key: 'allocation.base_quota', value: '-3' }),
    );
    expect(result.error).toBeTruthy();
    await expect(resolveSetting('allocation.base_quota')).resolves.toBeNull();
  });

  it('refuses a negative segment capacity at the root', async () => {
    const result = await setSystemSettingAction(
      NO_STATE,
      form({ key: 'segment.capacity', value: '-5' }),
    );
    expect(result.error).toBeTruthy();
  });

  it('still accepts a legitimate value', async () => {
    const result = await setSystemSettingAction(
      NO_STATE,
      form({ key: 'email.max_per_dispatch', value: '30' }),
    );
    expect(result.error).toBeNull();
    await expect(resolveSetting('email.max_per_dispatch')).resolves.toBe(30);
  });

  it('accepts a fraction where the catalogue says fractions are meaningful', async () => {
    // `import.fuzzy_match_threshold` is 0.85 in §6, so `integer: false` there.
    const result = await setSystemSettingAction(
      NO_STATE,
      form({ key: 'import.fuzzy_match_threshold', value: '0.85' }),
    );
    expect(result.error).toBeNull();
    await expect(resolveSetting('import.fuzzy_match_threshold')).resolves.toBe(0.85);
  });
});

describe('finding 7 — segment mutations are scoped to their concert', () => {
  let concertId: number;
  let other: number;
  let showId: number;
  let publicSegment: number;

  beforeEach(async () => {
    await resetDb();
    await asAdmin();
    concertId = await createConcert();
    other = await createConcert('Other Concert');
    showId = await createShow(concertId, 400);
    publicSegment = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
  });

  it('refuses an update driven from another concert’s screen', async () => {
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
    expect(result.error).toMatch(/not part of this concert/i);
    const [row] = await sql<{ name: string; capacity: number }[]>`
      select name, capacity from show_segments where id = ${publicSegment}::bigint`;
    expect(row.name).not.toBe('Hijacked');
    expect(row.capacity).toBe(300);
  });

  it('refuses a capacity move driven from another concert’s screen', async () => {
    const result = await moveCapacityAction(
      other,
      showId,
      [{ segmentId: publicSegment, capacity: 250 }],
      null,
    );
    expect(result.error).toMatch(/not part of this concert/i);
    const [row] = await sql<{ capacity: number }[]>`
      select capacity from show_segments where id = ${publicSegment}::bigint`;
    expect(row.capacity).toBe(300);
  });

  it('refuses a create driven from another concert’s screen', async () => {
    const result = await createSegmentAction(
      other,
      showId,
      NO_STATE,
      form({
        name: 'Sneak',
        audienceMode: 'PLAYER_INVITED',
        capacity: '10',
        extrasPolicy: '',
        allowPartialGrant: '',
      }),
    );
    expect(result.error).toMatch(/not part of this concert/i);
  });

  it('refuses a delete driven from another concert’s screen', async () => {
    const result = await deleteSegmentAction(other, publicSegment);
    expect(result.error).toMatch(/not part of this concert/i);
    const [row] = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from show_segments where id = ${publicSegment}::bigint`;
    expect(row.deleted_at).toBeNull();
  });

  it('still allows the concert that actually owns it', async () => {
    const result = await moveCapacityAction(
      concertId,
      showId,
      [{ segmentId: publicSegment, capacity: 250 }],
      null,
    );
    expect(result.error).toBeNull();
  });
});

describe('finding 8 — import validation', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    await asAdmin();
    concertId = await createConcert();
  });

  it('skips an address with no domain', async () => {
    const plan = await planPlayerImportAction(
      concertId,
      upload('Name,Email\nHalf Address,ada@\nAlso Bad,@example.test\nGood One,ok@example.test'),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.counts).toMatchObject({ create: 1, skip: 2 });
    expect(plan.plan.rows[0].reason).toMatch(/not an email address/i);
  });

  it('accepts ordinary addresses, including a subdomain and a plus tag', async () => {
    const plan = await planPlayerImportAction(
      concertId,
      upload(
        [
          'Name,Email',
          'Plus Tag,ada+orch@example.test',
          'Subdomain,bo@mail.example.co.uk',
          'Dashy,cy@my-orch.example',
        ].join('\n'),
      ),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.counts).toMatchObject({ create: 3, skip: 0 });
  });

  it('refuses a latin-1 file rather than committing mojibake', async () => {
    const body = Buffer.from('Name,Email\nJo\xe3o Gon\xe7alves,joao@example.test', 'latin1');
    const result = await planPlayerImportAction(concertId, upload(body));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/UTF-8/i);

    const commit = await commitPlayerImportAction(concertId, upload(body));
    expect(commit.error).toMatch(/UTF-8/i);
    const [{ count }] = await sql<{ count: string }[]>`select count(*)::text as count from players`;
    expect(Number(count)).toBe(0);
  });

  it('still reads UTF-8 with a BOM and accented names', async () => {
    const result = await commitPlayerImportAction(
      concertId,
      upload('﻿Name,Email\nJoão Gonçalves,joao@example.test\nSiti Nurhaliza,siti@example.test'),
    );
    expect(result.error).toBeNull();
    const rows = await sql<{ full_name: string }[]>`
      select full_name from players order by full_name`;
    expect(rows.map((r) => r.full_name)).toEqual(['João Gonçalves', 'Siti Nurhaliza']);
  });
});

describe('finding 9 — the settings catalogue covers §6', () => {
  beforeEach(async () => {
    await resetDb();
    await asAdmin();
  });

  it('can write every key domain.md §6 names', async () => {
    const { settingSpec } = await import('@/app/(admin)/admin/settings/catalogue');
    const missing = [
      'concert.timezone',
      'ticket.default_template_id',
      'portal.unlock_mode',
      'portal.notes_enabled',
      'portal.notes_close_at',
      'portal.public_wall_enabled',
      'portal.public_wall_visibility',
    ].filter((key) => !settingSpec(key));
    expect(missing).toEqual([]);
  });
});
