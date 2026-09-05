import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';

/**
 * The install seed, exercised by **running the shipping script**, not by
 * imitating it.
 *
 * This test exists because of a bug that 84 green tests could not have caught:
 * `scripts/seed-settings.ts` wrote every value double-encoded — a jsonb *string*
 * rather than a number, boolean or object — while the test fixture wrote the
 * same keys correctly through a slightly different path. Nothing errored.
 * `keepalive.enabled` became the string "true", which is still truthy;
 * `allocation.extras_policy` became a string that never matched the
 * per-audience branch in `resolve_setting`, so a player segment relying on
 * decision 4's default silently auto-granted extras that §7.4 requires be held
 * as PENDING_REVIEW until the §7.5 batch review.
 *
 * The lesson is the shape of the test, not the assertion: a fixture that
 * imitates the production write path proves nothing about the production write
 * path. So this spawns the real script.
 */

// Spawn tsx's own CLI on the current Node rather than `pnpm tsx`. `pnpm` on
// Windows is `pnpm.cmd`, which execFileSync cannot execute without a shell, so
// the whole file failed there with ENOENT while passing on Linux CI. Resolving
// the binary keeps the point of the test — it still runs the shipping script,
// as a real process — on every platform.
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));

function runSeed(args: string[] = []): string {
  return execFileSync(
    process.execPath,
    [TSX_CLI, 'scripts/seed-settings.ts', ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    },
  );
}

describe('scripts/seed-settings.ts', () => {
  it('writes values Postgres can read as their real types', async () => {
    await resetDb();
    runSeed();

    const rows = await sql<{ key: string; type: string }[]>`
      select key, jsonb_typeof(value) as type from system_settings order by key
    `;
    expect(rows.length).toBeGreaterThan(0);

    // Not one of them may be a jsonb string unless it is genuinely a string
    // value. A double-encoded number, boolean or object all arrive as 'string'.
    const wronglyStringified = rows.filter(
      (r) => r.type === 'string' && r.key !== 'email.transport',
    );
    expect(wronglyStringified).toEqual([]);
  });

  it('gives the engine a usable extras policy, keyed by audience mode', async () => {
    await resetDb();
    runSeed();

    const [row] = await sql<{ type: string }[]>`
      select jsonb_typeof(value) as type from system_settings
       where key = 'allocation.extras_policy'
    `;
    expect(row.type).toBe('object');

    // And it resolves through the cascade to a policy the engine acts on
    // (decision 4: player segments REVIEW, public segments AUTO_FCFS).
    const [concert] = await sql<{ id: number }[]>`
      insert into concerts (name, slug, status) values ('Seeded', 'seeded', 'ACTIVE') returning id
    `;
    const [show] = await sql<{ id: number }[]>`
      insert into shows (concert_id, name, status, capacity)
      values (${concert.id}, 'Show', 'OPEN', 100) returning id
    `;
    const [player] = await sql<{ id: number }[]>`
      insert into show_segments (show_id, name, audience_mode, capacity)
      values (${show.id}, 'Player invited', 'PLAYER_INVITED', 50) returning id
    `;
    const [pub] = await sql<{ id: number }[]>`
      insert into show_segments (show_id, name, audience_mode, capacity)
      values (${show.id}, 'Public', 'PUBLIC', 50) returning id
    `;

    const resolve = async (segmentId: number) => {
      const [r] = await sql<{ resolve_setting: string }[]>`
        select resolve_setting('allocation.extras_policy'::text, ${segmentId}::bigint)
      `;
      return r.resolve_setting;
    };

    expect(await resolve(Number(player.id))).toBe('REVIEW');
    expect(await resolve(Number(pub.id))).toBe('AUTO_FCFS');
  });

  it('seeds no capacity, quota or deadline — those are entered per concert', async () => {
    await resetDb();
    runSeed();

    // §2.1 and decision 18: operational values have no install-time seed, and a
    // missing one is a validation error at save time rather than a fallback.
    const rows = await sql<{ key: string }[]>`
      select key from system_settings
       where key in ('capacity', 'segment.capacity', 'allocation.base_quota',
                     'allocation.base_claim_deadline', 'form.max_tickets_per_response')
    `;
    expect(rows).toEqual([]);
  });

  it('leaves an admin-changed value alone, and --force resets it', async () => {
    await resetDb();
    runSeed();
    await sql`
      update system_settings set value = '99'::jsonb where key = 'email.max_per_dispatch'
    `;

    runSeed();
    const [kept] = await sql<{ value: number }[]>`
      select value from system_settings where key = 'email.max_per_dispatch'
    `;
    expect(kept.value).toBe(99);

    runSeed(['--force']);
    const [reset] = await sql<{ value: number }[]>`
      select value from system_settings where key = 'email.max_per_dispatch'
    `;
    expect(reset.value).toBe(25);
  });
});
