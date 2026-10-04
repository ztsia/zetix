import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { settingSpec } from '@/app/(admin)/admin/settings/catalogue';

/**
 * The two keys module `Y` adds (spec/v3.md §32.5): listed in the catalogue so
 * an admin can set them, and seeded at system level — walk-ins off, at most ten
 * people a tap — rather than defaulted in code.
 */
const SEEDS = {
  'checkin.walk_ins_enabled': false,
  'checkin.walk_in_max_headcount': 10,
} as const;

const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));

describe('the walk-in settings', () => {
  it.each(Object.keys(SEEDS))('lists %s as a seeded runtime value, settable per concert', (key) => {
    expect(settingSpec(key)).toMatchObject({ operational: false, level: 'system', concert: true });
  });

  describe('the install seed', () => {
    beforeEach(async () => {
      await resetDb();
      execFileSync(process.execPath, [TSX_CLI, 'scripts/seed-settings.ts'], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      });
    });

    it.each(Object.entries(SEEDS))('seeds %s as %s', async (key, value) => {
      const [row] = await sql<{ value: unknown }[]>`select value from system_settings where key = ${key}`;
      expect(row?.value).toBe(value);
    });
  });
});
