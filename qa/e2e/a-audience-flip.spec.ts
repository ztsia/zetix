import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * The audience select is `disabled={editing}` (`segment-form-dialog.tsx`).
 *
 * A disabled control is not submitted, so `formData.get('audienceMode')` is
 * `null` on every edit and `readSegmentForm` falls back to `?? 'PUBLIC'`.
 * Editing a PLAYER_INVITED segment therefore posts `audienceMode: 'PUBLIC'`.
 *
 * Two outcomes depending on whether a base quota is set, both wrong:
 *   quota set   → refused with the public-segment message; the segment cannot
 *                 be edited at all.
 *   quota blank → the check passes and `PUBLIC` is written over the segment's
 *                 real audience.
 *
 * The second matters most: `assert_base_entitlement_fits()` opens with
 * `if v_segment.audience_mode <> 'PLAYER_INVITED' then return; end if`, so a
 * flipped segment silently stops being covered by the §7.4 guard.
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

async function resetSegments() {
  await sql`
    update show_segments
       set capacity = case audience_mode when 'PLAYER_INVITED' then 100 else 300 end,
           audience_mode = (case name when 'Player invited' then 'PLAYER_INVITED' else 'PUBLIC' end)::audience_mode,
           base_quota = case name when 'Player invited' then 1 else null end
     where show_id = 1 and deleted_at is null`;
}

test('a player segment with a quota cannot be edited at all', async ({ page }) => {
  await resetSegments();
  await login(page);
  await page.goto('/admin/concerts/1/shows');

  await page.getByRole('button', { name: 'Edit Player invited' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Change nothing but the capacity — the most ordinary edit there is.
  await dialog.getByLabel('Capacity').fill('120');
  await dialog.getByRole('button', { name: 'Save segment' }).click();

  const alert = dialog.getByRole('alert').last();
  await expect(alert).toBeVisible({ timeout: 15_000 });
  const text = await alert.innerText();
  console.log('EDIT WITH QUOTA →', JSON.stringify(text));
  await page.screenshot({ path: `${SHOTS}/BUG-audience-edit-refused.png`, fullPage: true });

  const [row] = await sql<{ capacity: number }[]>`
    select capacity from show_segments where show_id = 1 and name = 'Player invited'`;
  console.log('CAPACITY AFTER →', row.capacity);

  expect(text, 'an ordinary capacity edit must not be refused').not.toMatch(/base quota only means/i);
  expect(row.capacity, 'the edit should have been saved').toBe(120);
});

/**
 * A player-only show, which `allocation.md` §7.1 explicitly allows: "A show has
 * one or more segments; a single-audience show simply has one."
 *
 * On the 19 Sep show the flip below is blocked by `unique (show_id,
 * audience_mode)` colliding with the existing public segment — by luck, not by
 * design. With one segment there is nothing to collide with.
 */
async function playerOnlyShow(quota: number | null) {
  await sql`delete from show_segments where show_id = 2`;
  const [seg] = await sql<{ id: number }[]>`
    insert into show_segments (show_id, name, audience_mode, capacity, base_quota, display_order)
    values (2, 'Players only', 'PLAYER_INVITED', 150, ${quota}, 1)
    returning id`;
  return Number(seg.id);
}

test('a player segment with no quota is silently converted to PUBLIC', async ({ page }) => {
  const segmentId = await playerOnlyShow(null);

  await login(page);
  await page.goto('/admin/concerts/1/shows');
  await page.getByRole('button', { name: 'Edit Players only' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/BUG-audience-before-save.png`, fullPage: true });

  await dialog.getByLabel('Capacity').fill('120');
  await dialog.getByRole('button', { name: 'Save segment' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  const [row] = await sql<{ audience_mode: string; capacity: number }[]>`
    select audience_mode, capacity from show_segments where id = ${segmentId}`;
  console.log('AFTER EDIT →', JSON.stringify(row));
  await page.screenshot({ path: `${SHOTS}/BUG-audience-flipped.png`, fullPage: true });

  expect(row.audience_mode, 'a segment’s audience is fixed once it exists').toBe('PLAYER_INVITED');
});

test('once flipped, the §7.4 entitlement guard no longer covers the segment', async () => {
  const segmentId = await playerOnlyShow(1);
  const [{ count: players }] = await sql<{ count: string }[]>`
    select count(*)::text as count from players where is_active and deleted_at is null`;

  // 80 active players at quota 1 do not fit in 50 seats, so this is refused.
  let refusedWhilePlayerInvited = false;
  let sentence = '';
  try {
    await sql`update show_segments set capacity = 50 where id = ${segmentId}`;
  } catch (error) {
    refusedWhilePlayerInvited = true;
    sentence = (error as Error).message;
  }

  // Exactly what the edit form writes: audience PUBLIC, quota cleared.
  await sql`update show_segments set base_quota = null, audience_mode = 'PUBLIC'::audience_mode
             where id = ${segmentId}`;
  let refusedAfterFlip = false;
  try {
    await sql`update show_segments set capacity = 50 where id = ${segmentId}`;
  } catch {
    refusedAfterFlip = true;
  }

  console.log(
    'GUARD COVERAGE →',
    JSON.stringify({ players: Number(players), refusedWhilePlayerInvited, sentence, refusedAfterFlip }),
  );
  await sql`delete from show_segments where show_id = 2`;

  expect(refusedWhilePlayerInvited, 'the guard covers a player segment').toBe(true);
  expect(refusedAfterFlip, 'and must still cover it after an ordinary UI edit').toBe(true);
});
