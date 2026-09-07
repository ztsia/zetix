import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Module A — phase 5. Every phase-2 flow walked in Chromium.
 *
 * Each step asserts before it screenshots. Screenshots are evidence for a human;
 * the assertion is the test.
 */
const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 3,
});
test.afterAll(async () => {
  await sql.end();
});

// `next dev` compiles each route on first request, which can take well over
// Playwright's 30s default. That is a dev-server property, not a finding.
test.setTimeout(180_000);

// 1280×1000, not the 1280×720 default. The segment form dialog is 979px tall
// and does not scroll, so below about 850px its submit button is unreachable —
// see `a-dialog-overflow.spec.ts`, which is the test for that. These flows are
// about behaviour, so they are given a viewport tall enough to reach it.
test.use({ viewport: { width: 1280, height: 1000 } });

const SHOTS = 'qa-artifacts/A-config-and-people/screens';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function asAdmin(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
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

/**
 * The row for one segment.
 *
 * Each row's Edit button is labelled only "Edit" — there are two on the page and
 * nothing in the accessible name says which segment. Scoping through the list
 * item is the only way to address them apart.
 */
function segmentRow(page: Page, name: string) {
  return page.getByRole('listitem').filter({ hasText: name }).first();
}

async function ids() {
  const [c] = await sql<{ id: number }[]>`select id from concerts where slug = 'qa-sep'`;
  const [s] = await sql<{ id: number }[]>`select id from shows where name = 'Evening Show'`;
  const segs = await sql<{ id: number; audience_mode: string }[]>`
    select id, audience_mode from show_segments where show_id = ${s.id} order by display_order
  `;
  return {
    concertId: Number(c.id),
    showId: Number(s.id),
    publicSegment: Number(segs.find((x) => x.audience_mode === 'PUBLIC')!.id),
    playerSegment: Number(segs.find((x) => x.audience_mode === 'PLAYER_INVITED')!.id),
  };
}

// ---------------------------------------------------------------- FLOW-13/14
test('FLOW-13 anonymous is refused every module A screen', async ({ browser }) => {
  const { concertId } = await ids();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  for (const [n, path] of [
    [1, '/admin/concerts'],
    [2, `/admin/concerts/${concertId}/players`],
    [3, '/admin/settings'],
  ] as const) {
    const res = await page.goto(path);
    const body = (await page.content()) ?? '';
    expect(new URL(page.url()).pathname, `${path} must not render`).toBe('/login');
    // The players screen is the one that carries PII.
    expect(body).not.toContain('player1@example.test');
    expect(res!.status()).toBeLessThan(400);
    await shot(page, `FLOW-13-step-${n}-anon-${path.replace(/\W+/g, '-').replace(/^-|-$/g, '')}`);
  }
  await ctx.close();
});

test('FLOW-14 a signed-in OPERATOR is refused every module A screen', async ({ browser }) => {
  const { concertId } = await ids();
  const ctx = await asOperator(browser, 'Wei Ling');
  const page = await ctx.newPage();

  for (const [n, path] of [
    [1, '/admin/concerts'],
    [2, `/admin/concerts/${concertId}/players`],
    [3, `/admin/concerts/${concertId}/shows`],
    [4, '/admin/settings'],
  ] as const) {
    await page.goto(path);
    const body = await page.content();
    // `/scan` forwards an operator with exactly one assignment to that show,
    // so the landing path is `/scan` or `/scan/<id>`. Either is a refusal.
    expect(
      new URL(page.url()).pathname,
      `${path} must not render for an operator`,
    ).toMatch(/^\/scan(\/|$)/);
    expect(body).not.toContain('player1@example.test');
    expect(body).not.toContain('seedtoken');
    await shot(page, `FLOW-14-step-${n}-operator-refused`);
  }
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-1
test('FLOW-1 admin reaches the concert and its show', async ({ browser }) => {
  const { concertId } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto('/admin/concerts');
  await expect(page.getByRole('heading', { name: 'Concerts' })).toBeVisible();
  await expect(page.getByText('QA September')).toBeVisible();
  await shot(page, 'FLOW-1-step-1-concerts-list');

  await page.goto(`/admin/concerts/${concertId}/shows`);
  await expect(page.getByRole('heading', { name: 'Shows' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evening Show' })).toBeVisible();
  await shot(page, 'FLOW-1-step-2-shows');
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-2
test('FLOW-2 the two segments fill the hall and held seats read zero', async ({ browser }) => {
  const { concertId } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto(`/admin/concerts/${concertId}/shows`);
  await expect(page.getByText('Public', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Player invited', { exact: false }).first()).toBeVisible();
  // 300 + 100 = 400 exactly, so nothing is held (domain.md §5.1).
  await expect(page.getByText(/0 held/i).first()).toBeVisible();
  await shot(page, 'FLOW-2-step-1-segments-fill-hall');
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-3
test('FLOW-3 a second segment of a mode the show already has is refused', async ({ browser }) => {
  const { concertId, showId } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto(`/admin/concerts/${concertId}/shows`);
  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Evening Show' }).first();
  await expect(card.getByRole('heading', { name: 'Evening Show' })).toBeVisible();
  await shot(page, 'FLOW-3-step-1-before');

  // The show already has both modes, so the UI offers no "Add segment" button
  // on that card at all — the refusal is by construction.
  const before = await sql<{ count: string }[]>`
    select count(*)::text as count from show_segments where show_id = ${showId} and deleted_at is null
  `;
  expect(Number(before[0].count)).toBe(2);
  const addButtons = await card.getByRole('button', { name: 'Add segment' }).count();
  expect(addButtons, 'both audience modes are used, so no mode is left to add').toBe(0);
  await shot(page, 'FLOW-3-step-2-no-mode-left');
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-4
test('FLOW-4 oversizing a segment past the hall is refused in the UI', async ({ browser }) => {
  const { concertId, playerSegment } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto(`/admin/concerts/${concertId}/shows`);
  await segmentRow(page, 'Player invited').getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await shot(page, 'FLOW-4-step-1-segment-form');

  await dialog.getByLabel('Capacity').fill('150');
  await dialog.getByRole('button', { name: 'Save segment' }).click();

  await expect(dialog.getByRole('alert')).toContainText(/total 450 seats, but the hall holds 400/i);
  await shot(page, 'FLOW-4-step-2-refused');

  const [row] = await sql<{ capacity: number }[]>`
    select capacity from show_segments where id = ${playerSegment}
  `;
  expect(row.capacity, 'nothing was written').toBe(100);
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-8
test('FLOW-8 raising the base quota past capacity is refused with the §7.4 sentence', async ({
  browser,
}) => {
  const { concertId, playerSegment } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto(`/admin/concerts/${concertId}/shows`);
  await segmentRow(page, 'Player invited').getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Base quota per player').fill('2');
  await shot(page, 'FLOW-8-step-1-quota-raised');

  await dialog.getByRole('button', { name: 'Save segment' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    '80 active players × 2 base = 160 seats, but the segment holds 100.',
  );
  await expect(dialog.getByRole('alert')).toContainText('Reduce the quota to 1');
  await shot(page, 'FLOW-8-step-2-refused');

  const [row] = await sql<{ base_quota: number }[]>`
    select base_quota from show_segments where id = ${playerSegment}
  `;
  expect(row.base_quota).toBe(1);
  await ctx.close();
});

// ------------------------------------------------------------------- FLOW-7
test('FLOW-7 the player who would not fit is refused, and no row is written', async ({
  browser,
}) => {
  const { concertId } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  // Fill the segment exactly: 100 capacity, quota 1, so player 101 is the one
  // that breaches. Twenty more players get us from 80 to 100.
  await sql`insert into players (concert_id, full_name, invite_token, is_active)
    select ${concertId}, 'Filler ' || g, 'fillertoken' || lpad(g::text, 11, '0'), true
      from generate_series(81, 100) g`;

  await page.goto(`/admin/concerts/${concertId}/players`);
  await expect(page.getByRole('heading', { name: 'Players' })).toBeVisible();
  await shot(page, 'FLOW-7-step-1-players');

  await page.getByRole('button', { name: 'New player' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill('One Too Many');
  await shot(page, 'FLOW-7-step-2-form');

  await dialog.getByRole('button', { name: /Add player|Save player/ }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    '101 active players × 1 base = 101 seats, but the segment holds 100.',
  );
  await shot(page, 'FLOW-7-step-3-refused');

  const [{ count }] = await sql<{ count: string }[]>`
    select count(*)::text as count from players where full_name = 'One Too Many'
  `;
  expect(Number(count)).toBe(0);

  await sql`delete from players where full_name like 'Filler %'`;
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-9
test('FLOW-9 moving 20 seats commits both segments and audits it', async ({ browser }) => {
  const { concertId, showId, playerSegment, publicSegment } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto(`/admin/concerts/${concertId}/shows`);
  await page.getByRole('button', { name: 'Move capacity' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await shot(page, 'FLOW-9-step-1-dialog');

  await dialog.getByLabel(/^Player invited/).fill('80');
  await dialog.getByLabel(/^Public/).fill('320');
  await dialog.getByLabel('Reason').fill('Player segment closed with seats unclaimed.');
  await expect(dialog.getByText(/0 held back/)).toBeVisible();
  await shot(page, 'FLOW-9-step-2-filled');

  await dialog.getByRole('button', { name: 'Save capacities' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  const rows = await sql<{ id: number; capacity: number }[]>`
    select id, capacity from show_segments where show_id = ${showId} order by display_order
  `;
  expect(rows.map((r) => r.capacity)).toEqual([320, 80]);

  const audit = await sql<{ reason: string }[]>`
    select reason from audit_log where action = 'segment.capacity_moved' order by id desc limit 1
  `;
  expect(audit[0].reason).toBe('Player segment closed with seats unclaimed.');
  await shot(page, 'FLOW-9-step-3-committed');

  // Put it back for the flows that follow.
  await sql`update show_segments set capacity = 100 where id = ${playerSegment}`;
  await sql`update show_segments set capacity = 300 where id = ${publicSegment}`;
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-10
test('FLOW-10 a move below the confirmed count is refused, nothing changes', async ({
  browser,
}) => {
  const { concertId, showId, publicSegment } = await ids();

  const [reg] = await sql<{ id: number }[]>`
    insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${showId}, ${publicSegment}, 'ADMIN', 'QA Party', 'party@example.test', 'CONFIRMED', now())
    returning id`;
  await sql`select set_config('zetix.granting', 'on', true)`;
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    await tx`insert into attendees (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status, ticket_code, qr_token)
      select ${reg.id}, ${showId}, ${publicSegment}, 'Guest ' || g, 'PROVIDED', 'EXTRA', 'CONFIRMED',
             'QA-' || lpad(g::text, 6, '0'), 'qatoken' || lpad(g::text, 15, '0')
        from generate_series(1, 40) g`;
  });

  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${concertId}/shows`);
  await page.getByRole('button', { name: 'Move capacity' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/40 confirmed/)).toBeVisible();
  await expect(dialog.getByText(/cannot go below 40/)).toBeVisible();
  await shot(page, 'FLOW-10-step-1-floor-shown');

  await dialog.getByLabel(/^Public/).fill('10');
  await dialog.getByRole('button', { name: 'Save capacities' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/40 confirmed seats/i);
  await shot(page, 'FLOW-10-step-2-refused');

  const [row] = await sql<{ capacity: number }[]>`
    select capacity from show_segments where id = ${publicSegment}
  `;
  expect(row.capacity).toBe(300);

  await sql`delete from attendees where registration_id = ${reg.id}`;
  await sql`delete from registrations where id = ${reg.id}`;
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-15
test('FLOW-15 the show time does not move with the viewer’s timezone', async ({ browser }) => {
  const { concertId } = await ids();

  const read = async (timezoneId: string, n: number) => {
    const ctx = await browser.newContext({ timezoneId });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByLabel('Admin code').fill('qa-admin-code');
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith('/login')),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    await page.goto(`/admin/concerts/${concertId}/shows`);
    await expect(page.getByRole('heading', { name: 'Evening Show' })).toBeVisible();
    const text = await page.locator('body').innerText();
    await shot(page, `FLOW-15-step-${n}-${timezoneId.replace(/\W+/g, '-')}`);
    await ctx.close();
    return text;
  };

  const ny = await read('America/New_York', 1);
  const utc = await read('UTC', 2);

  // 12:00Z is 20:00 at the venue. Both browsers must show the venue's clock.
  expect(ny).toMatch(/8:00\s*pm|20:00/i);
  expect(utc).toMatch(/8:00\s*pm|20:00/i);
  expect(ny).not.toMatch(/\b4:00\s*am\b/i); // New York's own reading of 12:00Z
});

// ------------------------------------------------------------------ FLOW-11/12
test('FLOW-11 and FLOW-12 the settings screen writes and validates', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible();
  await shot(page, 'FLOW-11-step-1-settings');

  // Happy: change a system value and confirm the database holds it.
  const row = page.locator('form').filter({ has: page.locator('input[name="key"][value="email.max_per_dispatch"]') }).first();
  await row.getByRole('textbox').or(row.locator('input[type="number"]')).first().fill('30');
  await row.getByRole('button', { name: /save/i }).first().click();
  await expect
    .poll(async () => {
      const [r] = await sql<{ value: unknown }[]>`
        select value from system_settings where key = 'email.max_per_dispatch'
      `;
      return r?.value;
    }, { timeout: 15_000 })
    .toBe(30);
  await shot(page, 'FLOW-11-step-2-saved');

  // Sad: a negative count. domain.md §6 calls this "messages per dispatch".
  await row.getByRole('textbox').or(row.locator('input[type="number"]')).first().fill('-1');
  await row.getByRole('button', { name: /save/i }).first().click();
  await page.waitForTimeout(2000);
  const [after] = await sql<{ value: unknown }[]>`
    select value from system_settings where key = 'email.max_per_dispatch'
  `;
  await shot(page, 'FLOW-12-step-1-negative');
  expect(after?.value, 'a negative messages-per-dispatch must not be stored').not.toBe(-1);

  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-5/6
test('FLOW-5 and FLOW-6 the player CSV import previews and refuses', async ({ browser }) => {
  const { concertId } = await ids();
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto(`/admin/concerts/${concertId}/players`);
  await page.getByRole('button', { name: /import/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await shot(page, 'FLOW-6-step-1-import-dialog');

  // A file with a duplicated address and a row with no name.
  const bad = [
    'Name,Email,Instrument',
    'Dup One,dup@example.test,Violin',
    'Dup Two,dup@example.test,Viola',
    ',orphan@example.test,Cello',
  ].join('\n');
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'players.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(bad),
  });
  await expect(dialog.getByText(/skip/i).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, 'FLOW-6-step-2-preview-reports-rows');

  const [{ count }] = await sql<{ count: string }[]>`
    select count(*)::text as count from players where concert_id = ${concertId}
  `;
  expect(Number(count), 'the preview writes nothing').toBe(80);
  await ctx.close();
});

// ------------------------------------------------------------------ FLOW-16
test('FLOW-16 archiving a concert keeps the row and writes an audit entry', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto('/admin/concerts');
  await shot(page, 'FLOW-16-step-1-list');
  await page.getByRole('button', { name: /Actions for QA September|Open menu|More/i }).first().click();
  await page.getByRole('menuitem', { name: /archive/i }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  if (await confirm.getByRole('button', { name: /archive/i }).count()) {
    await confirm.getByRole('button', { name: /archive/i }).first().click();
  }

  await expect
    .poll(async () => {
      const [r] = await sql<{ status: string }[]>`select status from concerts where slug = 'qa-sep'`;
      return r?.status;
    }, { timeout: 15_000 })
    .toBe('ARCHIVED');
  await shot(page, 'FLOW-16-step-2-archived');

  const [r] = await sql<{ deleted_at: Date | null }[]>`
    select deleted_at from concerts where slug = 'qa-sep'
  `;
  expect(r.deleted_at, 'archive is a status change, not a delete').toBeNull();

  const [{ count }] = await sql<{ count: string }[]>`
    select count(*)::text as count from audit_log where action = 'concert.archived'
  `;
  expect(Number(count)).toBe(1);

  await sql`update concerts set status = 'ACTIVE' where slug = 'qa-sep'`;
  await ctx.close();
});
