/**
 * QA phase-5 browser pass for module `H` — the live check-in dashboard, the
 * scan log with revert, and operator provisioning.
 *
 * Fixtures come from `qa/support/start-h.sh`. Serial by design: the flows
 * mutate the same show and the same operator on purpose, because that is the
 * order an admin walks them in on the night.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const QA_URL = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(QA_URL, { prepare: false, max: 3 });
const SHOTS = 'qa-artifacts/H-checkin-dashboard/screens';
const CONCERT = 1;
const SHOW1 = 1;
const _SHOW2 = 2;
/**
 * A fresh usher name per run. The QA GoTrue stub keeps its users in memory for
 * the life of the process, so a fixed name makes the second run of this file
 * fail on a duplicate Auth address rather than on anything the module did.
 */
const USHER = `Qa Usher ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const USHER_SLUG = USHER.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function asAdmin(browser: Browser, timezoneId?: string): Promise<BrowserContext> {
  const ctx = await browser.newContext(timezoneId ? { timezoneId } : {});
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

async function operatorSignIn(browser: Browser, name: string, code: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Access code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForLoadState('networkidle');
  return { ctx, page };
}

test.describe.configure({ mode: 'serial' });

/**
 * Puts the fixtures back where `seed-h.mjs` left them, without truncating the
 * tables under a running `next dev` (which would leave every concert page 404).
 */
test.beforeAll(async () => {
  await sql`update check_ins set reverted_at = null, reverted_by = null`;
  await sql`delete from audit_log`;
  await sql`delete from operator_show_assignments where user_id in (
    select id from app_users where display_name = ${USHER})`;
  await sql`delete from app_users where display_name = ${USHER}`;
  await sql`update app_users set is_active = true where role = 'OPERATOR'`;
});

test.afterAll(async () => {
  await sql.end();
});

/** FLOW-1 — the admin watches arrivals live. */
test('FLOW-1 dashboard counts match the database', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  await page.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}`);
  await expect(page.getByRole('heading', { name: 'Check-in' })).toBeVisible();
  await shot(page, 'FLOW-1-step-1-dashboard');

  const [confirmed] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendees where show_id = ${SHOW1} and status = 'CONFIRMED'`;
  const [live] = await sql<{ n: number }[]>`
    select count(distinct c.attendee_id)::int as n from check_ins c
      join attendees a on a.id = c.attendee_id
     where c.show_id = ${SHOW1} and c.reverted_at is null and a.status = 'CONFIRMED'`;

  // Anchored on the card itself rather than on `div` + `..`. The old locator
  // matched whichever nesting level happened to wrap the label, so it read the
  // right number on a desktop viewport and the header alone on a narrow one —
  // failing on the phone projects for a layout reason rather than a real one.
  const card = (label: string) =>
    page.locator('[data-slot="card"]').filter({ hasText: new RegExp(`^${label}`) }).first();

  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  const body = await page.locator('body').innerText();
  expect(body).toContain('Confirmed');
  // The three numbers, read off the cards.
  expect(await card('Confirmed').innerText()).toContain(String(confirmed!.n));
  expect(await card('Checked in').innerText()).toContain(String(live!.n));
  expect(await card('Remaining').innerText()).toContain(
    String(Number(confirmed!.n) - Number(live!.n)),
  );
  // Alice was scanned twice on two devices and must count once.
  expect(Number(live!.n)).toBe(3);

  // Per-operator counts and the arrival chart are both present.
  await expect(page.getByText('By operator')).toBeVisible();
  await expect(page.getByText('Wei Ling', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Arrivals', { exact: true })).toBeVisible();
  // The bar chart animates in; screenshot it settled so the evidence is honest.
  await page.waitForTimeout(1200);
  await shot(page, 'FLOW-1-step-2-counts-and-chart');

  // The scan log lists this show only — Siti belongs to show 2.
  await expect(page.getByRole('heading', { name: 'Scan log' })).toBeVisible();
  await expect(page.getByText('Siti Rahman')).toHaveCount(0);
  await shot(page, 'FLOW-1-step-3-scan-log');
  await ctx.close();
});

/** FLOW-1b — searching the scan log. */
test('FLOW-1b scan log search narrows to one attendee', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}`);
  await page.getByPlaceholder('Search name, ticket, operator or device…').fill('alice');
  await page.waitForTimeout(1500);
  await expect(page.getByRole('cell', { name: 'Alice Tan' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Bob Tan' })).toHaveCount(0);
  await shot(page, 'FLOW-1b-step-1-search-alice');
  await ctx.close();
});

/** FLOW-2 — reverting a mistaken scan. */
test('FLOW-2 revert stamps the row, never deletes, and writes an audit entry', async ({
  browser,
}) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}`);

  const [before] = await sql<{ n: number }[]>`
    select count(*)::int as n from check_ins where show_id = ${SHOW1}`;

  await page.getByRole('button', { name: 'Revert the scan for Bob Tan' }).click();
  await expect(page.getByRole('heading', { name: /Revert the scan for Bob Tan/ })).toBeVisible();
  await page.getByLabel('Reason (optional)').fill('QA: scanned the wrong person');
  await shot(page, 'FLOW-2-step-1-confirm-dialog');
  await page.getByRole('button', { name: 'Revert scan' }).click();
  await page.waitForTimeout(2000);
  await shot(page, 'FLOW-2-step-2-after-revert');

  const [after] = await sql<{ n: number }[]>`
    select count(*)::int as n from check_ins where show_id = ${SHOW1}`;
  expect(Number(after!.n)).toBe(Number(before!.n));

  const [bobRow] = await sql<{ reverted_at: Date | null; reverted_by: string | null }[]>`
    select c.reverted_at, c.reverted_by from check_ins c
      join attendees a on a.id = c.attendee_id
     where a.full_name = 'Bob Tan' and c.show_id = ${SHOW1}`;
  expect(bobRow!.reverted_at).not.toBeNull();
  expect(bobRow!.reverted_by).toBe('11111111-1111-4111-8111-111111111111');

  const audit = await sql<{ reason: string | null; actor_id: string }[]>`
    select reason, actor_id from audit_log where action = 'checkin.reverted'`;
  expect(audit.length).toBeGreaterThan(0);
  expect(audit.at(-1)!.reason).toBe('QA: scanned the wrong person');

  // Bob has dropped out of the checked-in count and back into remaining.
  await page.reload();
  const cardText = await page.locator('body').innerText();
  expect(cardText).toContain('Checked in');
  const [liveNow] = await sql<{ n: number }[]>`
    select count(distinct c.attendee_id)::int as n from check_ins c
      join attendees a on a.id = c.attendee_id
     where c.show_id = ${SHOW1} and c.reverted_at is null and a.status = 'CONFIRMED'`;
  expect(Number(liveNow!.n)).toBe(2);
  await shot(page, 'FLOW-2-step-3-counts-dropped');
  await ctx.close();
});

/** FLOW-3 — reverting the same row twice. */
test('FLOW-3 a reverted row cannot be reverted again', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}&reverted=1`);
  await expect(page.getByRole('cell', { name: 'Bob Tan' }).first()).toBeVisible();
  await shot(page, 'FLOW-3-step-1-reverted-row-visible');

  const revertAgain = page.getByRole('button', { name: 'Revert the scan for Bob Tan' });
  const count = await revertAgain.count();
  if (count === 0) {
    // Correct: no control is offered for a row already reverted.
    await shot(page, 'FLOW-3-step-2-no-control-offered');
  } else {
    await revertAgain.first().click();
    await page.getByRole('button', { name: 'Revert scan' }).click();
    await expect(page.getByRole('alert')).toContainText(/already been reverted/i);
    await shot(page, 'FLOW-3-step-2-refused');
  }

  const rows = await sql<{ reverted_by: string }[]>`
    select c.reverted_by from check_ins c join attendees a on a.id = c.attendee_id
     where a.full_name = 'Bob Tan' and c.reverted_at is not null`;
  expect(rows).toHaveLength(1);
  await ctx.close();
});

