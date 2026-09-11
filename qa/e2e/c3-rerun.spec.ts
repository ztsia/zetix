import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * QA re-run for `fix/import-reimport-dedup` (module C, import.md §9.2, §9.4, §9.6).
 * Flows from qa-artifacts/fix-import-reimport-dedup-rerun/02-flows.md.
 */
const SHOTS = 'qa-artifacts/fix-import-reimport-dedup-rerun/screens';
const TMP = '/tmp/claude-0/-home-user-zetix/6dc0424c-e3d4-537c-983e-0dd062ead431/scratchpad/sheets2';
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
  const [s] = await sql<{ id: number }[]>`select id from show_segments where name = 'Public Block'`;
  return { concertId: Number(c.id), publicSegmentId: Number(s.id) };
}

async function clearImports() {
  await sql`delete from email_outbox`;
  await sql`delete from attendees`;
  await sql`delete from registrations`;
  await sql`delete from import_batches`;
}

async function dbCounts() {
  const [r] = await sql<{ regs: string; seats: string }[]>`
    select (select count(*) from registrations where deleted_at is null) as regs,
           (select count(*) from attendees where deleted_at is null) as seats`;
  return { regs: Number(r.regs), seats: Number(r.seats) };
}

async function toMapping(page: Page, o: { concertId: number; segmentName: string; file: string }) {
  await page.goto(`/admin/concerts/${o.concertId}/import`);
  await expect(page.getByRole('heading', { name: 'Spreadsheet import' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Target segment').click();
  await page.getByRole('option', { name: new RegExp(o.segmentName) }).click();
  await page.setInputFiles('#file', o.file);
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function toDryRun(page: Page, o: { concertId: number; segmentName: string; file: string }) {
  await toMapping(page, o);
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText(/rows → /)).toBeVisible({ timeout: 20000 });
}

async function commit(page: Page, segmentName: string) {
  await page.getByRole('button', { name: /^Commit/ }).click();
  await expect(page.getByRole('heading', { name: 'This cannot be undone' })).toBeVisible();
  await page.getByLabel(/Type/).fill(segmentName);
  await page.getByRole('button', { name: 'Import' }).click();
}

const PUBLIC = 'Public Block';
const ROUND1 = [
  '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Alice Tan,alice@example.com,Extra',
  '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Bob Tan,bob@example.com,Extra',
  '2026-08-02T09:30:00Z,Carol Ng,carol@example.com,Carol Ng,carol@example.com,Extra',
];


const PROFILE = JSON.stringify({
  sheet: 'Sheet1',
  header_row: 1,
  columns: {
    requested_at: 'Timestamp',
    contact_name: 'Contact Name',
    contact_email: 'Contact Email',
    attendee_name: 'Attendee Name',
    attendee_email: 'Attendee Email',
    allocation_type: 'Ticket Type',
  },
  allocation_type_values: { BASE: ['Allocated'], EXTRA: ['Extra'] },
  default_allocation_type: 'EXTRA',
  player_match: null,
});

test.describe.configure({ mode: 'serial' });

/* R-FLOW-1 ─ the identical sheet, re-uploaded (AC-10, AC-11, AC-12) */
test('R-FLOW-1 an unchanged sheet re-uploaded writes nothing and says so', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('r1.csv', ROUND1);

  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await page.screenshot({ path: `${SHOTS}/R-FLOW-1-step-1-first-dry-run.png`, fullPage: true });
  await expect(page.getByText('3 rows → 2 registrations')).toBeVisible();
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });
  const after = await dbCounts();
  expect(after).toEqual({ regs: 2, seats: 3 });
  await page.screenshot({ path: `${SHOTS}/R-FLOW-1-step-2-committed.png`, fullPage: true });

  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await expect(page.getByText('2 already imported · 0 new')).toBeVisible();
  await expect(page.getByText(/Nothing new to import/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Commit/ })).toBeDisabled();
  // Every sheet row states its own outcome, not just the party's first row.
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  for (const t of await rows.allInnerTexts()) expect(t).toMatch(/Skipped/);
  await page.screenshot({ path: `${SHOTS}/R-FLOW-1-step-3-nothing-new.png`, fullPage: true });

  // The level filter counts findings; the table counts sheet rows. If they
  // disagree, a badge that says "Info 2" sits over three INFO rows.
  const infoChip = page.getByRole('button', { name: /^Info \d/ });
  const chipText = await infoChip.innerText();
  await infoChip.click();
  const filtered = await page.locator('tbody tr').count();
  // eslint-disable-next-line no-console
  console.log(`R-FLOW-1 level filter chip=${JSON.stringify(chipText)} rows shown after clicking it=${filtered}, INFO-badged rows in the unfiltered table=3`);
  await page.screenshot({ path: `${SHOTS}/R-FLOW-1-step-4-info-filter.png`, fullPage: true });
  expect(await dbCounts()).toEqual(after);
});

