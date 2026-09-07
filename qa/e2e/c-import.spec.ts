import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Module C — spreadsheet import. Flows from qa-artifacts/C-spreadsheet-import/02-flows.md.
 *
 * The identity provider is the local GoTrue stand-in from the F2 pass
 * (qa/support/gotrue-stub.mjs); nothing under src/ is changed.
 */
const SHOTS = 'qa-artifacts/C-spreadsheet-import/screens';
const TMP = '/tmp/claude-0/-home-user-zetix/7084ffa5-0318-5829-9d7a-f878dfd2e43c/scratchpad/sheets';
mkdirSync(SHOTS, { recursive: true });
mkdirSync(TMP, { recursive: true });

const sql = postgres(process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa', {
  prepare: false,
  max: 2,
});
test.afterAll(async () => { await sql.end(); });

const HEADERS = 'Timestamp,Contact Name,Contact Email,Attendee Name,Attendee Email,Ticket Type';

function csv(name: string, rows: string[]): string {
  const path = `${TMP}/${name}`;
  writeFileSync(path, [HEADERS, ...rows].join('\n'), 'utf8');
  return path;
}

async function loginAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Admin code').fill('qa-admin-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

async function ids() {
  const [c] = await sql<{ id: number }[]>`select id from concerts where slug = 'qa-concert'`;
  const segs = await sql<{ id: number; name: string }[]>`select id, name from show_segments order by id`;
  return { concertId: Number(c.id), segs };
}

async function clearImports() {
  await sql`delete from attendees`;
  await sql`delete from registrations`;
  await sql`delete from import_batches`;
}

/** Walks steps 0-3 and lands on the dry run. */
async function toDryRun(page: Page, opts: { concertId: number; segmentName: string; file: string }) {
  await page.goto(`/admin/concerts/${opts.concertId}/import`);
  await expect(page.getByRole('heading', { name: 'Spreadsheet import' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Target segment').click();
  await page.getByRole('option', { name: new RegExp(opts.segmentName) }).click();
  await page.setInputFiles('#file', opts.file);
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();
}

test.describe.configure({ mode: 'serial' });

test('FLOW-1 happy public import, end to end', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);

  await page.goto(`/admin/concerts/${concertId}/import`);
  await expect(page.getByRole('heading', { name: 'Prepare your sheet' })).toBeVisible();
  await expect(
    page.getByText('Repeat the contact columns on every row of a party'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Download/ }).first().or(page.getByRole('button', { name: /Download/ }).first())).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-1-prepare.png`, fullPage: true });

  const file = csv('flow1.csv', [
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Alice Tan,alice@example.com,Extra',
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Ben Tan,,Extra',
    '2026-08-01T11:00:00Z,Carol Lim,carol@example.com,Carol Lim,,Extra',
  ]);

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Target segment').click();
  await page.getByRole('option', { name: /Public Block/ }).click();
  await page.setInputFiles('#file', file);
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-2-upload.png`, fullPage: true });

  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByText('3 data rows below the header.')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-3-header.png`, fullPage: true });

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('This is a public segment, so every seat is EXTRA')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-4-mapping.png`, fullPage: true });

  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('3 rows → 2 registrations')).toBeVisible();
  await expect(page.getByText('Largest party 2')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-5-dryrun.png`, fullPage: true });

  // Nothing written yet (FLOW-11).
  const [{ n: before }] = await sql<{ n: number }[]>`select count(*)::int as n from registrations`;
  expect(before).toBe(0);

  await page.getByRole('button', { name: /^Commit 2 registrations$/ }).click();
  await expect(page.getByText('This cannot be undone')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-6-confirm.png`, fullPage: true });
  await page.getByLabel(/Type .* to confirm/).fill('Public Block');
  await page.getByRole('button', { name: 'Import' }).or(page.getByRole('button', { name: /Commit/ })).last().click();

  await expect(page.getByText('Imported')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/FLOW-1-step-7-imported.png`, fullPage: true });

  const rows = await sql<{ contact_name: string; requested_at: Date; n: number }[]>`
    select r.contact_name, r.requested_at, count(a.id)::int as n
      from registrations r left join attendees a on a.registration_id = r.id
     group by r.id order by r.requested_at`;
  expect(rows.map((r) => [r.contact_name, r.n])).toEqual([['Alice Tan', 2], ['Carol Lim', 1]]);
  expect(new Date(rows[0].requested_at).toISOString()).toBe('2026-08-01T10:00:00.000Z');
  const [{ status }] = await sql<{ status: string }[]>`select status from import_batches where status = 'COMMITTED'`;
  expect(status).toBe('COMMITTED');
});

test('FLOW-2 two rounds from one person are two registrations', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow2.csv', [
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Alice Tan,,Extra',
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Ben Tan,,Extra',
    '2026-08-02T11:00:00Z,Alice Tan,alice@example.com,Alice Tan,,Extra',
    '2026-08-02T11:00:00Z,Alice Tan,alice@example.com,Dee Tan,,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Public Block', file });
  await page.screenshot({ path: `${SHOTS}/FLOW-2-step-1-mapping.png`, fullPage: true });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('4 rows → 2 registrations')).toBeVisible();
  await expect(page.getByText('Largest party 2')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-2-step-2-grouping.png`, fullPage: true });
});

