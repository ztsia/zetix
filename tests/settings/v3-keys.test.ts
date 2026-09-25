import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow, json } from '../helpers/fixtures';
import { ALL_SETTINGS, settingSpec } from '@/app/(admin)/admin/settings/catalogue';

/**
 * The nine settings keys V3 adds — spec/v3.md §30.2, spec/domain.md §6.
 *
 * The same two properties as `v2-keys.test.ts`: a key the catalogue does not
 * list cannot be set from any screen, and every one of these is seeded at
 * system level with the spec's value — none is a default in code.
 */

const SEEDS = {
  'email.receipt_hold_minutes': 10,
  'review.auto_approve_clean': false,
  'review.duplicate_name_similarity': 0.8,
  'delivery.review_single_party': false,
  'admin.typed_confirm_above': 20,
  'scheduler.tick_minutes': 10,
  'scheduler.history_days': 7,
  'inbox.match_fallback_days': 30,
  'inbox.sync_budget_seconds': 20,
} as const;

const KEYS = Object.keys(SEEDS) as (keyof typeof SEEDS)[];

const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));
const runSeed = () =>
  execFileSync(process.execPath, [TSX_CLI, 'scripts/seed-settings.ts'], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });

describe('the admin catalogue lists every key V3 adds', () => {
  it.each(KEYS)('lists %s as a seeded runtime value', (key) => {
    const spec = settingSpec(key);
    expect(spec, `${key} is not in the settings catalogue`).toBeDefined();
    expect(spec?.operational).toBe(false);
  });

  it('names each key exactly once', () => {
    const keys = ALL_SETTINGS.map((s) => s.key);
    expect(keys).toHaveLength(new Set(keys).size);
  });

  it('bounds the scheduler interval to what a cron minute field can express', () => {
    const spec = settingSpec('scheduler.tick_minutes');
    expect(spec).toMatchObject({ min: 1, max: 59 });
  });

  it('lets the name similarity be a fraction', () => {
    expect(settingSpec('review.duplicate_name_similarity')).toMatchObject({
      integer: false,
      min: 0,
      max: 1,
    });
  });
});

describe('the install seed writes the spec’s values, as real types', () => {
  beforeEach(async () => {
    await resetDb();
    runSeed();
  });

  it.each(KEYS)('seeds %s', async (key) => {
    const [row] = await sql<{ value: unknown }[]>`
      select value from system_settings where key = ${key}
    `;
    expect(row?.value).toBe(SEEDS[key]);
  });
});

describe('the V3 keys resolve through the cascade', () => {
  let concertId: number;
  let segmentId: number;

  const resolve = async (key: string) => {
    const [row] = await sql<{ resolve_setting: unknown }[]>`
      select resolve_setting(${key}::text, ${segmentId}::bigint, null::bigint, null::bigint)
    `;
    return row.resolve_setting;
  };

  beforeEach(async () => {
    await resetDb();
    runSeed();
    concertId = await createConcert();
    const showId = await createShow(concertId, null);
    segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });
  });

  it('reads a segment override of auto-approve above the system seed', async () => {
    // A segment-level key needs a typed column, because the segment level of
    // the cascade has no `defaults` bag — hence `show_segments.auto_approve_clean`.
    expect(await resolve('review.auto_approve_clean')).toBe(false);
    await sql`update show_segments set auto_approve_clean = true where id = ${segmentId}`;
    expect(await resolve('review.auto_approve_clean')).toBe(true);
  });

  it('reads a concert override of the receipt hold', async () => {
    expect(await resolve('email.receipt_hold_minutes')).toBe(10);
    await sql`
      update concerts set defaults = ${json({ 'email.receipt_hold_minutes': 3 })}::text::jsonb
       where id = ${concertId}
    `;
    expect(await resolve('email.receipt_hold_minutes')).toBe(3);
  });

  it('starts the ticket design at the segment’s default, then the show’s', async () => {
    const [{ id: showTemplate }] = await sql<{ id: string }[]>`
      insert into ticket_templates (concert_id, name, version, background_kind,
                                    page_width_pt, page_height_pt, layout)
      values (${concertId}, 'Show design', 1, 'NONE', 595, 280, '{}'::jsonb) returning id
    `;
    const [{ id: segmentTemplate }] = await sql<{ id: string }[]>`
      insert into ticket_templates (concert_id, name, version, background_kind,
                                    page_width_pt, page_height_pt, layout)
      values (${concertId}, 'Segment design', 1, 'NONE', 595, 280, '{}'::jsonb) returning id
    `;
    await sql`
      update shows set ticket_template_id = ${showTemplate}
       where id = (select show_id from show_segments where id = ${segmentId})
    `;
    expect(await resolve('ticket.default_template_id')).toBe(Number(showTemplate));

    await sql`
      update show_segments set default_ticket_template_id = ${segmentTemplate}
       where id = ${segmentId}
    `;
    expect(await resolve('ticket.default_template_id')).toBe(Number(segmentTemplate));
  });
});

describe('schedule_scheduler_jobs() on a database without pg_cron', () => {
  beforeEach(resetDb);

  it('exists, and refuses with the manual step rather than failing obscurely', async () => {
    // Local Postgres 16 and CI have no pg_cron, which is why the migration only
    // creates the function (spec/v3.md §27.3).
    await expect(sql`select schedule_scheduler_jobs()`).rejects.toThrow(
      /pg_cron and pg_net must both be enabled/,
    );
  });

  it('lets the scheduler settings be saved without the extension', async () => {
    // The re-schedule trigger must be inert until the jobs exist.
    await sql`
      insert into system_settings (key, value) values ('scheduler.tick_minutes', '5'::jsonb)
      on conflict (key) do update set value = excluded.value
    `;
    const [row] = await sql<{ value: number }[]>`
      select value from system_settings where key = 'scheduler.tick_minutes'
    `;
    expect(row.value).toBe(5);
  });
});
