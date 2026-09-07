import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * The two module A actions that call `writeAuditLog(entry, tx)` from inside
 * `db.transaction()`:
 *
 *   moveCapacityAction        (shows/actions.ts)     — allocation.md §7.7
 *   commitPlayerImportAction  (players/actions.ts)   — admin.md §14.1
 *
 * `writeAuditLog` resolves the actor with `getSessionUser()`, which runs its own
 * query through `getDb()`. The client is `postgres(..., { max: 1 })`
 * (`src/db/client.ts`), so while a transaction holds that one connection the
 * nested query can never get one. The request never returns and the connection
 * is left `idle in transaction`.
 *
 * The branch's own tests cannot see this: they `vi.mock('@/lib/auth/session')`,
 * so `getSessionUser()` never touches the pool.
 */
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
test.afterAll(async () => {
  await sql.end();
});

test.setTimeout(180_000);
test.use({ viewport: { width: 1280, height: 1000 } });

const SHOTS = 'qa-artifacts/A-config-and-people/screens';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

async function stuckSessions() {
  return sql<{ state: string; q: string; secs: number }[]>`
    select state, left(query, 60) as q,
           extract(epoch from age(now(), xact_start))::int as secs
      from pg_stat_activity
     where datname = current_database()
       and state = 'idle in transaction'
       and pid <> pg_backend_pid()`;
}

test('FLOW-9 the §7.7 capacity move never returns', async ({ page }) => {
  await sql`update show_segments set capacity = 300 where audience_mode = 'PUBLIC'`;
  await sql`update show_segments set capacity = 100 where audience_mode = 'PLAYER_INVITED'`;

  await login(page);
  await page.goto('/admin/concerts/1/shows');
  await page.getByRole('button', { name: 'Move capacity' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel(/^Player invited/).fill('80');
  await dialog.getByLabel(/^Public/).fill('320');
  await dialog.getByLabel('Reason').fill('Player segment closed with seats unclaimed.');
  await dialog.getByRole('button', { name: 'Save capacities' }).click();

  // Sixty seconds is far past any honest write of two integers.
  await page.waitForTimeout(60_000);
  // Updated after the fix. This read `dialog.getByRole(...).innerText()`, which
  // assumed the dialog was still open — true only while the move hung. Now that
  // it commits, `ActionDialog` closes on success and the locator waited out the
  // whole test timeout on a button that no longer exists. A closed dialog is
  // the success case, so it is treated as one rather than as missing text.
  const stillSaving = await dialog
    .getByRole('button', { name: /Saving/ })
    .count()
    .catch(() => 0);
  const buttonText = stillSaving > 0 ? 'Saving…' : 'closed';
  const rows = await sql<{ capacity: number }[]>`
    select capacity from show_segments where show_id = 1 order by display_order`;
  const stuck = await stuckSessions();

  console.log(
    'MOVE AFTER 60s',
    JSON.stringify({ buttonText, capacities: rows.map((r) => r.capacity), stuck }),
  );
  await page.screenshot({ path: `${SHOTS}/FLOW-9-step-3-hangs-on-saving.png`, fullPage: true });

  expect(stuck.length, 'no connection is left idle in transaction').toBe(0);
  expect(buttonText, 'the dialog must not still be saving after a minute').not.toMatch(/Saving/);
  expect(rows.map((r) => r.capacity)).toEqual([320, 80]);
});

test('FLOW-5 the player CSV import commit never returns', async ({ page }) => {
  await sql`select pg_terminate_backend(pid) from pg_stat_activity
             where datname = current_database() and state = 'idle in transaction'
               and pid <> pg_backend_pid()`;

  // Updated after the fix. FLOW-9 above moves the player segment to 80, and the
  // seed carries exactly 80 active players at a base quota of 1 — so by the time
  // this ran the segment was precisely full and the §7.4 guard correctly refused
  // an 81st, giving `created: 0` for a reason that has nothing to do with what
  // this test is about. Nothing here should depend on the previous test's
  // arithmetic, so it makes its own room first.
  await sql`update show_segments set capacity = 100
             where show_id = 1 and audience_mode = 'PLAYER_INVITED'`;

  await login(page);
  await page.goto('/admin/concerts/1/players');
  await page.getByRole('button', { name: /import/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const csv = ['Name,Email,Instrument', 'New Cellist,newcello@example.test,Cello'].join('\n');
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'players.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText(/to add/i).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-1-import-preview.png`, fullPage: true });

  const commit = dialog.getByRole('button', { name: /^Import \d+ player/ });
  await commit.click();
  await page.waitForTimeout(60_000);

  const [{ count }] = await sql<{ count: string }[]>`
    select count(*)::text as count from players where email = 'newcello@example.test'`;
  const stuck = await stuckSessions();
  console.log('IMPORT AFTER 60s', JSON.stringify({ created: Number(count), stuck }));
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-2-import-hangs.png`, fullPage: true });

  expect(stuck.length, 'no connection is left idle in transaction').toBe(0);
  expect(Number(count), 'the imported player exists').toBe(1);
});

test('the console is unusable afterwards', async ({ page }) => {
  // The pool is `max: 1`, so one abandoned transaction stalls every later
  // request — not only the screen that caused it.
  const before = await stuckSessions();
  console.log('STUCK BEFORE NAVIGATION', JSON.stringify(before));

  await login(page);
  const started = Date.now();
  await page.goto('/admin/concerts/1/players', { timeout: 120_000 }).catch(() => {});
  const elapsed = Date.now() - started;
  console.log('PLAYERS PAGE LOAD ms', elapsed);
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-3-console-stalled.png`, fullPage: true });
  expect(elapsed, 'the players screen still loads promptly').toBeLessThan(15_000);
});
