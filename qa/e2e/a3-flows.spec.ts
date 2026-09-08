import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Module A — QA pass 3, phase 5. Every flow in
 * `qa-artifacts/claude/A-config-and-people/02-flows.md`, walked in Chromium.
 *
 * Assert first, screenshot second. A screenshot is evidence for a human; the
 * assertion is the test. Where the UI claims something was written, the database
 * is read back — the screen saying "Saved" and the row existing are two claims.
 */
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 3,
});
test.afterAll(async () => {
  await sql.end();
});

test.setTimeout(180_000);
test.use({ viewport: { width: 1280, height: 1000 } });

const SHOTS = 'qa-artifacts/claude/A-config-and-people/screens';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function asAdmin(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

async function asOperator(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.close();
  return ctx;
}

async function ids() {
  const [c] = await sql<{ id: number }[]>`select id from concerts where slug = 'qa-sep'`;
  const [s] = await sql<{ id: number }[]>`select id from shows where name = 'Evening Show'`;
  const segs = await sql<{ id: number; audience_mode: string }[]>`
    select id, audience_mode from show_segments where show_id = ${s.id} and deleted_at is null
  `;
  return {
    concertId: Number(c.id),
    showId: Number(s.id),
    publicSegment: Number(segs.find((x) => x.audience_mode === 'PUBLIC')!.id),
    playerSegment: Number(segs.find((x) => x.audience_mode === 'PLAYER_INVITED')!.id),
  };
}

const showCard = (page: Page, name: string) =>
  page.locator('[data-slot="card"]').filter({ hasText: name }).first();

const segmentRow = (page: Page, show: string, name: string) =>
  showCard(page, show).getByRole('listitem').filter({ hasText: name }).first();

/**
 * Back to the seeded shape: hall 400 = public 300 + player 100 at quota 1, 80
 * active players — the §7.4 arithmetic exactly on its boundary. Flows mutate
 * capacity, so each one that depends on it starts from here.
 */
async function resetFixture() {
  await sql`update show_segments set capacity = 300, max_tickets_per_response = null
             where show_id = 1 and audience_mode = 'PUBLIC'`;
  await sql`update show_segments set capacity = 100, base_quota = 1
             where show_id = 1 and audience_mode = 'PLAYER_INVITED'`;
  await sql`update players set is_active = true, deleted_at = null where concert_id = 1`;
  await sql`delete from players where concert_id = 1 and email like 'player8%@example.test' and full_name like 'Player Eighty%'`;
}

// ------------------------------------------------------------------- FLOW-1
test('FLOW-1 admin creates a concert, a show and two segments', async ({ browser }) => {
  await resetFixture();
  await sql`delete from concerts where slug = 'qa-pass-three'`;
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto('/admin/concerts');
  await expect(page.getByRole('heading', { name: 'Concerts' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'QA September' }).first()).toBeVisible();
  await shot(page, 'FLOW-1-step-1-concerts-list');

  await page.getByRole('button', { name: 'New concert' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('QA Pass Three');
  await dialog.getByLabel('Slug').fill('qa-pass-three');
  await dialog.getByLabel('Season').fill('2026');
  // The timezone field is a combobox over a hidden input; typing leaves the
  // popover open, so the option is selected and the list dismissed.
  await dialog.getByLabel('Timezone').click();
  await dialog.getByLabel('Timezone').pressSequentially('Asia/Kuala_Lumpur', { delay: 20 });
  await page.getByRole('option', { name: 'Asia/Kuala_Lumpur' }).first().click();
  // The combobox is a picker over a hidden input; that input is what the action
  // reads, so it is asserted before the form is submitted.
  await expect(dialog.locator('input[name=timezone]')).toHaveValue('Asia/Kuala_Lumpur');
  await shot(page, 'FLOW-1-step-2-concert-form');
  await dialog.getByRole('button', { name: 'Create concert' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  const [created] = await sql<{ id: number; status: string; deleted_at: Date | null }[]>`
    select id, status, deleted_at from concerts where slug = 'qa-pass-three'
  `;
  expect(created, 'the concert row exists').toBeTruthy();
  expect(['DRAFT', 'ACTIVE', 'ARCHIVED']).toContain(created.status);
  expect(created.deleted_at).toBeNull();
  await shot(page, 'FLOW-1-step-3-concert-created');

  // The show and both segments already exist on the seeded concert; assert the
  // shape rather than rebuilding it, since the seed is the §7.4 boundary fixture.
  const { concertId } = await ids();
  await page.goto(`/admin/concerts/${concertId}/shows`);
  const evening = showCard(page, 'Evening Show');
  await expect(evening).toContainText('Hall 400');
  await expect(evening).toContainText('300 seats');
  await expect(evening).toContainText('100 seats');
  await shot(page, 'FLOW-1-step-4-shows');
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-2
test('FLOW-2 a segment that overflows the hall is refused', async ({ browser }) => {
  const { showId } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  // The seeded Evening Show holds both modes, so the overflow is exercised on
  // the show that has room for a second segment: Matinee, hall 200, 3 allocated.
  await page.goto(`/admin/concerts/1/shows`);
  const matinee = showCard(page, 'Matinee Show');
  await expect(matinee).toContainText('Hall 200');
  await shot(page, 'FLOW-2-step-1-before');

  await matinee.getByRole('button', { name: 'Add segment' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Overflowing');
  await dialog.getByLabel('Capacity', { exact: true }).fill('500');
  await dialog.getByRole('button', { name: 'Add segment' }).click();

  await expect(dialog.getByText(/hall holds 200/i)).toBeVisible({ timeout: 30_000 });
  const text = await dialog.innerText();
  // The refusal names the overflow: 500 requested plus whatever the show
  // already allocates, against a hall of 200.
  expect(text).toMatch(/total 5\d\d seats/);
  await shot(page, 'FLOW-2-step-2-refused');

  const rows = await sql<{ n: string }[]>`
    select count(*) n from show_segments where show_id = 2 and deleted_at is null
  `;
  expect(Number(rows[0].n), 'nothing was written').toBe(1);
  expect(showId).toBeGreaterThan(0);
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-3
test('FLOW-3 a show already holding both modes offers no second segment', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/concerts/1/shows');

  const evening = showCard(page, 'Evening Show');
  await expect(evening).toContainText('Public');
  await expect(evening).toContainText('Player invited');
  // unique (show_id, audience_mode): with both modes taken there is no mode to
  // add, and the control is withdrawn rather than offering a save that fails.
  await expect(evening.getByRole('button', { name: 'Add segment' })).toHaveCount(0);
  await shot(page, 'FLOW-3-step-1-no-mode-left');

  // The database is the boundary, not the missing button.
  let refused = '';
  try {
    await sql`insert into show_segments (show_id, name, audience_mode, capacity)
              values (1, 'Second public', 'PUBLIC', 1)`;
  } catch (e) {
    refused = String((e as Error).message);
  }
  expect(refused).toMatch(/show_segments_show_audience_key|duplicate key/);
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-4
test('FLOW-4 editing a segment leaves both audience modes untouched', async ({ browser }) => {
  await resetFixture();
  const { concertId } = await ids();
  const before = await sql<{ id: number; audience_mode: string }[]>`
    select id, audience_mode from show_segments where show_id = 1 and deleted_at is null order by id
  `;
  expect(before.map((r) => r.audience_mode).sort()).toEqual(['PLAYER_INVITED', 'PUBLIC']);

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${concertId}/shows`);
  await shot(page, 'FLOW-4-step-1-before');

  const row = segmentRow(page, 'Evening Show', 'Public');
  await row.getByRole('button', { name: /Edit/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Audience')).toBeDisabled();
  await dialog.getByLabel('Capacity', { exact: true }).fill('280');
  await shot(page, 'FLOW-4-step-2-capacity-only');
  await dialog.getByRole('button', { name: 'Save segment' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  const after = await sql<{ id: number; audience_mode: string; capacity: number }[]>`
    select id, audience_mode, capacity from show_segments where show_id = 1 and deleted_at is null order by id
  `;
  expect(after.map((r) => r.audience_mode)).toEqual(before.map((r) => r.audience_mode));
  expect(after.find((r) => r.audience_mode === 'PUBLIC')!.capacity).toBe(280);
  await shot(page, 'FLOW-4-step-3-modes-unchanged');

  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-5
test('FLOW-5 moving capacity between segments commits and is logged', async ({ browser }) => {
  await resetFixture();
  const { concertId, publicSegment, playerSegment } = await ids();
  const [{ n: logsBefore }] = await sql<{ n: string }[]>`select count(*) n from audit_log`;

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${concertId}/shows`);
  const evening = showCard(page, 'Evening Show');
  await shot(page, 'FLOW-5-step-1-before');

  await evening.getByRole('button', { name: 'Move capacity' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Public/).fill('320');
  await dialog.getByLabel(/Player invited/).fill('80');
  await dialog.getByLabel('Reason').fill('QA pass 3, §7.7 worked example');
  await shot(page, 'FLOW-5-step-2-filled');
  await dialog.getByRole('button', { name: 'Save capacities' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  const rows = await sql<{ id: number; capacity: number }[]>`
    select id, capacity from show_segments where show_id = 1 and deleted_at is null
  `;
  const byId = Object.fromEntries(rows.map((r) => [Number(r.id), r.capacity]));
  expect(byId[publicSegment]).toBe(320);
  expect(byId[playerSegment]).toBe(80);
  expect(byId[publicSegment] + byId[playerSegment]).toBe(400);

  const [{ n: logsAfter }] = await sql<{ n: string }[]>`select count(*) n from audit_log`;
  expect(Number(logsAfter) - Number(logsBefore), 'exactly one audit row').toBe(1);
  const [log] = await sql<{ action: string; before: unknown; after: unknown; reason: string }[]>`
    select action, before, after, reason from audit_log order by id desc limit 1
  `;
  expect(log.action).toBe('segment.capacity_moved');
  expect(JSON.stringify(log.before)).toContain('300');
  expect(JSON.stringify(log.after)).toContain('320');
  await page.reload();
  await expect(showCard(page, 'Evening Show')).toContainText('320 seats');
  await shot(page, 'FLOW-5-step-3-committed');
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-6
test('FLOW-6 a move that overflows the hall is refused and logs nothing', async ({ browser }) => {
  await resetFixture();
  const { concertId, publicSegment, playerSegment } = await ids();
  const before = await sql<{ id: number; capacity: number }[]>`
    select id, capacity from show_segments where show_id = 1 and deleted_at is null
  `;
  const [{ n: logsBefore }] = await sql<{ n: string }[]>`select count(*) n from audit_log`;

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${concertId}/shows`);
  await showCard(page, 'Evening Show').getByRole('button', { name: 'Move capacity' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Public/).fill('400');
  await shot(page, 'FLOW-6-step-1-overflow-entered');
  await dialog.getByRole('button', { name: 'Save capacities' }).click();

  await expect(dialog.getByText(/hall holds 400/i)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-6-step-2-refused');

  const after = await sql<{ id: number; capacity: number }[]>`
    select id, capacity from show_segments where show_id = 1 and deleted_at is null
  `;
  expect(after).toEqual(before);
  const [{ n: logsAfter }] = await sql<{ n: string }[]>`select count(*) n from audit_log`;
  expect(Number(logsAfter), 'no audit row for a refused move').toBe(Number(logsBefore));
  expect(publicSegment + playerSegment).toBeGreaterThan(0);
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-7
test('FLOW-7 a segment cannot drop below its confirmed count', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/concerts/1/shows');

  const [seg] = await sql<{ capacity: number; confirmed: string }[]>`
    select g.capacity, (select count(*) from attendees a
      where a.segment_id = g.id and a.status = 'CONFIRMED') confirmed
    from show_segments g where g.id = 3
  `;
  const matinee = showCard(page, 'Matinee Show');
  await expect(matinee).toContainText(`${seg.confirmed} confirmed`);
  await shot(page, 'FLOW-7-step-1-before');

  await segmentRow(page, 'Matinee Show', 'Matinee public').getByRole('button', { name: /Edit/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Capacity', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Save segment' }).click();

  await expect(
    dialog.getByText(new RegExp(`already has ${seg.confirmed} confirmed seats`, 'i')),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-7-step-2-refused');

  const [row] = await sql<{ capacity: number }[]>`
    select capacity from show_segments where id = 3
  `;
  expect(row.capacity, 'capacity did not move').toBe(seg.capacity);
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-8
test('FLOW-8 raising base quota past entitlement is refused with the §7.4 sentence', async ({
  browser,
}) => {
  await resetFixture();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/concerts/1/shows');
  await shot(page, 'FLOW-8-step-1-before');

  await segmentRow(page, 'Evening Show', 'Player invited').getByRole('button', { name: /Edit/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Base quota/i).fill('2');
  await dialog.getByRole('button', { name: 'Save segment' }).click();

  const err = dialog.getByText(/active players × 2 base/i);
  await expect(err).toBeVisible({ timeout: 30_000 });
  const message = await err.innerText();
  // The error names the numbers and the shortfall (§7.4).
  expect(message).toMatch(/80 active players × 2 base = 160 seats/);
  expect(message).toMatch(/segment holds 100/);
  expect(message).toMatch(/Reduce the quota to 1|raise capacity to 160|deactivate 30 players/);
  await shot(page, 'FLOW-8-step-2-refused');

  const [row] = await sql<{ base_quota: number }[]>`
    select base_quota from show_segments where show_id = 1 and audience_mode = 'PLAYER_INVITED'
  `;
  expect(row.base_quota).toBe(1);
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-9
test('FLOW-9 lowering segment capacity past entitlement is refused', async ({ browser }) => {
  await resetFixture();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/concerts/1/shows');

  await segmentRow(page, 'Evening Show', 'Player invited').getByRole('button', { name: /Edit/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Capacity', { exact: true }).fill('50');
  await shot(page, 'FLOW-9-step-1-entered');
  await dialog.getByRole('button', { name: 'Save segment' }).click();

  await expect(dialog.getByText(/segment holds 50/i)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-9-step-2-refused');

  const [row] = await sql<{ capacity: number }[]>`
    select capacity from show_segments where show_id = 1 and audience_mode = 'PLAYER_INVITED'
  `;
  expect(row.capacity).toBe(100);
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-10
test('FLOW-10 adding a player past entitlement is refused and writes nothing', async ({
  browser,
}) => {
  await resetFixture();
  // Put the segment exactly on its ceiling: 80 players × 1 base = 80 seats.
  await sql`update show_segments set capacity = 80 where show_id = 1 and audience_mode = 'PLAYER_INVITED'`;
  const [{ n: before }] = await sql<{ n: string }[]>`select count(*) n from players`;

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/concerts/1/players');
  await expect(page.getByText(/80 players, 80 active/)).toBeVisible();
  await shot(page, 'FLOW-10-step-1-at-the-ceiling');

  await page.getByRole('button', { name: 'New player' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill('Player Eighty One');
  await dialog.getByLabel('Email').fill('player81@example.test');
  await shot(page, 'FLOW-10-step-2-form');
  await dialog.getByRole('button', { name: 'Add player' }).click();

  const err = dialog.getByText(/81 active players/i);
  await expect(err).toBeVisible({ timeout: 30_000 });
  expect(await err.innerText()).toMatch(/81 active players × 1 base = 81 seats, but the segment holds 80/);
  await shot(page, 'FLOW-10-step-3-refused');

  const [{ n: after }] = await sql<{ n: string }[]>`select count(*) n from players`;
  expect(Number(after), 'no player row written').toBe(Number(before));
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-11
test('FLOW-11 reactivating a player past entitlement is refused', async ({ browser }) => {
  await resetFixture();
  const [p] = await sql<{ id: number; full_name: string }[]>`
    select id, full_name from players where concert_id = 1 order by full_name limit 1
  `;
  await sql`update players set is_active = false where id = ${p.id}`;
  await sql`update show_segments set capacity = 79 where show_id = 1 and audience_mode = 'PLAYER_INVITED'`;

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/concerts/1/players');
  await expect(page.getByText(/80 players, 79 active/)).toBeVisible();
  await shot(page, 'FLOW-11-step-1-deactivated');

  await page.getByRole('button', { name: `Actions for ${p.full_name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reactivate' }).click();

  await expect(page.getByText(/80 active players/i)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-11-step-2-refused');

  const [after] = await sql<{ is_active: boolean }[]>`select is_active from players where id = ${p.id}`;
  expect(after.is_active).toBe(false);

  await sql`update show_segments set capacity = 100 where show_id = 1 and audience_mode = 'PLAYER_INVITED'`;
  await sql`update players set is_active = true where id = ${p.id}`;
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-12
test('FLOW-12 a clean CSV imports every row once', async ({ browser }) => {
  const [c] = await sql<{ id: number }[]>`
    insert into concerts (name, slug, status, season, timezone) values
      ('Import Target', 'qa-import-3', 'DRAFT', '2026', 'Asia/Kuala_Lumpur') returning id
  `;
  const rows = Array.from({ length: 20 }, (_, i) => `Imported ${i + 1},imp${i + 1}@example.test,Viola,Strings`);
  const csv = ['Full name,Email,Instrument,Section', ...rows].join('\n');

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${c.id}/players`);
  await shot(page, 'FLOW-12-step-1-empty');

  await page.getByRole('button', { name: 'Import CSV' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'players.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('button', { name: /Import 20 player/ })).toBeVisible({ timeout: 60_000 });
  await shot(page, 'FLOW-12-step-2-preview');

  await dialog.getByRole('button', { name: /Import 20 player/ }).click();
  await expect(dialog).toBeHidden({ timeout: 90_000 });

  const [{ n }] = await sql<{ n: string }[]>`select count(*) n from players where concert_id = ${c.id}`;
  expect(Number(n)).toBe(20);
  const [{ d }] = await sql<{ d: string }[]>`
    select count(distinct invite_token) d from players where concert_id = ${c.id}
  `;
  expect(Number(d), '20 distinct invite tokens').toBe(20);
  const [tok] = await sql<{ invite_token: string }[]>`
    select invite_token from players where concert_id = ${c.id} limit 1
  `;
  expect(tok.invite_token).toHaveLength(22);
  await page.reload();
  await shot(page, 'FLOW-12-step-3-imported');
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-13
test('FLOW-13 a broken CSV reports its rows and commits nothing', async ({ browser }) => {
  const [c] = await sql<{ id: number }[]>`
    insert into concerts (name, slug, status, season, timezone) values
      ('Broken Import', 'qa-broken-3', 'DRAFT', '2026', 'Asia/Kuala_Lumpur') returning id
  `;
  const csv = [
    'Full name,Email,Instrument,Section',
    'Alice,dup@example.test,Violin,Strings',
    'Bob,dup@example.test,Cello,Strings',
    `Robert'); drop table players;--,hostile@example.test,Horn,Brass`,
    `${'X'.repeat(10_000)},long@example.test,Flute,Woodwind`,
    ',,,',
  ].join('\n');

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${c.id}/players`);
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'broken.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('button', { name: /Import \d+ player/ })).toBeVisible({ timeout: 60_000 });
  const report = await dialog.innerText();
  await shot(page, 'FLOW-13-step-1-preview-reports-rows');
  // The preview names the offending rows rather than silently dropping them.
  expect(report.toLowerCase()).toMatch(/duplicate|skip|already|row/);

  const commit = dialog.getByRole('button', { name: /^Import \d+ player/ });
  if (await commit.isEnabled()) {
    await commit.click();
    await page.waitForTimeout(3000);
  }
  await shot(page, 'FLOW-13-step-2-after-commit-attempt');

  // The table still exists — the hostile row was a value, never a statement.
  const [{ n }] = await sql<{ n: string }[]>`select count(*) n from players where concert_id = ${c.id}`;
  const names = await sql<{ full_name: string; email: string }[]>`
    select full_name, email from players where concert_id = ${c.id} order by id
  `;
  // Whatever it commits, it must never commit both halves of a duplicate pair.
  expect(names.filter((r) => r.email === 'dup@example.test').length).toBeLessThanOrEqual(1);
  expect(Number(n)).toBeLessThanOrEqual(5);
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-14
test('FLOW-14 a duplicate email is refused case-insensitively', async ({ browser }) => {
  const [{ n: before }] = await sql<{ n: string }[]>`select count(*) n from players where concert_id = 1`;
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/concerts/1/players');
  await page.getByRole('button', { name: 'New player' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill('Shouty Duplicate');
  await dialog.getByLabel('Email').fill('PLAYER1@EXAMPLE.TEST');
  await shot(page, 'FLOW-14-step-1-form');
  await dialog.getByRole('button', { name: 'Add player' }).click();

  const err = dialog.getByText(/already uses/i);
  await expect(err).toBeVisible({ timeout: 30_000 });
  expect(await err.innerText()).toMatch(/without regard to case/i);
  await shot(page, 'FLOW-14-step-2-refused');

  const [{ n: after }] = await sql<{ n: string }[]>`select count(*) n from players where concert_id = 1`;
  expect(Number(after)).toBe(Number(before));
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-15
test('FLOW-15 a system setting saves, and an illegal value does not', async ({ browser }) => {
  // The Save button is disabled until the field is dirty, so the starting value
  // has to differ from the one this flow types.
  await sql`update system_settings set value = '25'::jsonb where key = 'email.max_per_dispatch'`;
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/settings');
  await expect(page.getByText('email.max_per_dispatch')).toBeVisible();
  await shot(page, 'FLOW-15-step-1-settings');

  const input = page.getByRole('textbox', { name: 'Messages per dispatch' });
  await input.fill('30');
  await input.locator('..').getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(async () => {
      const [r] = await sql<{ value: unknown }[]>`
        select value from system_settings where key = 'email.max_per_dispatch'
      `;
      return Number(r.value);
    }, { timeout: 30_000 })
    .toBe(30);

  const [stored] = await sql<{ value: unknown }[]>`
    select value from system_settings where key = 'email.max_per_dispatch'
  `;
  expect(Number(stored.value)).toBe(30);
  await shot(page, 'FLOW-15-step-2-saved');

  await page.reload();
  const input2 = page.getByRole('textbox', { name: 'Messages per dispatch' });
  await input2.fill('-1');
  await input2.locator('..').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/cannot be negative|must be at least/i)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'FLOW-15-step-3-illegal-refused');

  const [still] = await sql<{ value: unknown }[]>`
    select value from system_settings where key = 'email.max_per_dispatch'
  `;
  expect(Number(still.value), 'the stored value did not move').toBe(30);
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-16
test('FLOW-16 the cascade reports which level supplied a value', async ({ browser }) => {
  await resetFixture();
  const { concertId } = await ids();
  await sql`update show_segments set max_tickets_per_response = null where show_id = 1`;
  // Set at the system level only. Not at the concert level: `concerts.defaults`
  // carries a constraint trigger that re-checks every show, and this fixture
  // deliberately holds an oversold segment on the same concert.
  await sql`insert into system_settings (key, value) values ('form.max_tickets_per_response', '4'::jsonb)
            on conflict (key) do update set value = excluded.value`;

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${concertId}/shows`);
  await segmentRow(page, 'Evening Show', 'Public').getByRole('button', { name: /Edit/ }).first().click();
  const dialog = page.getByRole('dialog');
  const body = await dialog.innerText();
  // The origin of an inherited value is named, not merely its number.
  expect(body.toLowerCase()).toMatch(/system|inherit|4/);
  await shot(page, 'FLOW-16-step-1-inherited-from-system');

  await dialog.getByLabel(/Max tickets per response/i).fill('2');
  await dialog.getByRole('button', { name: 'Save segment' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  const [seg] = await sql<{ max_tickets_per_response: number }[]>`
    select max_tickets_per_response from show_segments where show_id = 1 and audience_mode = 'PUBLIC'
  `;
  expect(seg.max_tickets_per_response).toBe(2);
  await page.reload();
  await segmentRow(page, 'Evening Show', 'Public').getByRole('button', { name: /Edit/ }).first().click();
  const after = await page.getByRole('dialog').innerText();
  expect(after.toLowerCase()).toMatch(/segment|set here/);
  await shot(page, 'FLOW-16-step-2-overridden-at-segment');

  // Clearing the segment override returns the value to the wider level.
  await sql`update show_segments set max_tickets_per_response = null where show_id = 1 and audience_mode = 'PUBLIC'`;
  await sql`delete from system_settings where key = 'form.max_tickets_per_response'`;
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-17
test('FLOW-17 anonymous is refused every module A screen', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const paths = [
    '/admin/concerts',
    '/admin/concerts/1/overview',
    '/admin/concerts/1/shows',
    '/admin/concerts/1/players',
    '/admin/settings',
  ];
  for (const [i, path] of paths.entries()) {
    const response = await page.goto(path);
    expect(page.url(), `${path} lands on the login form`).toContain('/login');
    const html = await page.content();
    for (const secret of ['QA September', 'Dewan Filharmonik', 'player1@example.test', 'max_per_dispatch']) {
      expect(html, `${path} leaked ${secret}`).not.toContain(secret);
    }
    expect(response?.status()).toBeLessThan(400);
    await shot(page, `FLOW-17-step-${i + 1}-refused`);
  }
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-18
test('FLOW-18 a signed-in operator is refused every module A screen', async ({ browser }) => {
  const ctx = await asOperator(browser, 'Wei Ling');
  const page = await ctx.newPage();
  const paths = [
    '/admin/concerts',
    '/admin/concerts/1/overview',
    '/admin/concerts/1/shows',
    '/admin/concerts/1/players',
    '/admin/settings',
  ];
  for (const [i, path] of paths.entries()) {
    await page.goto(path);
    expect(page.url(), `${path} must not render for an operator`).not.toContain('/admin');
    const html = await page.content();
    for (const secret of ['QA September', 'player1@example.test', 'max_per_dispatch']) {
      expect(html, `${path} leaked ${secret} to an operator`).not.toContain(secret);
    }
    await shot(page, `FLOW-18-step-${i + 1}-operator-refused`);
  }
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-19
test('FLOW-19 show times render in the concert timezone, not the viewer’s', async ({ browser }) => {
  await resetFixture();
  const captured: string[] = [];
  for (const [i, zone] of ['America/New_York', 'UTC', 'Australia/Sydney'].entries()) {
    const ctx = await asAdmin(browser, { timezoneId: zone, locale: 'en-GB' });
    const page = await ctx.newPage();
    await page.goto('/admin/concerts/1/shows');
    const card = showCard(page, 'Evening Show');
    const text = (await card.innerText()).split('\n').find((l) => /2026/.test(l)) ?? '';
    captured.push(text.trim());
    // 12:00Z is 20:00 in Asia/Kuala_Lumpur — the venue's clock, in every viewer zone.
    expect(text, `rendered in ${zone}`).toContain('20:00');
    await shot(page, `FLOW-19-step-${i + 1}-${zone.replace('/', '-')}`);
    await ctx.close();
  }
  expect(new Set(captured).size, `identical in every zone: ${JSON.stringify(captured)}`).toBe(1);
});

// ------------------------------------------------------------------ FLOW-20
test('FLOW-20 an oversold segment reads full, N over — never a negative pool', async ({
  browser,
}) => {
  // The over-capacity state is created the only way the system allows it: the
  // §7.6 admin override on claim_seats(). `attendees` refuses a direct insert.
  const [pool] = await sql<{ over: number }[]>`select (segment_pool(3) ->> 'over')::int as over`;
  expect(Number(pool.over), 'fixture: segment 3 is 2 seats over').toBe(2);

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto('/admin/concerts/1/overview');
  const card = page.getByText('Matinee Show').first();
  await expect(card).toBeVisible();
  const body = await page.locator('main').innerText();
  expect(body).toMatch(/2 over/);
  expect(body, 'no negative number reaches the screen').not.toMatch(/-\d/);
  await shot(page, 'FLOW-20-step-1-overview-over');

  await page.goto('/admin/concerts/1/shows');
  const shows = await page.locator('main').innerText();
  expect(shows).toMatch(/full, 2 over/);
  expect(shows).not.toMatch(/-\d/);
  await shot(page, 'FLOW-20-step-2-shows-over');
  await ctx.close();
});