test('FLOW-3 public segment locks the seat type to EXTRA', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow3.csv', [
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Alice Tan,,Allocated',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Public Block', file });
  await expect(page.getByText('This is a public segment, so every seat is EXTRA')).toBeVisible();
  expect(await page.locator('#mode-uniform').count()).toBe(0);
  expect(await page.getByRole('radio').count()).toBe(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-3-step-1-locked.png`, fullPage: true });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('0 blocking').or(page.getByText(/rows → /))).toBeVisible();
  const seatBadges = await page.locator('table').getByText('EXTRA').count();
  expect(seatBadges).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-3-step-2-extra.png`, fullPage: true });
});

test('FLOW-4 a party of five against a base quota of two', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow4.csv', [
    '2026-08-01T10:00:00Z,Alice Tan,alice@players.test,Guest 1,,Allocated',
    '2026-08-01T10:00:00Z,Alice Tan,alice@players.test,Guest 2,,Allocated',
    '2026-08-01T10:00:00Z,Alice Tan,alice@players.test,Guest 3,,Allocated',
    '2026-08-01T10:00:00Z,Alice Tan,alice@players.test,Guest 4,,Allocated',
    '2026-08-01T10:00:00Z,Alice Tan,alice@players.test,Guest 5,,Allocated',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Player Block', file });
  // Uniform mode, BASE for the whole file.
  await page.getByRole('combobox').filter({ hasText: /EXTRA|BASE/ }).click();
  await page.getByRole('option', { name: /BASE/ }).click();
  await page.screenshot({ path: `${SHOTS}/FLOW-4-step-1-base.png`, fullPage: true });
  await page.getByRole('button', { name: 'Dry run' }).click();
  // The promotion itself happened: 2 BASE, 3 EXTRA marked "over quota".
  await expect(page.getByText('2 base · 3 extra (3 over quota)')).toBeVisible();
  expect(await page.locator('table').getByText('over quota').count()).toBe(3);
  await page.screenshot({ path: `${SHOTS}/FLOW-4-step-2-promoted.png`, fullPage: true });

  // But the §9.5 per-row info message is nowhere on the screen: the row also
  // carries a WARNING, and toReportRows() keeps only the worst finding per row.
  await expect(
    page.getByText('3 of 5 seats exceed the base quota and will be requested as extras.'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: /^Info 1$/ }).click();
  await expect(
    page.getByText('3 of 5 seats exceed the base quota and will be requested as extras.'),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-4-step-3-info-filter-empty.png`, fullPage: true });
});

test('FLOW-5 an unmapped ticket-type value blocks Continue', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow5.csv', [
    '2026-08-01T10:00:00Z,Alice Tan,alice@players.test,Guest 1,,Allocated',
    '2026-08-01T11:00:00Z,Ben Lim,ben@players.test,Guest 2,,Complimentary',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Player Block', file });
  await page.getByText('Read it from a column').click();
  // The column is already preselected from the header suggestions…
  await expect(page.getByRole('combobox').filter({ hasText: 'Ticket Type' })).toBeVisible();
  // …but no distinct values are listed, because runInspectWithColumn() only
  // fires from the Select's onValueChange and the value never changed.
  await expect(page.getByText(/distinct values in that column:/)).toHaveCount(0);
  await expect(page.getByText('Complimentary')).toHaveCount(0);
  // And Continue is enabled anyway: [].every(...) is vacuously true.
  await expect(page.getByRole('button', { name: 'Dry run' })).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-1-no-values-listed.png`, fullPage: true });

  await page.getByRole('button', { name: 'Dry run' }).click();
  // Every row now blocks, including the perfectly valid "Allocated" one.
  await expect(page.getByText(/is not mapped to BASE or EXTRA/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Commit/ })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-2-all-rows-blocked.png`, fullPage: true });

  // Re-picking the same column by hand is what actually loads the list.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('combobox').filter({ hasText: 'Ticket Type' }).click();
  await page.getByRole('option', { name: 'Ticket Type', exact: true }).click();
  await expect(page.getByText('2 distinct values in that column:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry run' })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/FLOW-5-step-3-values-after-repick.png`, fullPage: true });
});