/** FLOW-12 — timestamps render in the concert's zone, not the viewer's. */
test('FLOW-12 scan times do not move with the browser timezone', async ({ browser }) => {
  const nyc = await asAdmin(browser, 'America/New_York');
  const nycPage = await nyc.newPage();
  await nycPage.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}`);
  await expect(nycPage.getByRole('heading', { name: 'Scan log' })).toBeVisible();
  const nycText = await nycPage.locator('table').last().innerText();
  await shot(nycPage, 'FLOW-12-step-1-new-york-browser');

  const tokyo = await asAdmin(browser, 'Pacific/Kiritimati');
  const tokyoPage = await tokyo.newPage();
  await tokyoPage.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}`);
  await expect(tokyoPage.getByRole('heading', { name: 'Scan log' })).toBeVisible();
  const tokyoText = await tokyoPage.locator('table').last().innerText();
  await shot(tokyoPage, 'FLOW-12-step-2-kiritimati-browser');

  expect(tokyoText).toBe(nycText);
  // Kuala Lumpur is UTC+8, so an 11:00Z scan reads 19:00 at the venue.
  expect(nycText).toContain('19:0');
  await nyc.close();
  await tokyo.close();
});

/** FLOW-11 — anonymous. */
test('FLOW-11 anonymous is bounced from both screens with no data', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}`);
  await expect(page).toHaveURL(/\/login/);
  expect(await page.content()).not.toContain('Alice Tan');
  await shot(page, 'FLOW-11-step-1-checkin-bounced');

  await page.goto(`/admin/concerts/${CONCERT}/operators`);
  await expect(page).toHaveURL(/\/login/);
  expect(await page.content()).not.toContain('operators.invalid');
  await shot(page, 'FLOW-11-step-2-operators-bounced');
  await ctx.close();
});

/** FLOW-10 — an operator on the admin screens. */
test('FLOW-10 an operator cannot reach either admin screen', async ({ browser }) => {
  const { ctx, page } = await operatorSignIn(browser, 'Wei Ling', 'qa-op-code');
  await expect(page).toHaveURL(/\/scan/);
  await shot(page, 'FLOW-10-step-1-operator-signed-in');

  for (const [n, path] of [
    ['2', `/admin/concerts/${CONCERT}/checkin`],
    ['3', `/admin/concerts/${CONCERT}/operators`],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/scan/);
    const html = await page.content();
    expect(html).not.toContain('Alice Tan');
    expect(html).not.toContain('operators.invalid');
    await shot(page, `FLOW-10-step-${n}-refused`);
  }
  await ctx.close();
});

/** FLOW-10b — an operator with no assignment at all. */
test('FLOW-10b an unassigned operator reaches no attendee data', async ({ browser }) => {
  const { ctx, page } = await operatorSignIn(browser, 'No Shows', 'qa-op-code');
  await expect(page.getByText('No shows assigned yet')).toBeVisible();
  await shot(page, 'FLOW-10b-step-1-empty-show-list');

  const manifest = await page.request.get(`/api/checkin/manifest?showId=${SHOW1}`);
  expect(manifest.status()).toBe(404);
  expect(await manifest.text()).not.toContain('Alice');
  await shot(page, 'FLOW-10b-step-2-manifest-404');

  await page.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}`);
  await expect(page).toHaveURL(/\/scan/);
  await shot(page, 'FLOW-10b-step-3-admin-refused');
  await ctx.close();
});

