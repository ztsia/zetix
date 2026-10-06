import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, setSystemSetting } from '../helpers/fixtures';

/**
 * The demo seed's guard (spec/v3.md §31), exercised by **running the shipping
 * script**, as `tests/settings/seed.test.ts` does and for the same reason.
 *
 * `scripts/seed-demo.ts --reset` truncates every table. The only thing standing
 * between that and a production database is the `demo.instance` mark: a
 * database with concerts and no mark is refused, with or without `--reset`.
 * These tests hold it to that.
 *
 * **The child can never reach a real service.** The script loads `.env.local`,
 * which on a developer machine holds production's Supabase URL and service-role
 * key. dotenv never overrides a variable that is already set, so the child gets
 * an unreachable Auth URL and a stub key — and an empty `DEMO_ADMIN_PASSWORD`,
 * which stops a run the guard *accepts* at its first account, before any call
 * to Auth. That stop is also the positive control: an accepted run gets past
 * the guard to a known, later error, so a refusal test cannot pass merely
 * because the script fell over for some other reason.
 */

const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));

function runDemoSeed(args: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [TSX_CLI, '--conditions=react-server', 'scripts/seed-demo.ts', ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        DIRECT_URL: process.env.DATABASE_URL,
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub',
        SUPABASE_SERVICE_ROLE_KEY: 'stub',
        DEMO_ADMIN_PASSWORD: '',
        DEMO_VIEWER_PASSWORD: '',
        DEMO_OPERATOR_CODE: '',
      },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const FOREIGN = /holds 1 concert\(s\) the demo did not create/;
/** Where an accepted run stops: the first account, before Auth is called. */
const PAST_THE_GUARD = /DEMO_ADMIN_PASSWORD is not set/;

async function concerts(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`select name from concerts order by id`;
  return rows.map((r) => r.name);
}

async function settingsCount(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from system_settings`;
  return row.n;
}

async function mark(): Promise<unknown> {
  const [row] = await sql<{ value: unknown }[]>`
    select value from system_settings where key = 'demo.instance'
  `;
  return row?.value;
}

describe('scripts/seed-demo.ts guard', () => {
  beforeEach(resetDb);

  it('refuses a database with a concert and no mark', async () => {
    await createConcert('Real Concert');

    const run = runDemoSeed();

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(FOREIGN);
    expect(await concerts()).toEqual(['Real Concert']);
    // Refused before anything was written: not the install seed, not the mark.
    expect(await settingsCount()).toBe(0);
  });

  it('refuses --reset on a database with a concert and no mark, and wipes nothing', async () => {
    await createConcert('Real Concert');
    await setSystemSetting('email.from_name', 'Real Orchestra');

    const run = runDemoSeed(['--reset']);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(FOREIGN);
    expect(run.stdout).not.toMatch(/Wiped/);
    expect(await concerts()).toEqual(['Real Concert']);
    expect(await settingsCount()).toBe(1);
    expect(await mark()).toBeUndefined();
  });

  it('treats a mark that is not `true` as no mark', async () => {
    await createConcert('Real Concert');
    await setSystemSetting('demo.instance', false);

    const run = runDemoSeed(['--reset']);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(FOREIGN);
    expect(await concerts()).toEqual(['Real Concert']);
  });

  it('refuses to seed a marked database a second time without --reset', async () => {
    await setSystemSetting('demo.instance', true);
    await createConcert('Autumn Serenade');

    const run = runDemoSeed();

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/already holds the demo\. Run with --reset/);
    expect(await concerts()).toEqual(['Autumn Serenade']);
  });

  it('accepts an empty database and marks it (control)', async () => {
    const run = runDemoSeed();

    expect(run.stderr).toMatch(PAST_THE_GUARD);
    expect(await mark()).toBe(true);
  });

  it('wipes a marked database on --reset (control)', async () => {
    await setSystemSetting('demo.instance', true);
    await createConcert('Autumn Serenade');

    const run = runDemoSeed(['--reset']);

    expect(run.stdout).toMatch(/Wiped the demo database\./);
    expect(run.stderr).toMatch(PAST_THE_GUARD);
    expect(await concerts()).toEqual([]);
    // The wipe took the mark with it, and the run put it back.
    expect(await mark()).toBe(true);
  });
});