/* R-FLOW-2 ─ a grown party beside a genuinely new one (AC-13, AC-21) */
test('R-FLOW-2 a grown party warns and is skipped while the new party commits', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file: csv('r2a.csv', ROUND1) });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });
  const before = await dbCounts();

  const grown = csv('r2b.csv', [
    ...ROUND1,
    '2026-08-01T10:00:00Z,Alice Tan,alice@example.com,Cara Tan,cara@example.com,Extra',
    '2026-08-09T14:00:00Z,Dan Wee,dan@example.com,Dan Wee,dan@example.com,Extra',
  ]);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file: grown });
  await expect(page.getByText('2 already imported · 1 new')).toBeVisible();
  await expect(
    page.getByText(/Alice Tan was imported with 2 seats, but this file gives 3/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Commit/ })).toHaveText(/Commit 1 registrations/);
  await page.screenshot({ path: `${SHOTS}/R-FLOW-2-step-1-size-changed.png`, fullPage: true });

  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/R-FLOW-2-step-2-after-commit.png`, fullPage: true });
  expect(await dbCounts()).toEqual({ regs: before.regs + 1, seats: before.seats + 1 });
  const [alice] = await sql<{ n: string }[]>`
    select count(*) as n from attendees a join registrations r on r.id = a.registration_id
     where r.contact_email = 'alice@example.com' and a.deleted_at is null`;
  expect(Number(alice.n)).toBe(2);
});

/* R-FLOW-3 ─ a cancelled party, re-uploaded (AC-28) */
test('R-FLOW-3 a cancelled party is skipped, and the message does not say it is cancelled', async ({ page }) => {
  await clearImports();
  const { concertId } = await ids();
  await loginAdmin(page);
  const file = csv('r3.csv', ROUND1);
  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await commit(page, PUBLIC);
  await expect(page.getByText(/Imported/)).toBeVisible({ timeout: 20000 });

  await sql`update attendees set status = 'CANCELLED' where registration_id in
    (select id from registrations where contact_email = 'alice@example.com')`;
  await sql`update registrations set status = 'CANCELLED' where contact_email = 'alice@example.com'`;

  await toDryRun(page, { concertId, segmentName: PUBLIC, file });
  await expect(page.getByText('2 already imported · 0 new')).toBeVisible();
  const msg = await page.getByText(/was imported into this segment already/).first().innerText();
  // eslint-disable-next-line no-console
  console.log('R-FLOW-3 message for a CANCELLED party:', JSON.stringify(msg));
  expect(msg).toContain('Alice Tan');
  expect(msg.toLowerCase()).not.toContain('cancel');
  await page.screenshot({ path: `${SHOTS}/R-FLOW-3-step-1-cancelled-skipped.png`, fullPage: true });
  expect(await dbCounts()).toEqual({ regs: 2, seats: 3 });
});

/* R-FLOW-4 ─ the API authorization matrix and the server-side commit gate (AC-4, AC-29, AC-30) */
test('R-FLOW-4 /api/import refuses anonymous and operator, and refuses a blocking commit', async ({ page, baseURL }) => {
  await clearImports();
  const { publicSegmentId } = await ids();
  const file = csv('r4.csv', ROUND1);
  const buffer = { name: 'r4.csv', mimeType: 'text/csv', buffer: Buffer.from(readFileSync(file)) };

  const anon = await pwRequest.newContext({ baseURL });
  const r1 = await anon.post('/api/import', {
    multipart: { action: 'dry-run', segmentId: String(publicSegmentId), file: buffer, profile: PROFILE },
  });
  // eslint-disable-next-line no-console
  console.log('R-FLOW-4 anonymous:', r1.status(), (await r1.text()).slice(0, 120));
  expect(r1.status()).toBe(401);
  await anon.dispose();

  // OPERATOR, signed in through the scanner login.
  await page.goto('/scan/login');
  await page.getByLabel('Display name').fill('Wei Ling');
  await page.getByLabel('Access code').fill('qa-op-code');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith('/scan/login'), { timeout: 20000 }),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  await page.screenshot({ path: `${SHOTS}/R-FLOW-4-step-1-operator-signed-in.png`, fullPage: true });
  const r2 = await page.request.post('/api/import', {
    multipart: { action: 'dry-run', segmentId: String(publicSegmentId), file: buffer, profile: PROFILE },
  });
  console.log('R-FLOW-4 operator:', r2.status(), (await r2.text()).slice(0, 120));
  expect(r2.status()).toBe(403);
  expect(await dbCounts()).toEqual({ regs: 0, seats: 0 });

  // ADMIN: the same call is allowed.
  await page.context().clearCookies();
  await loginAdmin(page);
  const r3 = await page.request.post('/api/import', {
    multipart: { action: 'dry-run', segmentId: String(publicSegmentId), file: buffer, profile: PROFILE },
  });
  console.log('R-FLOW-4 admin dry-run:', r3.status());
  expect(r3.status()).toBe(200);

  // Hostile / malformed input at the boundary.
  const badProfile = await page.request.post('/api/import', {
    multipart: { action: 'dry-run', segmentId: String(publicSegmentId), file: buffer, profile: '{"columns":' },
  });
  console.log('R-FLOW-4 malformed profile:', badProfile.status(), (await badProfile.text()).slice(0, 160));
  expect(badProfile.status()).toBe(400);

  const bad = await page.request.post('/api/import', {
    multipart: { action: 'dry-run', segmentId: '../../etc/passwd', file: buffer, profile: PROFILE },
  });
  console.log('R-FLOW-4 path-ish segmentId:', bad.status(), (await bad.text()).slice(0, 160));
  expect(bad.status()).toBe(400);

  const noFile = await page.request.post('/api/import', {
    multipart: { action: 'dry-run', segmentId: String(publicSegmentId), profile: PROFILE },
  });
  console.log('R-FLOW-4 missing file:', noFile.status(), (await noFile.text()).slice(0, 160));
  expect(noFile.status()).toBe(400);

  const badAction = await page.request.post('/api/import', {
    multipart: { action: 'DROP TABLE registrations', segmentId: String(publicSegmentId), file: buffer, profile: PROFILE },
  });
  console.log('R-FLOW-4 bad action:', badAction.status(), (await badAction.text()).slice(0, 160));
  expect(badAction.status()).toBe(400);

  // The server refuses a commit whose file carries a blocking finding, with no
  // dry run in front of it (§9.6 step 5 — the gate must not live in the client).
  const blocking = {
    name: 'blocking.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [HEADERS, '2026-08-01T10:00:00Z,Zed Koh,zed@example.com,Zed Koh,zed@example.com,Complimentary'].join('\n'),
    ),
  };
  const forced = await page.request.post('/api/import', {
    multipart: {
      action: 'commit',
      segmentId: String(publicSegmentId),
      file: blocking,
      confirmation: PUBLIC,
      profile: PROFILE,
    },
  });
  console.log('R-FLOW-4 forced blocking commit:', forced.status(), (await forced.text()).slice(0, 200));
  expect(forced.status()).toBeGreaterThanOrEqual(400);
  expect(await dbCounts()).toEqual({ regs: 0, seats: 0 });
});