test('FLOW-6 an import that overflows the segment is blocked', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow6.csv', [
    '2026-08-01T10:00:00Z,A,a@example.com,A1,,Extra',
    '2026-08-01T10:00:00Z,A,a@example.com,A2,,Extra',
    '2026-08-01T11:00:00Z,B,b@example.com,B1,,Extra',
    '2026-08-01T11:00:00Z,B,b@example.com,B2,,Extra',
    '2026-08-01T12:00:00Z,C,c@example.com,C1,,Extra',
    '2026-08-01T12:00:00Z,C,c@example.com,C2,,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Tiny Block', file });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText(/This import needs 6 seats but the segment has 3 open/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Commit/ })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/FLOW-6-step-1-overflow.png`, fullPage: true });
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from attendees`;
  expect(n).toBe(0);
});

test('FLOW-7 unnamed attendees ticket as placeholders', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow7.csv', [
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Alice Tan,,Extra',
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,,,Extra',
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,,,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Public Block', file });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('2 attendees have no name')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-7-step-1-placeholders.png`, fullPage: true });
  await page.getByRole('button', { name: /^Commit 1 registration/ }).click();
  await page.getByLabel(/Type .* to confirm/).fill('Public Block');
  await page.getByRole('button', { name: /Commit|Import/ }).last().click();
  await expect(page.getByText('Imported')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/FLOW-7-step-2-imported.png`, fullPage: true });
  const rows = await sql<{ full_name: string; name_source: string }[]>`
    select full_name, name_source from attendees order by id`;
  expect(rows.filter((r) => r.name_source === 'PLACEHOLDER').map((r) => r.full_name)).toEqual([
    'Guest of Alice Tan',
    'Guest of Alice Tan',
  ]);
});

test('FLOW-8 rows with no contact email each become their own registration', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow8.csv', [
    '2026-08-01T10:00:00Z,Walk In One,,Walk In One,,Extra',
    '2026-08-01T10:00:00Z,Walk In Two,,Walk In Two,,Extra',
    '2026-08-01T10:00:00Z,Walk In Three,,Walk In Three,,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Public Block', file });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('3 rows → 3 registrations')).toBeVisible();
  await expect(page.getByText(/3 rows with no email, each its own registration/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-8-step-1-ungrouped.png`, fullPage: true });
});

