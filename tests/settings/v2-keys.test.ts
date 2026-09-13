import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, json } from '../helpers/fixtures';
import { ALL_SETTINGS, settingSpec } from '@/app/(admin)/admin/settings/catalogue';

/**
 * The six settings keys V2 adds — `modules-v2.md` §3 item 8, spec/domain.md §6.
 *
 * Two properties, and they pull in opposite directions, which is why both are
 * here:
 *
 * 1. **A key nothing lists cannot be set at all.** `setSystemSettingAction`
 *    writes only keys in the catalogue, so a V2 handler resolving a key nobody
 *    added would read null for the life of the concert and there would be no
 *    screen anywhere to fix it on.
 * 2. **A key nothing needs must not carry an operational default.** No capacity,
 *    quota, deadline or party cap is seeded (§2.1, decision 18).
 */

const NEW_KEYS = [
  'show.auto_complete_after_hours',
  'portal.booklet_enabled',
  'portal.feedback_enabled',
  'portal.feedback_close_at',
  'portal.feedback_send_hour',
  'form.verification_grace_hours',
] as const;

const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));
const runSeed = () =>
  execFileSync(process.execPath, [TSX_CLI, 'scripts/seed-settings.ts'], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });

describe('the admin catalogue lists every key V2 adds', () => {
  it.each(NEW_KEYS)('lists %s', (key) => {
    expect(settingSpec(key), `${key} is not in the settings catalogue`).toBeDefined();
  });

  it('names each key exactly once', () => {
    const keys = ALL_SETTINGS.map((s) => s.key);
    expect(keys).toHaveLength(new Set(keys).size);
  });

  it('bounds the feedback send hour to a real hour of the day', () => {
    // Not fussiness: the queueing step turns this into a `scheduled_for` in the
    // concert's timezone, and hour 27 is a message that never becomes due.
    const spec = settingSpec('portal.feedback_send_hour');
    expect(spec?.kind).toBe('number');
    expect(spec?.min).toBe(0);
    expect(spec?.max).toBe(23);
  });

});

describe('what the install seed does and does not write', () => {
  beforeEach(async () => {
    await resetDb();
    runSeed();
  });

  it('seeds the three runtime keys, as real numbers', async () => {
    // `modules-v2.md` §3: these are "seeded at system level like every other
    // runtime value". They describe the runtime, not the event — how long after
    // a printed end time an evening counts as over, what hour is civil to email
    // at, and how long an unverified address waits before an admin looks at it.
    const rows = await sql<{ key: string; type: string }[]>`
      select key, jsonb_typeof(value) as type from system_settings
       where key in ('show.auto_complete_after_hours', 'portal.feedback_send_hour',
                     'form.verification_grace_hours')
       order by key
    `;
    expect(rows.map((r) => r.key)).toEqual([
      'form.verification_grace_hours',
      'portal.feedback_send_hour',
      'show.auto_complete_after_hours',
    ]);
    expect(rows.every((r) => r.type === 'number')).toBe(true);
  });

  it('seeds nothing the catalogue calls operational', async () => {
    // §2.1 and decision 18, as a property rather than as a list of five keys
    // somebody has to remember to extend. Whatever the seed writes describes the
    // runtime; whatever describes *this event* is typed in by an admin, and a
    // missing one is a validation error at save time.
    //
    // One documented exemption: `allocation.extras_policy` is seeded because
    // decision 4 states its per-audience defaults outright and they have to live
    // somewhere as data. `scripts/seed-settings.ts` argues that at length; it is
    // not numeric, and it is the only row here.
    const seeded = await sql<{ key: string }[]>`select key from system_settings order by key`;
    const operationalSeeds = seeded
      .map((r) => r.key)
      .filter((key) => key !== 'allocation.extras_policy')
      .filter((key) => settingSpec(key)?.operational !== false);

    expect(
      operationalSeeds,
      'these keys are seeded but the catalogue calls them operational — either the seed is a ' +
        'code default for an event value, or the catalogue row is wrong',
    ).toEqual([]);
  });

  it('seeds none of the per-show switches', async () => {
    // Whether a show runs feedback, shows a booklet, or closes feedback at a
    // particular moment is a decision about *this* event. A missing one is a
    // validation error at save time, not a silent fallback.
    const rows = await sql<{ key: string }[]>`
      select key from system_settings
       where key in ('portal.booklet_enabled', 'portal.feedback_enabled',
                     'portal.feedback_close_at')
    `;
    expect(rows).toEqual([]);
  });
});

describe('the new keys resolve through the cascade like any other', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;

  const resolve = async (key: string) => {
    const [row] = await sql<{ resolve_setting: unknown }[]>`
      select resolve_setting(${key}::text, ${segmentId}::bigint, null::bigint, null::bigint)
    `;
    return row.resolve_setting;
  };

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, null);
    segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });
  });

  it('reads a show override of the completion delay above the system root', async () => {
    // None of these needed a typed column: `shows.defaults` and
    // `concerts.defaults` already carry any key at all, which is exactly why
    // `resolve_setting()` did not have to change for V2.
    await sql`
      insert into system_settings (key, value)
      values ('show.auto_complete_after_hours', ${json(2)}::text::jsonb)
    `;
    expect(await resolve('show.auto_complete_after_hours')).toBe(2);

    await sql`
      update shows set defaults = ${json({ 'show.auto_complete_after_hours': 5 })}::text::jsonb
       where id = ${showId}::bigint
    `;
    expect(await resolve('show.auto_complete_after_hours')).toBe(5);
  });

  it('reads a concert override of the feedback send hour', async () => {
    await sql`
      update concerts set defaults = ${json({ 'portal.feedback_send_hour': 9 })}::text::jsonb
       where id = ${concertId}::bigint
    `;
    expect(await resolve('portal.feedback_send_hour')).toBe(9);
  });

  it('returns null for a per-show switch nobody has set', async () => {
    // Which is a real answer, not a failure: the section is simply not enabled
    // yet, and the screen must say so rather than guessing "on".
    expect(await resolve('portal.feedback_enabled')).toBeNull();
    expect(await resolve('portal.booklet_enabled')).toBeNull();
    expect(await resolve('portal.feedback_close_at')).toBeNull();
  });
});