/** FLOW-4 / 5 / 6 / 7 / 8 / 9 — the operator lifecycle, end to end. */
test('FLOW-4..9 provision, sign in, assign, revoke, rotate, deactivate', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${CONCERT}/operators`);
  await expect(page.getByRole('heading', { name: 'Operators' })).toBeVisible();
  await shot(page, 'FLOW-4-step-1-operators-list');

  // FLOW-4 — create.
  await page.getByRole('button', { name: 'Add operator' }).click();
  await page.getByLabel('Display name').fill(USHER);
  await shot(page, 'FLOW-4-step-2-create-form');
  await page.getByRole('button', { name: 'Create and show code' }).click();

  await expect(page.getByRole('heading', { name: new RegExp(`Access code for ${USHER}`) })).toBeVisible();
  const code = await page.locator('#issued-access-code').inputValue();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await shot(page, 'FLOW-4-step-3-code-shown-once');

  const [created] = await sql<{ id: string; email: string; role: string }[]>`
    select id, email, role from app_users where display_name = ${USHER}`;
  expect(created!.email).toBe(`${USHER_SLUG}@operators.invalid`);
  expect(created!.role).toBe('OPERATOR');

  await page.getByRole('button', { name: 'I have saved it' }).click();
  await page.reload();
  expect(await page.content()).not.toContain(code);
  await shot(page, 'FLOW-4-step-4-code-not-recoverable');

  // The access code never reaches the audit log.
  const audits = await sql<{ blob: string }[]>`
    select row_to_json(audit_log)::text as blob from audit_log where action like 'operator.%'`;
  for (const a of audits) expect(a.blob).not.toContain(code);

  // FLOW-5 — the new operator signs in and sees nothing.
  const first = await operatorSignIn(browser, USHER, code);
  await expect(first.page.getByText('No shows assigned yet')).toBeVisible();
  await shot(first.page, 'FLOW-5-step-1-empty-show-list');
  const early = await first.page.request.get(`/api/checkin/manifest?showId=${SHOW1}`);
  expect(early.status()).toBe(404);
  await first.ctx.close();

  // FLOW-6 — assign the evening show.
  await page.getByRole('button', { name: `Actions for ${USHER}` }).click();
  await page.getByRole('menuitem', { name: 'Assign shows' }).click();
  await expect(page.getByRole('heading', { name: `Shows for ${USHER}` })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Evening Show' }).click();
  await shot(page, 'FLOW-6-step-1-assignment-grid');
  await page.getByRole('button', { name: 'Save assignments' }).click();
  await page.waitForTimeout(1500);

  const assigned = await sql<{ show_id: number; assigned_by: string }[]>`
    select show_id, assigned_by from operator_show_assignments where user_id = ${created!.id}`;
  expect(assigned).toHaveLength(1);
  expect(Number(assigned[0]!.show_id)).toBe(SHOW1);
  expect(assigned[0]!.assigned_by).toBe('11111111-1111-4111-8111-111111111111');
  await shot(page, 'FLOW-6-step-2-assignment-saved');

  const assignedOp = await operatorSignIn(browser, USHER, code);
  await expect(assignedOp.page).toHaveURL(/\/scan\/1/);
  const manifest = await assignedOp.page.request.get(`/api/checkin/manifest?showId=${SHOW1}`);
  expect(manifest.status()).toBe(200);
  await shot(assignedOp.page, 'FLOW-6-step-3-operator-sees-the-show');

  // FLOW-7 — revoke while that session is still open.
  await page.getByRole('button', { name: `Actions for ${USHER}` }).click();
  await page.getByRole('menuitem', { name: 'Assign shows' }).click();
  await page.getByRole('checkbox', { name: 'Evening Show' }).click();
  await page.getByRole('button', { name: 'Save assignments' }).click();
  await page.waitForTimeout(1500);
  const afterRevoke = await sql`
    select show_id from operator_show_assignments where user_id = ${created!.id}`;
  expect(afterRevoke).toHaveLength(0);
  await shot(page, 'FLOW-7-step-1-revoked');

  const refused = await assignedOp.page.request.get(`/api/checkin/manifest?showId=${SHOW1}`);
  expect(refused.status()).toBe(404);
  expect(await refused.text()).not.toContain('Alice');
  // A queued offline scan is refused on sync too.
  const sha256 = createHash('sha256').update('AliceTan00000000000001').digest('hex');
  const scanWrite = await assignedOp.page.request.post('/api/checkin/scan', {
    data: {
      showId: SHOW1,
      scans: [
        {
          qrTokenSha256: sha256,
          scannedAt: new Date().toISOString(),
          source: 'OFFLINE_SYNC',
          deviceId: 'qa-phone',
        },
      ],
    },
  });
  expect(scanWrite.status()).toBe(404);
  const [written] = await sql<{ n: number }[]>`
    select count(*)::int as n from check_ins where device_id = 'qa-phone'`;
  expect(Number(written!.n)).toBe(0);
  await assignedOp.page.goto('/scan');
  await expect(assignedOp.page.getByText('No shows assigned yet')).toBeVisible();
  await shot(assignedOp.page, 'FLOW-7-step-2-operator-refused');
  await assignedOp.ctx.close();

  // FLOW-8 — rotate the code.
  await page.getByRole('button', { name: `Actions for ${USHER}` }).click();
  await page.getByRole('menuitem', { name: 'Issue a new code' }).click();
  await shot(page, 'FLOW-8-step-1-rotate-confirm');
  await page.getByRole('button', { name: /Issue a new code/ }).last().click();
  await expect(page.getByRole('heading', { name: new RegExp(`Access code for ${USHER}`) })).toBeVisible();
  const rotated = await page.locator('#issued-access-code').inputValue();
  expect(rotated).not.toBe(code);
  await shot(page, 'FLOW-8-step-2-new-code-shown');
  await page.getByRole('button', { name: 'I have saved it' }).click();

  // Asked of Auth directly as well, so "the app never rotated it" and "the login
  // path accepted a dead code" cannot be confused for one another.
  const directOld = await page.request.post(
    'http://127.0.0.1:54321/auth/v1/token?grant_type=password',
    { data: { email: `${USHER_SLUG}@operators.invalid`, password: code } },
  );
  console.log('[QA] old code straight to Auth:', directOld.status());
  expect(directOld.status()).toBe(400);

  const withOldCode = await operatorSignIn(browser, USHER, code);
  await expect(withOldCode.page.locator('#scan-login-error')).toBeVisible();
  await expect(withOldCode.page).toHaveURL(/\/scan\/login/);
  await shot(withOldCode.page, 'FLOW-8-step-3-old-code-refused');
  await withOldCode.ctx.close();

  const withNewCode = await operatorSignIn(browser, USHER, rotated);
  await expect(withNewCode.page).toHaveURL(/\/scan/);
  await expect(withNewCode.page.getByText('No shows assigned yet')).toBeVisible();
  await shot(withNewCode.page, 'FLOW-8-step-4-new-code-accepted');

  // FLOW-9 — deactivate, with that session still open.
  await page.reload();
  await page.getByRole('button', { name: `Actions for ${USHER}` }).click();
  await page.getByRole('menuitem', { name: 'Deactivate' }).click();
  await shot(page, 'FLOW-9-step-1-deactivate-confirm');
  await page.getByRole('button', { name: 'Deactivate' }).last().click();
  await page.waitForTimeout(1500);
  const [state] = await sql<{ is_active: boolean }[]>`
    select is_active from app_users where id = ${created!.id}`;
  expect(state!.is_active).toBe(false);
  await shot(page, 'FLOW-9-step-2-deactivated');

  await withNewCode.page.goto('/scan');
  await expect(withNewCode.page).toHaveURL(/\/scan\/login/);
  await shot(withNewCode.page, 'FLOW-9-step-3-open-session-cut');
  const afterDeactivation = await withNewCode.page.request.get(
    `/api/checkin/manifest?showId=${SHOW1}`,
  );
  expect([401, 403, 404]).toContain(afterDeactivation.status());
  await withNewCode.ctx.close();

  const freshAttempt = await operatorSignIn(browser, USHER, rotated);
  await expect(freshAttempt.page).toHaveURL(/\/scan\/login/);
  await shot(freshAttempt.page, 'FLOW-9-step-4-fresh-signin-refused');
  await freshAttempt.ctx.close();

  await ctx.close();
});

/** FLOW-4b — the operator list carries the three facts §14.3 asks for. */
test('FLOW-4b operator list shows assigned shows, check-in counts and last sign-in', async ({
  browser,
}) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${CONCERT}/operators`);

  const headerRow = page.getByRole('row').first();
  for (const header of ['Assigned shows', 'Check-ins', 'Last sign-in', 'Status']) {
    await expect(headerRow).toContainText(header);
  }

  const [wei] = await sql<{ n: number }[]>`
    select count(*)::int as n from check_ins c join shows s on s.id = c.show_id
     where c.operator_id = '22222222-2222-4222-8222-222222222222'
       and s.concert_id = ${CONCERT} and c.reverted_at is null`;
  const weiRow = page.getByRole('row', { name: /Wei Ling/ });
  await expect(weiRow).toContainText(String(wei!.n));
  await expect(weiRow).toContainText('Evening Show');
  // The unassigned operator shows no shows at all.
  await expect(page.getByRole('row', { name: /No Shows/ })).toContainText(/None|—|0/);
  await shot(page, 'FLOW-4b-step-1-operator-list-facts');
  await ctx.close();
});