test('FLOW-9 a file that is not a spreadsheet', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const path = `${TMP}/evil.xlsx`;
  writeFileSync(path, Buffer.from('this is definitely not a spreadsheet'));
  await page.goto(`/admin/concerts/${concertId}/import`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Target segment').click();
  await page.getByRole('option', { name: /Public Block/ }).click();
  await page.setInputFiles('#file', path);
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByText('That did not work')).toBeVisible();
  await expect(page.getByText(/Could not read evil.xlsx as a spreadsheet/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-9-step-1-parse-error.png`, fullPage: true });
});

test('FLOW-10 an operator and an anonymous visitor are refused', async ({ page, context }) => {
  const { concertId } = await ids();
  await context.clearCookies();
  await page.goto(`/admin/concerts/${concertId}/import`);
  await expect(page).toHaveURL(/\/login/);
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-1-anonymous.png`, fullPage: true });

  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill('Wei Ling');
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/scan/login'), { timeout: 20000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.goto(`/admin/concerts/${concertId}/import`);
  expect(page.url()).not.toMatch(/\/import$/);
  await expect(page.getByText(/Spreadsheet import/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/FLOW-10-step-2-operator-refused.png`, fullPage: true });
});

test('FLOW-13 a two-player file: one party is silently skipped and Commit stays enabled', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow13.csv', [
    '2026-08-01T10:00:00Z,Alice Tan,alice@players.test,Guest A,,Allocated',
    '2026-08-01T11:00:00Z,Ben Lim,ben@players.test,Guest B,,Allocated',
    '2026-08-01T12:00:00Z,Carol Ng,carol@players.test,Guest C,,Allocated',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Player Block', file });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText(/blocking issue/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-13-step-1-two-of-three-blocked.png`, fullPage: true });
  // Every party after the first fails to match its player.
  await expect(page.getByText(/No player matches "ben@players.test"/)).toBeVisible();
  // …and Commit is still enabled, so the file imports one third of itself.
  const commit = page.getByRole('button', { name: /^Commit/ });
  await expect(commit).toBeEnabled();
  await expect(commit).toHaveText(/Commit 1 registration/);
  await page.screenshot({ path: `${SHOTS}/FLOW-13-step-2-commit-enabled.png`, fullPage: true });
});

test('FLOW-11 a dry run writes nothing but records a DRY_RUN batch', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('flow11.csv', [
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Alice Tan,,Extra',
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Ben Tan,,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: 'Public Block', file });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('2 rows → 1 registration')).toBeVisible();

  // The typed confirmation gate: a wrong name keeps the action disabled.
  await page.getByRole('button', { name: /^Commit 1 registration/ }).click();
  await page.getByLabel(/Type .* to confirm/).fill('Player Block');
  const action = page.getByRole('button', { name: /^Commit$|^Import$|^Commit / }).last();
  await expect(action).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-1-wrong-confirmation.png`, fullPage: true });
  await page.getByRole('button', { name: 'Cancel' }).click();

  const [{ regs }] = await sql<{ regs: number }[]>`select count(*)::int as regs from registrations`;
  const [{ atts }] = await sql<{ atts: number }[]>`select count(*)::int as atts from attendees`;
  const batches = await sql<{ status: string }[]>`select status from import_batches`;
  expect(regs).toBe(0);
  expect(atts).toBe(0);
  expect(batches.map((b) => b.status)).toEqual(['DRY_RUN']);
  await page.screenshot({ path: `${SHOTS}/FLOW-11-step-2-nothing-written.png`, fullPage: true });
});

test('FLOW-12 the downloaded template maps itself', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  await page.goto(`/admin/concerts/${concertId}/import`);
  await expect(page.getByRole('heading', { name: 'Prepare your sheet' })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: '.csv' }).click(),
  ]);
  const path = `${TMP}/template.csv`;
  await download.saveAs(path);
  const text = require('node:fs').readFileSync(path, 'utf8');
  expect(text.split('\n')[0].trim()).toBe(HEADERS);
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-1-template.png`, fullPage: true });

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Target segment').click();
  await page.getByRole('option', { name: /Public Block/ }).click();
  await page.setInputFiles('#file', path);
  await page.getByRole('button', { name: 'Read the file' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  // Every required target is mapped from the file's own headers.
  await expect(page.getByRole('combobox').filter({ hasText: 'Timestamp' })).toBeVisible();
  await expect(page.getByRole('combobox').filter({ hasText: 'Contact Name' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry run' })).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-2-self-mapped.png`, fullPage: true });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('4 rows → 2 registrations')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/FLOW-12-step-3-dryrun.png`, fullPage: true });
});
