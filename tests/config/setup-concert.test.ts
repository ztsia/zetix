import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createSegment, createShow } from '../helpers/fixtures';

/**
 * Setup › Concert (spec/v3.md §29.1): editing the concert, and the concert
 * level of the cascade (`concerts.defaults`, spec/README.md §2.2).
 *
 * What can go silently wrong here: a bag value stored one jsonb level too deep
 * (a string where a number belongs), a portal key written to the bag and then
 * shadowed by its typed column, and a concert quota that oversubscribes a
 * segment because nothing checked it. Each has a test.
 */

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
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

const { updateConcertAction, setConcertSettingAction, clearConcertSettingAction } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/setup/actions'
);
const { resolveSetting } = await import('@/db/settings');

const NO_STATE = { error: null, message: null };

async function asAdmin() {
  const id = randomUUID();
  await sql`insert into app_users (id, email, role, is_active)
            values (${id}::uuid, ${`admin-${id}@example.test`}, 'ADMIN', true)`;
  sessionUser.mockResolvedValue({ id, email: 'admin@example.test', role: 'ADMIN' });
}

function concertForm(concertId: number, over: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields = {
    concertId: String(concertId),
    name: 'Renamed',
    slug: 'renamed',
    season: '2027',
    timezone: 'Asia/Singapore',
    startsOn: '2027-01-10',
    endsOn: '2027-01-11',
    status: 'ACTIVE',
    ...over,
  };
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

let concertId: number;

beforeEach(async () => {
  await resetDb();
  await asAdmin();
  concertId = await createConcert('Setup Concert');
});

describe('editing the concert', () => {
  it('saves every field and audits only what changed', async () => {
    const result = await updateConcertAction(NO_STATE, concertForm(concertId));
    expect(result.error).toBeNull();
    const [row] = await sql`select name, slug, season, timezone, starts_on::text, ends_on::text, status::text
                              from concerts where id = ${concertId}`;
    expect(row).toEqual({
      name: 'Renamed',
      slug: 'renamed',
      season: '2027',
      timezone: 'Asia/Singapore',
      starts_on: '2027-01-10',
      ends_on: '2027-01-11',
      status: 'ACTIVE',
    });
    const [audit] = await sql<{ before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select before, after from audit_log where action = 'concert.updated'`;
    // The timezone did not change (the fixture is already Asia/Singapore), so
    // it is not in the entry.
    expect(Object.keys(audit!.after).sort()).toEqual(['ends_on', 'name', 'season', 'slug', 'starts_on']);
  });

  it('says so when the timezone changes, because every show time now reads differently', async () => {
    const result = await updateConcertAction(NO_STATE, concertForm(concertId, { timezone: 'Europe/London' }));
    expect(result.message).toMatch(/timezone changed/);
  });

  it('refuses a zone that is not an IANA zone, an end before the start, and a taken slug', async () => {
    expect((await updateConcertAction(NO_STATE, concertForm(concertId, { timezone: 'Mars/Olympus' }))).error).toMatch(
      /IANA/,
    );
    expect(
      (await updateConcertAction(NO_STATE, concertForm(concertId, { startsOn: '2027-02-01', endsOn: '2027-01-01' })))
        .error,
    ).toMatch(/cannot end before/);
    await createConcert('Taken');
    expect((await updateConcertAction(NO_STATE, concertForm(concertId, { slug: 'taken' }))).error).toMatch(
      /already uses the slug/,
    );
  });

  it('cannot archive from here, and will not edit an archived concert', async () => {
    expect((await updateConcertAction(NO_STATE, concertForm(concertId, { status: 'ARCHIVED' }))).error).not.toBeNull();
    await sql`update concerts set status = 'ARCHIVED' where id = ${concertId}`;
    expect((await updateConcertAction(NO_STATE, concertForm(concertId))).error).toMatch(/archived/);
  });

  it('refuses a viewer', async () => {
    sessionUser.mockResolvedValue({ id: randomUUID(), email: 'v@x', role: 'VIEWER' });
    await expect(updateConcertAction(NO_STATE, concertForm(concertId))).rejects.toThrow();
  });
});

describe('the concert level of the cascade', () => {
  it('stores a number as a jsonb number, and the cascade reads it for the concert only', async () => {
    const other = await createConcert('Other');
    await sql`insert into system_settings (key, value) values ('email.receipt_hold_minutes', '10'::jsonb)`;

    expect((await setConcertSettingAction(concertId, 'email.receipt_hold_minutes', '25')).error).toBeNull();
    const [row] = await sql`select jsonb_typeof(defaults -> 'email.receipt_hold_minutes') as t from concerts where id = ${concertId}`;
    expect(row!.t).toBe('number');
    expect(await resolveSetting('email.receipt_hold_minutes', { concertId })).toBe(25);
    expect(await resolveSetting('email.receipt_hold_minutes', { concertId: other })).toBe(10);
  });

  it('keeps other keys in the bag when one is set or cleared', async () => {
    await setConcertSettingAction(concertId, 'email.receipt_hold_minutes', '25');
    await setConcertSettingAction(concertId, 'admin.typed_confirm_above', '40');
    await clearConcertSettingAction(concertId, 'email.receipt_hold_minutes');
    const [row] = await sql<{ defaults: Record<string, unknown> }[]>`select defaults from concerts where id = ${concertId}`;
    expect(row!.defaults).toEqual({ 'admin.typed_confirm_above': 40 });
  });

  it('writes a portal key to its typed column, which the cascade reads before the bag', async () => {
    await sql`update concerts set defaults = '{"portal.enabled": false}'::jsonb where id = ${concertId}`;
    expect((await setConcertSettingAction(concertId, 'portal.enabled', 'true')).error).toBeNull();
    const [row] = await sql`select portal_enabled from concerts where id = ${concertId}`;
    expect(row!.portal_enabled).toBe(true);
    expect(await resolveSetting('portal.enabled', { concertId })).toBe(true);

    expect((await clearConcertSettingAction(concertId, 'portal.enabled')).error).toBeNull();
    const [cleared] = await sql`select portal_enabled from concerts where id = ${concertId}`;
    expect(cleared!.portal_enabled).toBeNull();
  });

  it('checks a typed column’s own shape: an enum and a timestamp', async () => {
    expect((await setConcertSettingAction(concertId, 'portal.public_wall_visibility', 'everyone')).error).toMatch(
      /ADMIN_ONLY or AUDIENCE/,
    );
    expect((await setConcertSettingAction(concertId, 'portal.public_wall_visibility', 'audience')).error).toBeNull();
    expect((await setConcertSettingAction(concertId, 'portal.notes_close_at', 'next tuesday')).error).toMatch(
      /not a timestamp/,
    );
  });

  it('refuses a key a concert cannot override, and one that does not exist', async () => {
    // The dispatcher reads its limits with no concert in hand, so a concert
    // value would be a control that silently does nothing.
    expect((await setConcertSettingAction(concertId, 'email.max_per_day', '5')).error).toMatch(/not a setting a concert can override/);
    expect((await setConcertSettingAction(concertId, 'no.such.key', '5')).error).toMatch(/not a setting a concert can override/);
    const [row] = await sql`select defaults from concerts where id = ${concertId}`;
    expect(row!.defaults).toBeNull();
  });

  it('validates the value as the system level does', async () => {
    expect((await setConcertSettingAction(concertId, 'allocation.base_quota', '-1')).error).toMatch(/negative/);
    expect((await setConcertSettingAction(concertId, 'allocation.base_quota', '1.5')).error).toMatch(/whole number/);
  });

  it('refuses a concert quota that would oversubscribe a segment, naming it', async () => {
    const showId = await createShow(concertId, 100);
    await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 10 });
    await createPlayers(concertId, 4);

    expect((await setConcertSettingAction(concertId, 'allocation.base_quota', '2')).error).toBeNull();
    const refused = await setConcertSettingAction(concertId, 'allocation.base_quota', '3');
    expect(refused.error).toMatch(/PLAYER_INVITED|quota|segment/i);
    expect(await resolveSetting('allocation.base_quota', { concertId })).toBe(2);
  });

  it('refuses a viewer', async () => {
    sessionUser.mockResolvedValue({ id: randomUUID(), email: 'v@x', role: 'VIEWER' });
    await expect(setConcertSettingAction(concertId, 'email.receipt_hold_minutes', '5')).rejects.toThrow();
    await expect(clearConcertSettingAction(concertId, 'email.receipt_hold_minutes')).rejects.toThrow();
  });
});