/** FLOW-13 — hostile provisioning input. */
test('FLOW-13 malformed operator names are refused with a message, not a stack trace', async ({
  browser,
}) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${CONCERT}/operators`);

  const [before] = await sql<{ n: number }[]>`
    select count(*)::int as n from app_users where role = 'OPERATOR'`;

  // Empty name — the browser's own required check must not be the only one.
  await page.getByRole('button', { name: 'Add operator' }).click();
  await page.getByRole('button', { name: 'Create and show code' }).click();
  await shot(page, 'FLOW-13-step-1-empty-name');

  // Punctuation only: nothing to build an address from.
  await page.getByLabel('Display name').fill('!!!');
  await page.getByRole('button', { name: 'Create and show code' }).click();
  await expect(page.getByRole('alert')).toContainText(/no letters or digits/i);
  await shot(page, 'FLOW-13-step-2-punctuation-refused');

  // SQL metacharacters and traversal text.
  await page.getByLabel('Display name').fill("'); drop table app_users;--");
  await page.getByRole('button', { name: 'Create and show code' }).click();
  await page.waitForTimeout(1500);
  await shot(page, 'FLOW-13-step-3-sql-metacharacters');
  const [tableStillThere] = await sql<{ n: number }[]>`select count(*)::int as n from app_users`;
  expect(Number(tableStillThere!.n)).toBeGreaterThan(0);

  const [after] = await sql<{ n: number }[]>`
    select count(*)::int as n from app_users where role = 'OPERATOR'`;
  // At most the one deliberate creation from the metacharacter name.
  expect(Number(after!.n) - Number(before!.n)).toBeLessThanOrEqual(1);
  await ctx.close();
});

/** Query-string tampering on the dashboard. */
test('FLOW-14 hand-edited dashboard query strings do not reach another concert', async ({
  browser,
}) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();

  for (const [n, q] of [
    ['1', '?show=999999'],
    ['2', '?page=-5&size=99999'],
    ['3', '?sort=full_name;drop%20table&dir=desc'],
    ['4', '?q=' + encodeURIComponent("' or 1=1 --")],
  ] as const) {
    const res = await page.goto(`/admin/concerts/${CONCERT}/checkin${q}`);
    expect(res!.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Check-in' })).toBeVisible();
    await shot(page, `FLOW-14-step-${n}-tampered-query`);
  }

  // A concert that does not exist is a 404, not a crash.
  const missing = await page.goto('/admin/concerts/98765/checkin');
  expect(missing!.status()).toBe(404);
  await shot(page, 'FLOW-14-step-5-unknown-concert');
  await ctx.close();
});

/**
 * FLOW-15 — searching the scan log for a literal `%`.
 *
 * Expected: nothing matches, because no attendee, ticket code, operator or
 * device id in this fixture contains a percent sign. This test is **expected to
 * fail** on the branch as reviewed: the search term is interpolated into an
 * `ILIKE` pattern without escaping, so `%` matches every row.
 */
test('FLOW-15 a literal % in the search box is not a wildcard', async ({ browser }) => {
  const ctx = await asAdmin(browser);
  const page = await ctx.newPage();
  await page.goto(`/admin/concerts/${CONCERT}/checkin?show=${SHOW1}`);
  await page.getByPlaceholder('Search name, ticket, operator or device…').fill('%');
  await page.waitForTimeout(1500);
  await shot(page, 'FLOW-15-step-1-percent-search');

  // Scoped to the scan log. A page-wide `getByRole('row')` also counts the
  // "By operator" table and the log's own empty-state row, so it could never
  // reach 1 however correct the search was.
  const scanLog = page.locator('table').filter({ hasText: 'Attendee' }).first();
  await expect(scanLog.getByRole('cell', { name: 'Alice Tan' })).toHaveCount(0);
  await expect(scanLog.getByRole('cell', { name: 'Bob Tan' })).toHaveCount(0);
  await expect(page.getByText('No matches')).toBeVisible();
  await ctx.close();
});
